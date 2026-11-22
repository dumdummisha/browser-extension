/// <reference types="chrome" />
import type { z } from 'zod'
import {
  type Download,
  PAGE_METHODS,
  type PageCommand,
  type PageMethod,
  PageOutcomeSchema,
  type PageResult,
  TAB_BRIDGE_METHODS,
  type TabBridgeMethod,
  type TabBridgeResult,
  type TabInfo,
} from '../protocol/tab.js'
import { NetworkLog } from '../service-worker/network-log.js'
import { runPageCommand, waitForQuietPage } from '../service-worker/page-command.js'
import { redactText, redactUrl } from '../service-worker/request-redaction.js'
import { type RawTabResult, TAB_RESULT_REDACTIONS } from '../service-worker/tab-result-redaction.js'
import {
  DOWNLOAD_POLL_INTERVAL_MS,
  LOAD_POLL_INTERVAL_MS,
  LOAD_TIMEOUT_MS,
  QUIET_PAGE_MS,
  REQUEST_POLL_INTERVAL_MS,
  SCREENSHOT_JPEG_QUALITY,
  SETTLE_TIMEOUT_MS,
} from './config.js'

// The tab commands of the service worker (protocol tab.ts), apart from its Slack transport: they share only the native
// port, and a command that fails answers its own request with an error. Each command works on the raw page and hands
// its answer to the redaction of what leaves the service worker (tab-result-redaction.ts): every URL, and every
// page-derived text by the known credential shapes, an error message included. The comparisons that tell a navigation,
// the lines a change report keeps and the lines a search matches are decided on the raw text.

type TabHandlers = {
  [TMethod in TabBridgeMethod]: (params: unknown) => Promise<TabBridgeResult<TMethod>>
}

type RawTabHandlers = {
  [TMethod in TabBridgeMethod]: (params: unknown) => Promise<RawTabResult<TMethod>>
}

type IdentifiedTab = chrome.tabs.Tab & { id: number }
type RequestBody = chrome.webRequest.OnBeforeRequestDetails['requestBody']

// The page each tab showed when its last action began, as outline lines, for changes to compare against; it is kept
// here because a navigation discards the page's own state.
interface IMarkedPage {
  readonly documentId: string
  readonly url: string
  readonly lines: string[]
}

const PAGE_REQUESTS: chrome.webRequest.RequestFilter = { urls: ['<all_urls>'], types: ['xmlhttprequest'] }

// The fetch and XHR requests each tab has in flight, by request id, with the time each started, and the time the last
// action on each tab began (its mark). A click that saves a form often changes the screen only once its request
// returns, so settle waits for the requests the action started; ones open from before (a long poll) do not count.
const pendingRequests = new Map<number, Map<string, number>>()
const actionStarts = new Map<number, number>()
const marks = new Map<number, IMarkedPage>()
const networkLog = new NetworkLog()

const decoder = new TextDecoder()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const parseWith = <TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> => schema.parse(value)

// A form body arrives parsed, any other body as raw byte chunks; a file part has no bytes and is left out.
const requestBodyText = (requestBody: RequestBody): string | null => {
  if (requestBody?.formData !== undefined) {
    const pairs = Object.entries(requestBody.formData).flatMap(([name, values]) =>
      values.map((value) => [name, typeof value === 'string' ? value : decoder.decode(value)])
    )

    return new URLSearchParams(pairs).toString()
  }

  if (requestBody?.raw === undefined) {
    return null
  }

  return requestBody.raw.map(({ bytes }) => (bytes === undefined ? '' : decoder.decode(bytes))).join('')
}

const finishRequest = ({ tabId, requestId }: { tabId: number; requestId: string }): void => {
  pendingRequests.get(tabId)?.delete(requestId)
}

