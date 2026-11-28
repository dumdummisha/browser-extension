import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import type { BridgeEvent } from '../protocol/events.js'
import { slackEventKey } from '../protocol/slack.js'
import { whatsappEventKey } from '../protocol/whatsapp.js'
import { openPendingQueue, PendingQueueWriter } from './pending-queue-writer.js'
import { chromeEvent, emit, fakeWebRequest, HOST_HELLO, type IChromeEvent, settled } from './testing.js'

// The service worker's WhatsApp intake and its record of WhatsApp tabs (extension/background.ts, whatsapp-tabs.ts),
// driven through Chrome's events as Chrome drives them: the build's bundle of background.ts runs in a fake Chrome whose
// WhatsApp tabs hold documents, each with a relay that answers the state request as the test sets it, and that posts a
// report when asked unpinned, or whenever the test delivers one, late reports of dead documents included. A request
// pinned to a document that is gone is rejected, and one to a document the test holds never settles, as the facts in
// design U2 amendment 3 section C allow. The status the worker sends its listener is what the tests read. Each test
// starts a worker of its own, a fresh copy of the bundle. The spec lives here, beside the modules the tests load, since
// the build replaces the compiled extension folder with its bundles.

// What the service worker sends a WhatsApp relay, the relay's bundle and the Slack relay's queries (config.ts, which the
// build leaves out of the compiled extension).
const WHATSAPP_ORIGIN = 'https://web.whatsapp.com'
const WHATSAPP_TAB_URL = `${WHATSAPP_ORIGIN}/*`
const WHATSAPP_STATE_REQUEST = 'misha-whatsapp-state-request'
const WHATSAPP_REPORT_REQUEST = 'misha-whatsapp-report-request'
const WHATSAPP_RELAY_SCRIPT = 'whatsapp-relay.js'
const SLACK_ORIGIN = 'https://app.slack.com'
const SLACK_TAB_URL = `${SLACK_ORIGIN}/*`
const CLIENT_QUERY = 'misha-client-query'
const CAPTURE_QUERY = 'misha-capture-query'
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
const NOW = 1_794_900_000_000
const DEADLINE = NOW + 60_000

const LEO_NOVAK = { wid: '100000000000001@lid' }
const SLACK_ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const TOKEN_1 = '00000000-0000-4000-8000-000000000001'
const TOKEN_2 = '00000000-0000-4000-8000-000000000002'
const NOT_SHOWN = { state: 'not-shown' }

const MESSAGE = {
  chat: '100000000000002@lid',
  id: '3EB0A1B2C3D4E5F60718',
  timestamp: 1_700_000_000,
  fromMe: false,
  type: 'chat',
  text: 'Lunch at noon?',
} as const

const WHATSAPP_EVENT = {
  type: 'event',
  id: whatsappEventKey(LEO_NOVAK, MESSAGE),
  account: LEO_NOVAK,
  message: MESSAGE,
} as const

const SLACK_FRAME = {
  type: 'message',
  channel: 'D0EXAMPLE1',
  ts: '1794900000.000100',
  text: 'a made-up message',
} as const

const SLACK_EVENT: BridgeEvent = {
  type: 'event',
  id: slackEventKey(SLACK_ACCOUNT, SLACK_FRAME),
  account: SLACK_ACCOUNT,
  frame: SLACK_FRAME,
}

// A document of a WhatsApp tab and its relay: what the relay answers the state request (null for no relay of this load
// of the extension), whether the document is prerendering or past pagehide, whether the test holds every request to it
// so it never settles, and the frame id Chrome gives its messages.
interface IFakeDocument {
  readonly id: string
  answer: object | null
  isPrerendering: boolean
  isHidden: boolean
  isHeld: boolean
  frameId: number
}

// A WhatsApp tab: its committed URL, the document it shows (null once its renderer crashed or it was discarded), every
// document of it that can still answer (the shown one, and one being prerendered), and how an injection of a new relay
// goes: an injected relay that greets reports on its own.
interface IFakeTab {
  readonly id: number
  url: string
  discarded: boolean
  shown: IFakeDocument | null
  live: IFakeDocument[]
  injectRelay: (tab: IFakeTab) => Promise<void>
}

// What the worker under test sent and was sent: its native port's frames, the unpinned report requests and the pinned
// state requests it sent each tab, and the relay injections it made.
interface IFakeBrowser {
  slackTabs: number[]
  tabs: IFakeTab[]
  posted: unknown[]
  reportRequests: number[]
  stateRequests: { readonly tabId: number; readonly documentId: string }[]
  injections: { readonly tabId: number; readonly documentId: string; readonly files: readonly string[] }[]
  portMessages: IChromeEvent
  runtimeMessages: IChromeEvent
  tabEvents: { readonly onRemoved: IChromeEvent; readonly onUpdated: IChromeEvent; readonly onReplaced: IChromeEvent }
  // The state requests to held documents, in order: release delivers the answer the document's relay gives then.
  heldStates: { readonly tabId: number; readonly documentId: string; readonly release: () => void }[]
}

