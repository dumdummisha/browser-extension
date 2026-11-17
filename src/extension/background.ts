/// <reference types="chrome" />
import { z } from 'zod'
import { type ExtensionFrame, type HostFrame, HostFrameSchema, NATIVE_HOST_NAME } from '../protocol/messages.js'
import {
  type CaptureHealth,
  chunkCount,
  chunkRange,
  NO_SLACK_TAB_ERROR,
  SLACK_BRIDGE_METHODS,
  type SlackAccount,
  slackAccountId,
  type SlackAnswer,
  type SlackBridgeMethod,
  type SlackBridgeResult,
  type SlackIdentity,
  SlackIdentitySchema,
  type SlackMessageFrame,
  type SlackStatus,
} from '../protocol/slack.js'
import { Forwarder } from '../service-worker/forwarder.js'
import { captureHealthOf, ObservedMessageSchema } from '../service-worker/observed-message.js'
import { openPendingQueue, PendingQueueWriter } from '../service-worker/pending-queue-writer.js'
import { slackEventOf } from '../service-worker/slack-frame.js'
import {
  runSlackPageCommand,
  type SlackPageCommand,
  type SlackPageResult,
  SlackPageResultSchema,
} from '../service-worker/slack-page.js'
import { CAPTURE_QUERY, RECONNECT_ALARM, RECONNECT_PERIOD_MINUTES, SLACK_ORIGIN, SLACK_TAB_URL } from './config.js'

// The service worker: the native port to the host, the pending queue and its forwarding, the status, and the bridge
// methods, each run in a Slack tab signed in as the account it names. What the page reports is data: it becomes events
// and status, never a native command.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

type Handlers = {
  [TMethod in SlackBridgeMethod]: (params: unknown) => SlackBridgeResult<TMethod> | Promise<SlackBridgeResult<TMethod>>
}

type BridgeRequest = Extract<HostFrame, { type: 'request' }>
type IdentifiedTab = chrome.tabs.Tab & { id: number }

// Runs tasks one at a time, in the order they came: a failed one rejects its own promise and the next still runs.
const serially = (): (<TResult>(task: () => Promise<TResult>) => Promise<TResult>) => {
  let tail: Promise<unknown> = Promise.resolve()

  return (task) => {
    const next = tail.then(task)
    tail = next.catch(() => undefined)

    return next
  }
}

let port: chrome.runtime.Port | null = null

const post = (frame: ExtensionFrame): void => {
  port?.postMessage(frame)
}

// Files on their way through the extension, by the id of their transfer: a download until its last chunk is pulled,
// and an upload's pushed chunks until it is prepared. A service worker restart drops them, and the app starts over.
const downloads = new Map<string, Uint8Array>()
const uploads = new Map<string, Map<number, string>>()

const slackTabs = async (): Promise<IdentifiedTab[]> =>
  (await chrome.tabs.query({ url: SLACK_TAB_URL })).filter((tab): tab is IdentifiedTab => tab.id !== undefined)

// What the command answered in the target's page, unchecked; undefined when it answered nothing.
const injected = async (target: chrome.scripting.InjectionTarget, command: SlackPageCommand): Promise<unknown> => {
  const [injection] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: runSlackPageCommand,
    args: [command],
  })

  return injection?.result
}

// What the command answered, checked. A command that failed in the page throws with the page's own words, which quote
// nothing the page holds.
const pageResultOf = (tabId: number, answered: unknown): SlackPageResult => {
  if (answered === undefined) {
    throw new Error(`The Slack page in tab ${tabId} answered nothing`)
  }

  const result = SlackPageResultSchema.parse(answered)
  if (result.kind === 'failed') {
    throw new Error(`The Slack page in tab ${tabId} failed: ${result.error}`)
  }

  return result
}

const runInPage = async (tabId: number, command: SlackPageCommand): Promise<SlackPageResult> =>
  pageResultOf(tabId, await injected({ tabId }, command))

const unexpected = (result: SlackPageResult): Error => new Error(`The Slack page answered ${result.kind}`)

// Who the target's page is signed in as, from Slack's client state: only the ids and the workspace's name leave the
// page. A page the extension cannot script (discarded, still loading, an error page, a document that is gone) shows no
// account; an answer that does not read is an error.
const identityOf = async (target: chrome.scripting.InjectionTarget): Promise<SlackIdentity | null> => {
  const answered = await injected(target, { kind: 'identity' }).catch(() => null)
  if (answered === null) {
    return null
  }

  const result = pageResultOf(target.tabId, answered)
  if (result.kind !== 'identity') {
    throw unexpected(result)
  }

  return result.identity === null ? null : SlackIdentitySchema.parse({ ...result.identity, tabId: target.tabId })
}