// The listeners register when the service worker starts, as Chrome needs them to wake it. extraHeaders adds the ones
// the browser sets itself, such as Cookie, which the log shows redacted, so a listing tells which requests carry one.
export const startTabTracking = (): void => {
  chrome.webRequest.onBeforeRequest.addListener(
    ({ tabId, requestId, timeStamp, method, url, requestBody }) => {
      if (tabId < 0) {
        return
      }

      const requests = pendingRequests.get(tabId) ?? new Map<string, number>()
      requests.set(requestId, timeStamp)
      pendingRequests.set(tabId, requests)
      networkLog.started(tabId, requestId, { startedAt: timeStamp, method, url, body: requestBodyText(requestBody) })
    },
    PAGE_REQUESTS,
    ['requestBody']
  )
  chrome.webRequest.onBeforeSendHeaders.addListener(
    ({ tabId, requestId, requestHeaders = [] }) => {
      networkLog.sentHeaders(
        tabId,
        requestId,
        requestHeaders.map(({ name, value = '' }) => ({ name, value }))
      )
    },
    PAGE_REQUESTS,
    ['requestHeaders', 'extraHeaders']
  )
  chrome.webRequest.onCompleted.addListener((details) => {
    finishRequest(details)
    networkLog.ended(details.tabId, details.requestId, { statusCode: details.statusCode })
  }, PAGE_REQUESTS)
  chrome.webRequest.onErrorOccurred.addListener((details) => {
    finishRequest(details)
    networkLog.ended(details.tabId, details.requestId, { error: details.error })
  }, PAGE_REQUESTS)
  chrome.tabs.onRemoved.addListener((tabId) => {
    pendingRequests.delete(tabId)
    networkLog.forget(tabId)
    actionStarts.delete(tabId)
    marks.delete(tabId)
  })
}

const resolveTab = async (tabId: number | undefined): Promise<IdentifiedTab> => {
  const [tab] =
    tabId === undefined
      ? await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      : [await chrome.tabs.get(tabId)]
  if (tab?.id === undefined) {
    throw new Error('No browser tab is active. Pass a tabId from tab_list.')
  }

  return { ...tab, id: tab.id }
}

const windowBounds = async (windowId: number): Promise<TabInfo['windowBounds']> => {
  const { left, top, width, height } = await chrome.windows.get(windowId)
  if (left === undefined || top === undefined || width === undefined || height === undefined) {
    throw new Error(`Window ${windowId} reports no position on screen; it may be minimized.`)
  }

  return { left, top, width, height }
}

const tabInfo = async (tab: IdentifiedTab): Promise<TabInfo> => ({
  tabId: tab.id,
  windowId: tab.windowId,
  title: tab.title ?? '',
  url: tab.url ?? tab.pendingUrl ?? '',
  status: tab.status ?? 'unknown',
  zoom: await chrome.tabs.getZoom(tab.id),
  windowBounds: await windowBounds(tab.windowId),
})

// Returns the tab as it is at the deadline when it is still loading; a slow page is not an error.
const waitForLoad = async (tabId: number): Promise<void> => {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  let tab = await resolveTab(tabId)
  while (tab.status === 'loading' && Date.now() < deadline) {
    await sleep(LOAD_POLL_INTERVAL_MS)
    tab = await resolveTab(tabId)
  }
}

const hasRequestsSince = (tabId: number, since: number): boolean =>
  [...(pendingRequests.get(tabId)?.values() ?? [])].some((startedAt) => startedAt >= since)

// The page loads, if it navigated, then the requests started since `since` finish and the page stops changing; a
// request that answers can change the page and start another, so the two waits repeat until both hold.
const settleTab = async (tabId: number, since: number): Promise<TabInfo> => {
  await waitForLoad(tabId)
  const deadline = Date.now() + SETTLE_TIMEOUT_MS

  do {
    while (hasRequestsSince(tabId, since) && Date.now() < deadline) {
      await sleep(REQUEST_POLL_INTERVAL_MS)
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: waitForQuietPage,
      args: [QUIET_PAGE_MS, Math.max(deadline - Date.now(), 0)],
    })
  } while (hasRequestsSince(tabId, since) && Date.now() < deadline)

  return tabInfo(await resolveTab(tabId))
}

// Runs the command in the tab's page, in the extension's isolated world, and checks what it answered.
const runInPage = async <TMethod extends PageMethod>(
  tabId: number | undefined,
  method: TMethod,
  command: Extract<PageCommand, { method: TMethod }>
): Promise<{ tab: IdentifiedTab; result: PageResult<TMethod> }> => {
  const tab = await resolveTab(tabId)
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: runPageCommand,
    args: [command],
  })
  if (injection?.result === undefined) {
    throw new Error(`The page in tab ${tab.id} returned nothing.`)
  }

  const outcome = PageOutcomeSchema.parse(injection.result)
  if (!outcome.isOk) {
    throw new Error(outcome.error)
  }

  return { tab, result: parseWith(PAGE_METHODS[method].result, outcome.value) }
}

const actionStart = (tabId: number): number => {
  const since = actionStarts.get(tabId)
  if (since === undefined) {
    throw new Error(`Tab ${tabId} has no marked action; mark it before acting.`)
  }

  return since
}

// Focus moves with nearly every action, so it is left out of the comparison; a read still shows it.
const comparable = (line: string): string => line.replace(/ focused$/u, '')