type MessageListener = (message: unknown, sender: object, respond: () => void) => unknown

let workers = 0

const observed = (token: string, isConnected = true): object => ({
  state: 'observed',
  token,
  capture: { state: 'ready', account: LEO_NOVAK, isConnected, hasSynced: true },
})

const readyStatus = (tabId: number, isConnected = true): object => ({
  tabId,
  state: 'ready',
  account: LEO_NOVAK,
  isConnected,
  hasSynced: true,
})

const fakeDocument = (id: string, answer: object | null): IFakeDocument => ({
  id,
  answer,
  isPrerendering: false,
  isHidden: false,
  isHeld: false,
  frameId: 0,
})

// A WhatsApp tab showing one document, whose relay answers answer.
const whatsappTab = (id: number, document: IFakeDocument): IFakeTab => ({
  id,
  url: `${WHATSAPP_ORIGIN}/`,
  discarded: false,
  shown: document,
  live: [document],
  injectRelay: () => Promise.resolve(),
})

const senderOf = (tab: IFakeTab, document: IFakeDocument, origin = WHATSAPP_ORIGIN): object => ({
  tab: { id: tab.id, url: tab.url },
  documentId: document.id,
  origin,
  frameId: document.frameId,
})

// Delivers a message from the document's relay to the worker, as chrome.runtime.sendMessage does, and answers whether
// the worker kept the response open and when it responded.
const fromRelay = (
  browser: IFakeBrowser,
  sender: object,
  message: unknown
): { readonly isKept: boolean; readonly responded: Promise<void> } => {
  const responded = Promise.withResolvers<undefined>()
  const [listener] = browser.runtimeMessages.listeners as MessageListener[]
  assert.ok(listener !== undefined, 'the worker listens for its relays')
  const isKept = listener(message, sender, () => responded.resolve(undefined)) === true

  return { isKept, responded: responded.promise }
}

// A report of the document's relay, delivered whenever the test calls it: a late report of a document that is gone too.
const report = (browser: IFakeBrowser, tab: IFakeTab, document: IFakeDocument): void => {
  fromRelay(browser, senderOf(tab, document), { kind: 'whatsapp-report' })
}

const tabOf = (browser: IFakeBrowser, tabId: number): IFakeTab | undefined =>
  browser.tabs.find(({ id }) => id === tabId)

// The unpinned report request: the relay of the shown document reports while its page is shown.
const askedToReport = (browser: IFakeBrowser, tab: IFakeTab): Promise<unknown> => {
  browser.reportRequests.push(tab.id)
  const { shown } = tab
  if (shown?.answer === null || shown === null) {
    return Promise.reject(new Error(NO_RECEIVER))
  }

  if (!shown.isPrerendering && !shown.isHidden) {
    queueMicrotask(() => report(browser, tab, shown))
  }

  return Promise.resolve(undefined)
}

// A request to a tab that is gone: Chrome rejects it, and a pinned state request is recorded as sent all the same.
const askedInGoneTab = (
  browser: IFakeBrowser,
  tabId: number,
  message: unknown,
  options: { readonly documentId?: string } | undefined
): Promise<unknown> => {
  if (message === WHATSAPP_STATE_REQUEST && options?.documentId !== undefined) {
    browser.stateRequests.push({ tabId, documentId: options.documentId })
  }

  return Promise.reject(new Error(`No tab with id: ${tabId}`))
}

// What the document's relay answers the state request now.
const stateOf = (document: IFakeDocument): unknown =>
  document.isPrerendering || document.isHidden ? NOT_SHOWN : document.answer

// The pinned state request: only that document's relay answers it, at once unless the test holds the document, in which
// case it answers only when the test releases it, if ever.
const askedForState = (browser: IFakeBrowser, tab: IFakeTab, documentId: string): Promise<unknown> => {
  browser.stateRequests.push({ tabId: tab.id, documentId })
  const document = tab.live.find(({ id }) => id === documentId)
  if (document?.answer === null || document === undefined) {
    return Promise.reject(new Error(NO_RECEIVER))
  }

  if (document.isHeld) {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    browser.heldStates.push({ tabId: tab.id, documentId, release: () => resolve(stateOf(document)) })

    return promise
  }

  return Promise.resolve(stateOf(document))
}