// A tab opened before the extension loaded has no relay to answer, and its observer is not attached until it reloads.
const captureOf = (tabId: number): Promise<CaptureHealth> =>
  chrome.tabs.sendMessage(tabId, CAPTURE_QUERY).then(
    (answer: unknown) => captureHealthOf(tabId, answer),
    (): CaptureHealth => ({ tabId, state: 'detached' })
  )

// Runs a command in a tab signed in as the account and in no other; null when there is none. Tabs are tried one at a
// time, so a write goes out at most once: a tab whose user changed since its identity was read answers other-account
// without sending anything, and the next one is tried, while a tab that fails during the command fails the call,
// since the command may have reached Slack.
const inSlackTab = async (account: SlackAccount, command: SlackPageCommand): Promise<SlackPageResult | null> => {
  const tabs = await slackTabs()
  const identities = await Promise.all(tabs.map(({ id }) => identityOf({ tabId: id })))
  const signedIn = tabs.filter(
    (_tab, index) => identities[index]?.teamId === account.teamId && identities[index].userId === account.userId
  )
  for (const tab of signedIn) {
    const result = await runInPage(tab.id, command)
    if (result.kind !== 'other-account') {
      return result
    }
  }

  return null
}

const callSlack = async (
  account: SlackAccount,
  method: string,
  params: Readonly<Record<string, string>>
): Promise<SlackAnswer> => {
  const result = await inSlackTab(account, { kind: 'call', account, method, params })
  if (result === null) {
    return { ok: false, error: NO_SLACK_TAB_ERROR }
  }

  if (result.kind !== 'answer') {
    throw unexpected(result)
  }

  return result.answer
}

// The pushed chunks of an upload in order, or null when they do not add up to byteLength bytes.
const uploadParts = (chunks: ReadonlyMap<number, string> | undefined, byteLength: number): string[] | null => {
  if (chunks?.size !== chunkCount(byteLength)) {
    return null
  }

  const parts: string[] = []
  for (let index = 0; index < chunks.size; index += 1) {
    const part = chunks.get(index)
    const { start, end } = chunkRange(index, byteLength)
    if (part === undefined || Uint8Array.fromBase64(part).byteLength !== end - start) {
      return null
    }

    parts.push(part)
  }

  return parts
}

const handlers: Handlers = {
  slackCall: (raw) => {
    const { account, method, params } = SLACK_BRIDGE_METHODS.slackCall.params.parse(raw)

    return callSlack(account, method, params)
  },
  slackDownload: async (raw) => {
    const { account, url } = SLACK_BRIDGE_METHODS.slackDownload.params.parse(raw)
    const result = await inSlackTab(account, { kind: 'download', account, url })
    if (result === null) {
      throw new Error(`${NO_SLACK_TAB_ERROR}: no open Slack tab is signed in as ${slackAccountId(account)}`)
    }

    if (result.kind !== 'file') {
      throw unexpected(result)
    }

    const bytes = Uint8Array.fromBase64(result.data)
    const downloadId = crypto.randomUUID()
    if (bytes.byteLength > 0) {
      downloads.set(downloadId, bytes)
    }

    return { downloadId, byteLength: bytes.byteLength }
  },
  slackDownloadChunk: (raw) => {
    const { downloadId, index } = SLACK_BRIDGE_METHODS.slackDownloadChunk.params.parse(raw)
    const bytes = downloads.get(downloadId)
    if (bytes === undefined) {
      throw new Error(`No download ${downloadId} is held: its last chunk was pulled, or it never started`)
    }

    const { start, end } = chunkRange(index, bytes.byteLength)
    if (end === bytes.byteLength) {
      downloads.delete(downloadId)
    }

    return { data: bytes.subarray(start, end).toBase64() }
  },
  slackUploadChunk: (raw) => {
    const { uploadId, index, data } = SLACK_BRIDGE_METHODS.slackUploadChunk.params.parse(raw)
    const chunks = uploads.get(uploadId) ?? new Map<number, string>()
    chunks.set(index, data)
    uploads.set(uploadId, chunks)

    return {}
  },
  slackUploadPrepare: async (raw) => {
    const { account, uploadId, filename, byteLength } = SLACK_BRIDGE_METHODS.slackUploadPrepare.params.parse(raw)
    const parts = uploadParts(uploads.get(uploadId), byteLength)
    uploads.delete(uploadId)
    if (parts === null) {
      return { ok: false, error: `The chunks pushed for upload ${uploadId} do not add up to ${byteLength} bytes` }
    }

    const result = await inSlackTab(account, { kind: 'upload', account, filename, chunks: parts })
    if (result === null) {
      return { ok: false, error: NO_SLACK_TAB_ERROR }
    }

    if (result.kind !== 'prepared') {
      throw unexpected(result)
    }

    return result.prepared
  },
  slackUploadFinish: (raw) => {
    const { account, fileId, title, channel, threadTs, initialComment } =
      SLACK_BRIDGE_METHODS.slackUploadFinish.params.parse(raw)

    return callSlack(account, 'files.completeUploadExternal', {
      files: JSON.stringify([{ id: fileId, title }]),
      channel_id: channel,
      ...(threadTs === null ? {} : { thread_ts: threadTs }),
      ...(initialComment === null ? {} : { initial_comment: initialComment }),
    })
  },
}