// Refs differ between documents, so a line the previous page had too is recognized by what it says.
const withoutRef = (line: string): string => comparable(line).replace(/\[\d+\] /u, '')

const pageOutline = async (tabId: number, maxChars: number): Promise<IMarkedPage> => {
  const { result } = await runInPage(tabId, 'snapshot', { method: 'snapshot', params: { scope: 'page', maxChars } })

  return { documentId: result.documentId, url: result.url, lines: result.outline.split('\n').map(comparable) }
}

// A site repeats its header above every page and its footer below, so the lines a new screen starts and ends with
// that the previous page had too are left out; the same lines in between are content and stay. Answers the range of
// the lines that stay.
const freshRange = (lines: string[], previous: IMarkedPage): { freshStart: number; freshEnd: number } => {
  const known = new Set(previous.lines.map(withoutRef))
  const isKnown = (line: string): boolean => known.has(withoutRef(line))
  const start = lines.findIndex((line) => !isKnown(line))
  if (start === -1) {
    return { freshStart: 0, freshEnd: 0 }
  }

  return { freshStart: start, freshEnd: lines.findLastIndex((line) => !isKnown(line)) + 1 }
}

// A download in progress without a filename waits for the user to choose where to save it.
const downloadState = ({ state, filename }: chrome.downloads.DownloadItem): Download['state'] => {
  if (state !== 'in_progress') {
    return state
  }

  return filename === '' ? 'choosingLocation' : 'receiving'
}

const actionDownloads = async (since: number): Promise<Download[]> =>
  (await chrome.downloads.search({ startedAfter: new Date(since).toISOString() })).map((item) => ({
    url: item.url,
    filename: item.filename,
    state: downloadState(item),
    bytesReceived: item.bytesReceived,
    error: item.error ?? null,
  }))

const tabParams = <TMethod extends TabBridgeMethod>(
  method: TMethod,
  raw: unknown
): z.output<(typeof TAB_BRIDGE_METHODS)[TMethod]['params']> => parseWith(TAB_BRIDGE_METHODS[method].params, raw)