// A request pinned to a document goes to that document only: one that is gone, or holds no relay, has no receiver. The
// unpinned report request reaches the relay of the document the tab shows, which reports while it is shown.
const sendMessage =
  (browser: IFakeBrowser) =>
  (tabId: number, message: unknown, options?: { readonly documentId?: string }): Promise<unknown> => {
    if (browser.slackTabs.includes(tabId)) {
      assert.ok(message === CLIENT_QUERY || message === CAPTURE_QUERY, 'a Slack tab is asked only for Slack queries')

      return Promise.resolve(message === CLIENT_QUERY ? { queries: null } : { isSocketOpen: true, error: null })
    }

    const tab = tabOf(browser, tabId)
    if (tab === undefined) {
      return askedInGoneTab(browser, tabId, message, options)
    }

    if (options?.documentId === undefined) {
      assert.equal(message, WHATSAPP_REPORT_REQUEST)
      return askedToReport(browser, tab)
    }

    assert.equal(message, WHATSAPP_STATE_REQUEST)

    return askedForState(browser, tab, options.documentId)
  }

// What a Slack tab answers the relay probe (its relay of this load runs) and the identity read.
const slackScriptResult = (world: string | undefined): object =>
  world === 'ISOLATED'
    ? { origin: SLACK_ORIGIN, hasRelay: true }
    : { kind: 'identity', identity: { ...SLACK_ACCOUNT, teamName: 'Example Workspace' } }

// The document a relay injection goes into: the one its target names, and only while the tab shows it. Chrome injects
// into that document or rejects the injection (design U2 amendment 3 C17), and the worker always names the probed one
// (relay-attachment.ts).
const injectedDocument = (tabId: number, documentIds: readonly string[] | undefined, shown: IFakeDocument): string => {
  if (documentIds?.length !== 1 || documentIds[0] !== shown.id) {
    throw new Error(`No document ${String(documentIds)} to script in tab ${tabId}`)
  }

  return shown.id
}

// The relay probe answers the shown document's origin and whether a relay of this load runs there; an injected relay
// goes into the document its target names (injectedDocument). A Slack tab's page is signed in as the Slack account.
const executeScript =
  (browser: IFakeBrowser) =>
  async (injection: {
    readonly target: { readonly tabId: number; readonly documentIds?: readonly string[] }
    readonly world?: string
    readonly files?: readonly string[]
  }): Promise<unknown[]> => {
    const { tabId } = injection.target
    if (browser.slackTabs.includes(tabId)) {
      return [{ documentId: `SLACK-${tabId}`, frameId: 0, result: slackScriptResult(injection.world) }]
    }

    const tab = tabOf(browser, tabId)
    const shown = tab?.shown
    if (tab === undefined || shown === null || shown === undefined) {
      throw new Error(`No document to script in tab ${tabId}`)
    }

    if (injection.files !== undefined) {
      const documentId = injectedDocument(tabId, injection.target.documentIds, shown)
      browser.injections.push({ tabId, documentId, files: injection.files })
      await tab.injectRelay(tab)

      // A relay reports on its own once it attached, while its page is shown (whatsapp-relay.ts).
      if (shown.answer !== null && !shown.isPrerendering && !shown.isHidden) {
        queueMicrotask(() => report(browser, tab, shown))
      }

      return [{ documentId: shown.id, frameId: 0 }]
    }

    return [
      {
        documentId: shown.id,
        frameId: 0,
        result: { origin: new URL(tab.url).origin, hasRelay: shown.answer !== null },
      },
    ]
  }

const fakeChrome = (browser: IFakeBrowser): object => ({
  runtime: {
    connectNative: () => ({
      onMessage: browser.portMessages,
      onDisconnect: chromeEvent(),
      postMessage: (frame: unknown) => browser.posted.push(frame),
    }),
    onMessage: browser.runtimeMessages,
    getManifest: () => ({ name: 'Misha Browser', version: '1.2.3' }),
  },
  action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
  tabs: {
    query: ({ url }: { readonly url?: string }) => {
      if (url === SLACK_TAB_URL) {
        return Promise.resolve(browser.slackTabs.map((id) => ({ id, url: `${SLACK_ORIGIN}/client/T0EXAMPLE1` })))
      }

      assert.equal(url, WHATSAPP_TAB_URL)

      return Promise.resolve(
        browser.tabs
          .filter((tab) => tab.url.startsWith(`${WHATSAPP_ORIGIN}/`))
          .map(({ id, url: tabUrl, discarded }) => ({ id, url: tabUrl, discarded }))
      )
    },
    sendMessage: sendMessage(browser),
    ...browser.tabEvents,
  },
  scripting: { executeScript: executeScript(browser) },
  webRequest: fakeWebRequest(),
  alarms: { create: () => Promise.resolve(), onAlarm: chromeEvent() },
})