const isBridgeMethod = (method: string): method is SlackBridgeMethod => Object.hasOwn(handlers, method)

const answer = async ({ id, method, params }: BridgeRequest): Promise<ExtensionFrame> => {
  if (!isBridgeMethod(method)) {
    return {
      type: 'reply',
      id,
      error: `This extension does not know ${method}; it is older than its client. Reload it.`,
    }
  }

  try {
    return { type: 'reply', id, result: await handlers[method](params) }
  } catch (error) {
    return { type: 'reply', id, error: error instanceof Error ? error.message : String(error) }
  }
}

const writer = new PendingQueueWriter(() => openPendingQueue(indexedDB), {
  onRestored: (events) => {
    for (const event of events) {
      forwarder.forward(event)
    }
  },
  onHealthChange: () => {
    void pushStatus()
  },
})
const forwarder = new Forwarder(post, (id) => writer.isPending(id))
const statusQueue = serially()
const intake = serially()

const statusSnapshot = async (): Promise<SlackStatus> => {
  await writer.settled()
  const tabs = await slackTabs()
  const [identities, captures] = await Promise.all([
    Promise.all(tabs.map(({ id }) => identityOf({ tabId: id }))),
    Promise.all(tabs.map(({ id }) => captureOf(id))),
  ])

  return {
    type: 'status',
    identities: identities.filter((identity) => identity !== null),
    captures,
    queue: writer.health(),
  }
}

// Status goes only to a listener; snapshots go out in the order they were taken.
const pushStatus = (): Promise<void> =>
  statusQueue(async () => {
    if (forwarder.hasListener) {
      post(await statusSnapshot())
    }
  })

// A listener attached: it gets the status, then every event still waiting for its ack. The events go out even when the
// status could not be taken, so nothing a tab reports can keep them from the app.
const attachListener = (): Promise<void> =>
  statusQueue(async () => {
    try {
      post(await statusSnapshot())
    } finally {
      forwarder.attach(writer.pending())
    }
  })

// A new message a Slack tab's observer saw in the document source, while the tab showed workspace teamId. It becomes an
// event keyed by the account that same document is signed in as, and only while it still shows that workspace: a
// document that is gone, or that moved to another workspace since, would key the message by an account it did not come
// to, so the message is dropped instead.
const admitFrame = async (
  source: chrome.scripting.InjectionTarget,
  teamId: string,
  message: SlackMessageFrame
): Promise<void> => {
  const identity = await identityOf(source)
  if (identity?.teamId !== teamId) {
    return
  }

  const event = slackEventOf({ teamId, userId: identity.userId }, message)
  const admission = await writer.admit(event)
  if (admission === 'stored' || admission === 'held') {
    forwarder.forward(event)
  }
}

const onHostFrame = (message: unknown): void => {
  const frame = HostFrameSchema.parse(message)
  switch (frame.type) {
    case 'request':
      void answer(frame).then(post)
      return
    case 'ack':
      // Redelivery stops once the event is no longer pending: a held one at once, a stored one once its deletion
      // commits, so a deletion that fails leaves the event forwarded again.
      void writer.ack(frame.id).then((isRemoved) => {
        if (isRemoved) {
          forwarder.settle(frame.id)
        }
      })
      return
    case 'listener':
      void attachListener()
  }
}

// An open native port keeps the service worker alive; once it drops, the alarm reconnects.
const connect = (): void => {
  if (port !== null) {
    return
  }

  const opened = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  opened.onMessage.addListener(onHostFrame)
  opened.onDisconnect.addListener(() => {
    port = null
    forwarder.detach()
  })
  port = opened
}

// Only the relay in a Slack tab's top frame sends messages here.
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const tabId = sender.tab?.id
  const { documentId } = sender
  if (tabId === undefined || documentId === undefined || sender.origin !== SLACK_ORIGIN || sender.frameId !== 0) {
    throw new Error(`A message came from outside a Slack tab's relay (${sender.origin ?? 'no origin'})`)
  }

  const observed = ObservedMessageSchema.parse(message)
  if (observed.kind === 'frame') {
    void intake(() => admitFrame({ tabId, documentIds: [documentId] }, observed.teamId, observed.frame))
  } else {
    void pushStatus()
  }
})

chrome.tabs.onRemoved.addListener(() => {
  void pushStatus()
})
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if ((change.url !== undefined || change.status === 'complete') && tab.url?.startsWith(`${SLACK_ORIGIN}/`) === true) {
    void pushStatus()
  }
})

void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_PERIOD_MINUTES })
chrome.alarms.onAlarm.addListener(() => connect())
void writer.recover()
connect()