const RAW_TAB_HANDLERS: RawTabHandlers = {
  listTabs: async () => {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })

    // Only session-restored windows and tabs lack an id; getAll returns live ones.
    return windows.flatMap(({ id: windowId, focused: isFocused, tabs = [] }) =>
      windowId === undefined
        ? []
        : [
            {
              windowId,
              isFocused,
              tabs: tabs.flatMap(({ id: tabId, title = '', url = '', active: isActive }) =>
                tabId === undefined ? [] : [{ tabId, title, url, isActive }]
              ),
            },
          ]
    )
  },
  focusTab: async (raw) => {
    const tab = await resolveTab(tabParams('focusTab', raw).tabId)
    await chrome.windows.update(tab.windowId, { focused: true })
    await chrome.tabs.update(tab.id, { active: true })

    return tabInfo(tab)
  },
  // An app renders after its document loads, so the tab settles as after an action.
  openTab: async (raw) => {
    const { url, isNewTab } = tabParams('openTab', raw)
    const openedAt = Date.now()
    const opened = isNewTab
      ? await chrome.tabs.create({ url, active: true })
      : await chrome.tabs.update((await resolveTab(undefined)).id, { url })
    if (opened?.id === undefined) {
      throw new Error(`The browser did not open ${redactUrl(url)}.`)
    }

    await chrome.windows.update(opened.windowId, { focused: true })

    return settleTab(opened.id, openedAt)
  },
  closeTab: async (raw) => {
    const { tabId } = tabParams('closeTab', raw)
    await chrome.tabs.remove(tabId)

    return { tabId }
  },
  mark: async (raw) => {
    const { tabId, maxChars } = tabParams('mark', raw)
    const markedAt = Date.now()
    const page = await pageOutline(tabId, maxChars)
    marks.set(tabId, page)
    actionStarts.set(tabId, markedAt)

    return { lineCount: page.lines.length }
  },
  // After a click or key press, so the menu a click opened, the view an in-page navigation rendered or the dialog a
  // saved form raised is there for the next read.
  settle: (raw) => {
    const { tabId } = tabParams('settle', raw)

    return settleTab(tabId, actionStart(tabId))
  },
  changes: async (raw) => {
    const { tabId, maxChars, viewportMaxChars } = tabParams('changes', raw)
    const before = marks.get(tabId)
    if (before === undefined) {
      throw new Error(`Tab ${tabId} has no marked page to compare against; mark it before acting.`)
    }

    const after = await pageOutline(tabId, maxChars)
    if (after.documentId === before.documentId && after.url === before.url) {
      const beforeLines = new Set(before.lines)
      const afterLines = new Set(after.lines)
      const placesOf = (lines: string[], isKept: (line: string) => boolean): number[] =>
        lines.flatMap((line, index) => (isKept(line) ? [index] : []))

      return {
        isNavigated: false,
        before: before.lines,
        after: after.lines,
        added: placesOf(after.lines, (line) => !beforeLines.has(line)),
        removed: placesOf(before.lines, (line) => !afterLines.has(line)),
      }
    }

    const { result: snapshot } = await runInPage(tabId, 'snapshot', {
      method: 'snapshot',
      params: { scope: 'viewport', maxChars: viewportMaxChars },
    })

    return { isNavigated: true, snapshot, ...freshRange(snapshot.outline.split('\n'), before) }
  },
  downloads: async (raw) => {
    const { tabId, timeoutMs } = tabParams('downloads', raw)
    const since = actionStart(tabId)
    const deadline = Date.now() + timeoutMs
    let downloads = await actionDownloads(since)
    while (downloads.some(({ state }) => state === 'receiving') && Date.now() < deadline) {
      await sleep(DOWNLOAD_POLL_INTERVAL_MS)
      downloads = await actionDownloads(since)
    }

    return downloads
  },
  screenshot: async (raw) => {
    const tab = await resolveTab(tabParams('screenshot', raw).tabId)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: SCREENSHOT_JPEG_QUALITY,
    })

    return { dataUrl }
  },
  network: async (raw) => {
    const tab = await resolveTab(tabParams('network', raw).tabId)

    return { tabId: tab.id, requests: networkLog.requests(tab.id) }
  },
  snapshot: async (raw) => {
    const { tabId, ...params } = tabParams('snapshot', raw)
    const { tab, result } = await runInPage(tabId, 'snapshot', { method: 'snapshot', params })

    return { ...result, tabId: tab.id }
  },
  find: async (raw) => {
    const { tabId, ...params } = tabParams('find', raw)

    return (await runInPage(tabId, 'find', { method: 'find', params })).result
  },
  locate: async (raw) => {
    const { tabId, ...params } = tabParams('locate', raw)

    return (await runInPage(tabId, 'locate', { method: 'locate', params })).result
  },
  pointer: async (raw) => {
    const { tabId, ...params } = tabParams('pointer', raw)

    return (await runInPage(tabId, 'pointer', { method: 'pointer', params })).result
  },
  field: async (raw) => {
    const { tabId, ...params } = tabParams('field', raw)

    return (await runInPage(tabId, 'field', { method: 'field', params })).result
  },
  selectOption: async (raw) => {
    const { tabId, ...params } = tabParams('selectOption', raw)

    return (await runInPage(tabId, 'selectOption', { method: 'selectOption', params })).result
  },
  selectContent: async (raw) => {
    const { tabId, ...params } = tabParams('selectContent', raw)

    return (await runInPage(tabId, 'selectContent', { method: 'selectContent', params })).result
  },
  hasFocus: async (raw) => {
    const { tabId } = tabParams('hasFocus', raw)

    return (await runInPage(tabId, 'hasFocus', { method: 'hasFocus', params: {} })).result
  },
}

// A command's answer leaves through its redaction; so does the message of one that fails, which can quote the page
// (the element that covers a target, a select's options).
const answering =
  <TMethod extends TabBridgeMethod>(method: TMethod) =>
  async (params: unknown): Promise<TabBridgeResult<TMethod>> => {
    try {
      return TAB_RESULT_REDACTIONS[method](await RAW_TAB_HANDLERS[method](params))
    } catch (error) {
      throw new Error(redactText(error instanceof Error ? error.message : String(error)))
    }
  }

export const TAB_HANDLERS: TabHandlers = {
  listTabs: answering('listTabs'),
  focusTab: answering('focusTab'),
  openTab: answering('openTab'),
  closeTab: answering('closeTab'),
  mark: answering('mark'),
  settle: answering('settle'),
  changes: answering('changes'),
  downloads: answering('downloads'),
  screenshot: answering('screenshot'),
  network: answering('network'),
  snapshot: answering('snapshot'),
  find: answering('find'),
  locate: answering('locate'),
  pointer: answering('pointer'),
  field: answering('field'),
  selectOption: answering('selectOption'),
  selectContent: answering('selectContent'),
  hasFocus: answering('hasFocus'),
}