const until = async (condition: () => boolean): Promise<void> => {
  for (let step = 0; step < 50 && !condition(); step += 1) {
    await settled()
  }

  assert.ok(condition(), 'The service worker never got there')
}

const statusFrames = (browser: IFakeBrowser): Record<string, unknown>[] =>
  browser.posted.filter(
    (frame): frame is Record<string, unknown> =>
      typeof frame === 'object' && frame !== null && Reflect.get(frame, 'type') === 'status'
  )

// The WhatsApp part of a status the worker sends its listener now: the listener attaching again makes it send one.
const whatsappNow = async (browser: IFakeBrowser): Promise<unknown> => {
  await settled()
  const before = statusFrames(browser).length
  emit(browser.portMessages, { type: 'listener' })
  await until(() => statusFrames(browser).length > before)

  return statusFrames(browser).at(-1)?.whatsapp
}

// Starts a worker of its own for the test on these tabs, with the clock at NOW and an empty pending queue (or one
// holding queued), its native port ready and a listener attached, unless isListening is false: a worker with no listener
// takes no status snapshot.
const startWorker = async (
  context: TestContext,
  tabs: IFakeTab[],
  {
    slackTabs = [],
    queued = [],
    isListening = true,
  }: { readonly slackTabs?: number[]; readonly queued?: readonly BridgeEvent[]; readonly isListening?: boolean } = {}
): Promise<IFakeBrowser> => {
  const factory = new IDBFactory()

  const seeding = new PendingQueueWriter(() => openPendingQueue(factory), {
    onRestored: () => undefined,
    onHealthChange: () => undefined,
  })

  await seeding.recover()

  for (const event of queued) {
    await seeding.admit(event)
  }

  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })

  const browser: IFakeBrowser = {
    slackTabs,
    tabs,
    posted: [],
    reportRequests: [],
    stateRequests: [],
    injections: [],
    portMessages: chromeEvent(),
    runtimeMessages: chromeEvent(),
    tabEvents: { onRemoved: chromeEvent(), onUpdated: chromeEvent(), onReplaced: chromeEvent() },
    heldStates: [],
  }

  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true })
  Object.defineProperty(globalThis, 'chrome', { value: fakeChrome(browser), configurable: true })
  workers += 1
  await import(`../extension/background.js?whatsapp=${workers}`)

  emit(browser.portMessages, HOST_HELLO)

  if (isListening) {
    emit(browser.portMessages, { type: 'listener' })
  }

  await settled()

  return browser
}

// A tab event as Chrome delivers it, with the tab as it is now.
const updated = (browser: IFakeBrowser, tab: IFakeTab, change: object): void => {
  emit(browser.tabEvents.onUpdated, tab.id, change, { id: tab.id, url: tab.url, discarded: tab.discarded })
}

// The tab loads a new document, whose relay greets with token: the old document is gone. Its page is not connected yet,
// so the status tells it from the old one.
const reload = (tab: IFakeTab, id: string, token: string): IFakeDocument => {
  const next = fakeDocument(id, observed(token, false))
  tab.shown = next
  tab.live = [next]

  return next
}

// Sends a request on the native port, as the relay does, and answers the reply the service worker sends back.
const ask = async (browser: IFakeBrowser, id: number, method: string, params: unknown): Promise<unknown> => {
  emit(browser.portMessages, { type: 'request', id, method, params, deadline: DEADLINE })

  const isReply = (frame: unknown): boolean =>
    typeof frame === 'object' &&
    frame !== null &&
    Reflect.get(frame, 'type') === 'reply' &&
    Reflect.get(frame, 'id') === id

  await until(() => browser.posted.some(isReply))

  return browser.posted.find(isReply)
}

const SLACK_CALL = { account: SLACK_ACCOUNT, method: 'conversations.history', params: { channel: 'D0EXAMPLE1' } }

describe('[extension] WhatsApp dispatch - intake', () => {
  it('should admit a message from the top frame of web.whatsapp.com and forward it to the listener once stored', async (context) => {
    // Arrange
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])

    // Act
    const { isKept, responded } = fromRelay(browser, senderOf(tab, document), {
      kind: 'whatsapp-message',
      account: LEO_NOVAK,
      message: MESSAGE,
    })

    await responded

    // Assert
    assert.equal(isKept, true)
    assert.deepEqual(browser.posted.at(-1), WHATSAPP_EVENT)
  })

  it('should refuse a message from another origin', async (context) => {
    // Arrange
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    const postedBefore = browser.posted.length

    // Act + Assert
    assert.throws(
      () =>
        fromRelay(browser, senderOf(tab, document, 'https://example.com'), {
          kind: 'whatsapp-message',
          account: LEO_NOVAK,
          message: MESSAGE,
        }),
      { message: "A message came from outside a Slack or WhatsApp tab's relay (https://example.com)" }
    )

    await settled()
    assert.equal(browser.posted.length, postedBefore)
  })

  it('should refuse a message from web.whatsapp.com whose sender names no document, asking nothing and admitting nothing', async (context) => {
    // Arrange - tab 41 is recorded from DOC-1
    const tab = whatsappTab(41, fakeDocument('DOC-1', observed(TOKEN_1)))
    const browser = await startWorker(context, [tab])
    await until(() => browser.stateRequests.length === 1)
    await settled()
    const postedBefore = browser.posted.length
    const responses: number[] = []
    const [listener] = browser.runtimeMessages.listeners as MessageListener[]
    assert.ok(listener !== undefined, 'the worker listens for its relays')
    const sender = { tab: { id: tab.id, url: tab.url }, origin: WHATSAPP_ORIGIN, frameId: 0 }

    // Act + Assert
    assert.throws(
      () =>
        listener({ kind: 'whatsapp-message', account: LEO_NOVAK, message: MESSAGE }, sender, () =>
          responses.push(responses.length)
        ),
      { message: "A message came from outside a Slack or WhatsApp tab's relay (https://web.whatsapp.com)" }
    )

    await settled()
    assert.equal(browser.stateRequests.length, 1)
    assert.equal(browser.posted.length, postedBefore)
    assert.deepEqual(responses, [])
  })

  it('should admit a message from a document that is not the recorded one, and ask that document, while its answer is held and when it answers not-shown', async (context) => {
    for (const answer of ['held', 'not-shown'] as const) {
      await context.test(`the prerendered document's answer is ${answer}`, async (variant) => {
        // Arrange - tab 41 is recorded from DOC-1, and DOC-2 is prerendered for it
        const current = fakeDocument('DOC-1', observed(TOKEN_1))
        const tab = whatsappTab(41, current)
        const browser = await startWorker(variant, [tab])
        await until(() => browser.stateRequests.length === 1)
        await settled()
        const prerendered = fakeDocument('DOC-2', observed(TOKEN_2))
        prerendered.isPrerendering = true
        prerendered.isHeld = answer === 'held'
        tab.live = [current, prerendered]

        // Act
        const { isKept, responded } = fromRelay(browser, senderOf(tab, prerendered), {
          kind: 'whatsapp-message',
          account: LEO_NOVAK,
          message: MESSAGE,
        })

        await responded

        // Assert
        assert.equal(isKept, true)

        assert.deepEqual(
          browser.posted.filter((frame) => Reflect.get(frame as object, 'type') === 'event'),
          [WHATSAPP_EVENT]
        )

        assert.deepEqual(browser.stateRequests, [
          { tabId: 41, documentId: 'DOC-1' },
          { tabId: 41, documentId: 'DOC-2' },
        ])

        assert.equal(browser.heldStates.length, answer === 'held' ? 1 : 0)
      })
    }
  })

  it('should admit a WhatsApp message under the account its observer read, without asking the tab', async (context) => {
    // Arrange - the recorded document's observer answered signed-out; the message came while it read Leo Novak
    const document = fakeDocument('DOC-1', { state: 'observed', token: TOKEN_1, capture: { state: 'signed-out' } })
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    await until(() => browser.stateRequests.length === 1)
    await settled()

    // Act
    const { responded } = fromRelay(browser, senderOf(tab, document), {
      kind: 'whatsapp-message',
      account: LEO_NOVAK,
      message: MESSAGE,
    })

    await responded

    // Assert
    assert.deepEqual(browser.posted.at(-1), WHATSAPP_EVENT)
    assert.equal(browser.stateRequests.length, 1)
  })

  it('should give a WhatsApp tab its relay again after an extension reload', async (context) => {
    // Arrange - the tab's document has no relay of this load; the injected one greets and answers
    const document = fakeDocument('DOC-1', null)
    const tab = whatsappTab(41, document)

    tab.injectRelay = () => {
      document.answer = observed(TOKEN_1)

      return Promise.resolve()
    }

    // Act
    const browser = await startWorker(context, [tab])

    // Assert
    assert.deepEqual(browser.injections, [{ tabId: 41, documentId: 'DOC-1', files: [WHATSAPP_RELAY_SCRIPT] }])
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41)])
  })

  it('should list a WhatsApp tab in the status only once its relay reported, and drop it once the tab closed or left web.whatsapp.com', async (context) => {
    // Arrange
    const first = whatsappTab(41, fakeDocument('DOC-1', observed(TOKEN_1)))
    const second = whatsappTab(42, fakeDocument('DOC-2', observed(TOKEN_2)))
    const browser = await startWorker(context, [first, second])
    const listed = await whatsappNow(browser)

    // Act - tab 41 closes; tab 42 navigates to another site, whose page has no WhatsApp relay
    browser.tabs = [second]
    emit(browser.tabEvents.onRemoved, 41)
    second.url = 'https://example.com/'
    second.shown = fakeDocument('DOC-3', null)
    second.live = [second.shown]
    updated(browser, second, { url: second.url })

    // Assert
    assert.deepEqual(listed, [readyStatus(41), readyStatus(42)])
    assert.deepEqual(await whatsappNow(browser), [])
  })

  it("should ask every WhatsApp tab's relay to report when the worker starts, and send the status without waiting for it", async (context) => {
    // Arrange - tab 41's document holds every request, and tab 42 is discarded
    const held = fakeDocument('DOC-1', observed(TOKEN_1))
    held.isHeld = true
    const discarded = whatsappTab(42, fakeDocument('DOC-2', observed(TOKEN_2)))
    discarded.discarded = true

    // Act
    const browser = await startWorker(context, [whatsappTab(41, held), discarded])
    await until(() => statusFrames(browser).length > 0)

    // Assert
    assert.deepEqual(browser.reportRequests, [41])
    assert.deepEqual(statusFrames(browser)[0]?.whatsapp, [])
  })

  it("should answer a Slack call while a WhatsApp tab's relay injection never settles", async (context) => {
    // Arrange
    const tab = whatsappTab(41, fakeDocument('DOC-1', null))
    tab.injectRelay = () => new Promise(() => undefined)
    const browser = await startWorker(context, [tab], { slackTabs: [7] })

    // Act
    const reply = await ask(browser, 1, 'slackCall', SLACK_CALL)

    // Assert
    assert.equal(typeof Reflect.get(reply as object, 'error'), 'string')
    assert.equal(browser.injections.length, 1)
  })

  it('should send a new listener its status and the pending Slack events while a WhatsApp tab never answers anything', async (context) => {
    // Arrange - the tab's relay injection and every request to its document never settle
    const document = fakeDocument('DOC-1', null)
    document.isHeld = true
    const tab = whatsappTab(41, document)
    tab.injectRelay = () => new Promise(() => undefined)

    // Act
    const browser = await startWorker(context, [tab], { queued: [SLACK_EVENT] })
    await until(() => browser.posted.length >= 3)

    // Assert - after the worker's hello
    assert.deepEqual(
      browser.posted.slice(0, 3).map((frame): unknown => Reflect.get(frame as object, 'type')),
      ['hello', 'status', 'event']
    )

    assert.deepEqual(browser.posted[2], SLACK_EVENT)
  })
})

describe('[extension] WhatsApp dispatch - lifecycle', () => {
  it('should list a WhatsApp tab only once its document answered the request its first report raised', async (context) => {
    // Arrange - the document holds its answer
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    document.isHeld = true
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    const whileHeld = await whatsappNow(browser)

    // Act - it answers the next request
    document.isHeld = false
    report(browser, tab, document)

    // Assert
    assert.deepEqual(whileHeld, [])
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41)])
  })

  it("should list the new document after a reload, whether the old document's late report comes before, between or after the new document's report and answer", async (context) => {
    for (const lateAt of ['before', 'between', 'after'] as const) {
      await context.test(`the old document's late report comes ${lateAt}`, async (variant) => {
        // Arrange
        const old = fakeDocument('DOC-1', observed(TOKEN_1))
        const tab = whatsappTab(41, old)
        const browser = await startWorker(variant, [tab])
        await whatsappNow(browser)

        // Act - the tab reloads into DOC-2, whose first report waits for its answer until the test releases it
        const next = reload(tab, 'DOC-2', TOKEN_2)
        next.isHeld = true
        updated(browser, tab, { status: 'loading' })

        if (lateAt === 'before') {
          report(browser, tab, old)
        }

        report(browser, tab, next)

        if (lateAt === 'between') {
          report(browser, tab, old)
        }

        await settled()
        next.isHeld = false
        report(browser, tab, next)
        await settled()

        if (lateAt === 'after') {
          report(browser, tab, old)
        }

        // Assert
        assert.deepEqual(await whatsappNow(browser), [readyStatus(41, false)])
      })
    }
  })

  it('should drop a discarded tab once the request to its document is rejected, and list its next document', async (context) => {
    // Arrange
    const tab = whatsappTab(41, fakeDocument('DOC-1', observed(TOKEN_1)))
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)

    // Act - Chrome discards the tab, then loads DOC-2 when the owner activates it
    tab.discarded = true
    tab.shown = null
    tab.live = []
    updated(browser, tab, { discarded: true, status: 'unloaded' })
    const whileDiscarded = await whatsappNow(browser)
    tab.discarded = false
    reload(tab, 'DOC-2', TOKEN_2)
    updated(browser, tab, { status: 'loading' })

    // Assert
    assert.deepEqual(whileDiscarded, [])
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41, false)])
  })

  it('should keep listing the new document when a discard event comes after its report', async (context) => {
    // Arrange - the discard happened, DOC-2 loaded on activation and reported, and the discard event comes late
    const tab = whatsappTab(41, fakeDocument('DOC-1', observed(TOKEN_1)))
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)
    const next = reload(tab, 'DOC-2', TOKEN_2)
    report(browser, tab, next)
    await settled()

    // Act
    updated(browser, tab, { discarded: true })

    // Assert
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41, false)])
    assert.deepEqual(browser.stateRequests.at(-1), { tabId: 41, documentId: 'DOC-2' })
  })

  it('should keep a WhatsApp tab listed while a request raised by its URL change never settles', async (context) => {
    // Arrange
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)

    // Act - the page changes its URL in the same document, which now holds every request
    document.isHeld = true
    tab.url = `${WHATSAPP_ORIGIN}/send`
    updated(browser, tab, { url: tab.url })

    // Assert
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41)])
  })

  it("should list a WhatsApp tab again at its document's next report after a request to it was rejected", async (context) => {
    // Arrange - a request to the live document is rejected, as Chrome may reject one (amendment 3 C2)
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)
    tab.live = []
    report(browser, tab, document)
    const afterRejection = await whatsappNow(browser)

    // Act
    tab.live = [document]
    report(browser, tab, document)

    // Assert
    assert.deepEqual(afterRejection, [])
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41)])
  })

  it('should list a page restored from the back/forward cache again at its pageshow report', async (context) => {
    // Arrange - the tab navigates away and DOC-1 goes into the back/forward cache
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)
    document.isHidden = true
    tab.url = 'https://example.com/'
    updated(browser, tab, { url: tab.url })
    const whileCached = await whatsappNow(browser)

    // Act - back: Chrome restores DOC-1, whose relay reports at pageshow
    document.isHidden = false
    tab.url = `${WHATSAPP_ORIGIN}/`
    updated(browser, tab, { url: tab.url })
    report(browser, tab, document)

    // Assert
    assert.deepEqual(whileCached, [])
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41)])
  })

  it('should drop a tab that navigated off web.whatsapp.com from the status, though the request to its document never settles', async (context) => {
    // Arrange
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)

    // Act
    document.isHeld = true
    tab.url = 'https://example.com/'
    updated(browser, tab, { url: tab.url })

    // Assert
    assert.deepEqual(await whatsappNow(browser), [])
  })

  it('should list a prerendered page once it reports at activation, from a frame whose id is not 0', async (context) => {
    // Arrange - DOC-2 is prerendered for tab 41 while it shows DOC-1, and sends a message, which only makes the worker ask
    const current = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, current)
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)
    const prerendered = fakeDocument('DOC-2', observed(TOKEN_2, false))
    prerendered.isPrerendering = true
    prerendered.frameId = 3
    tab.live = [current, prerendered]
    fromRelay(browser, senderOf(tab, prerendered), { kind: 'whatsapp-message', account: LEO_NOVAK, message: MESSAGE })
    const whilePrerendering = await whatsappNow(browser)

    // Act - activation: the tab shows DOC-2, and its relay reports at prerenderingchange
    prerendered.isPrerendering = false
    tab.shown = prerendered
    tab.live = [prerendered]
    updated(browser, tab, { status: 'complete' })
    report(browser, tab, prerendered)

    // Assert
    assert.deepEqual(whilePrerendering, [readyStatus(41)])
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41, false)])
  })

  it('should make no state for a tab whose report arrives after it closed', async (context) => {
    // Arrange
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab])
    await whatsappNow(browser)

    // Act - the tab closes, and a report its document posted before is delivered after
    browser.tabs = []
    emit(browser.tabEvents.onRemoved, 41)
    report(browser, tab, document)
    await settled()
    browser.tabs = [tab]

    // Assert - even listed open again, tab 41 has no record
    assert.deepEqual(await whatsappNow(browser), [])
  })

  it("should list a tab's live document after a worker restart in which a dead document's report came first", async (context) => {
    // Arrange - tab 41 shows live DOC-2, whose report from the start-time request is still on its way; DOC-1 died after
    // it posted a report
    const dead = fakeDocument('DOC-1', observed(TOKEN_1))
    const live = fakeDocument('DOC-2', observed(TOKEN_2))
    live.isHidden = true
    const tab = whatsappTab(41, live)
    const browser = await startWorker(context, [tab])

    // Act - the new worker gets DOC-1's report, then DOC-2's, then another of DOC-1's
    report(browser, tab, dead)
    await settled()
    live.isHidden = false
    report(browser, tab, live)
    await settled()
    report(browser, tab, dead)

    // Assert
    assert.deepEqual(await whatsappNow(browser), [readyStatus(41)])

    assert.deepEqual(
      browser.stateRequests.map(({ documentId }) => documentId),
      ['DOC-1', 'DOC-2', 'DOC-1']
    )
  })

  it('should forget a WhatsApp tab Chrome replaced, and ask the tab that replaced it to report', async (context) => {
    // Arrange
    const replaced = whatsappTab(41, fakeDocument('DOC-1', observed(TOKEN_1)))
    const browser = await startWorker(context, [replaced])
    await whatsappNow(browser)
    const addedDocument = fakeDocument('DOC-3', observed(TOKEN_2))
    addedDocument.isHeld = true
    const added = whatsappTab(43, addedDocument)

    // Act
    browser.tabs = [added]
    emit(browser.tabEvents.onReplaced, 43, 41)

    // Assert
    assert.deepEqual(await whatsappNow(browser), [])
    assert.deepEqual(browser.reportRequests.at(-1), 43)
  })

  it("should not take a closed tab's answer asked before the close, and ask its document again, with no listener attached", async (context) => {
    // Arrange - with no listener, no status snapshot prunes the closed tab's record; DOC-1 holds the answer to its report
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const tab = whatsappTab(41, document)
    const browser = await startWorker(context, [tab], { isListening: false })
    await until(() => browser.stateRequests.length === 1)
    await settled()
    document.isHeld = true
    report(browser, tab, document)
    await until(() => browser.heldStates.length === 1)

    // Act - the tab closes, and then the answer asked before the close arrives
    browser.tabs = []
    emit(browser.tabEvents.onRemoved, 41)
    browser.heldStates[0]?.release()
    await settled()

    // Assert - asked again, pinned to DOC-1, before any snapshot
    assert.deepEqual(browser.stateRequests, [
      { tabId: 41, documentId: 'DOC-1' },
      { tabId: 41, documentId: 'DOC-1' },
      { tabId: 41, documentId: 'DOC-1' },
    ])
  })

  it("should not take a replaced tab's answer asked before the replacement, and ask its document again, with no listener attached", async (context) => {
    // Arrange - with no listener, no status snapshot prunes the replaced tab's record; DOC-1 holds the answer to its
    // report
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    const replaced = whatsappTab(41, document)
    const browser = await startWorker(context, [replaced], { isListening: false })
    await until(() => browser.stateRequests.length === 1)
    await settled()
    document.isHeld = true
    report(browser, replaced, document)
    await until(() => browser.heldStates.length === 1)

    // Act - Chrome replaces tab 41 with tab 43, whose document reports and answers; then the answer asked before the
    // replacement arrives
    browser.tabs = [whatsappTab(43, fakeDocument('DOC-3', observed(TOKEN_2)))]
    emit(browser.tabEvents.onReplaced, 43, 41)
    await settled()
    browser.heldStates[0]?.release()
    await settled()

    // Assert - asked again, pinned to DOC-1, before any snapshot
    assert.deepEqual(browser.stateRequests, [
      { tabId: 41, documentId: 'DOC-1' },
      { tabId: 41, documentId: 'DOC-1' },
      { tabId: 43, documentId: 'DOC-3' },
      { tabId: 41, documentId: 'DOC-1' },
    ])
  })

  it('should answer a Slack call and send the status while every request to a WhatsApp document never settles', async (context) => {
    // Arrange
    const document = fakeDocument('DOC-1', observed(TOKEN_1))
    document.isHeld = true
    const browser = await startWorker(context, [whatsappTab(41, document)], { slackTabs: [7] })

    // Act
    const reply = await ask(browser, 1, 'slackCall', SLACK_CALL)
    const whatsapp = await whatsappNow(browser)

    // Assert
    assert.equal(typeof Reflect.get(reply as object, 'error'), 'string')
    assert.deepEqual(whatsapp, [])
  })
})
