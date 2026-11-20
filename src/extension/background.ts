/// <reference types="chrome" />
import { z } from 'zod'
import { type ExtensionFrame, HostFrameSchema, NATIVE_HOST_NAME } from '../protocol/messages.js'
import {
  type CaptureHealth,
  chunkCount,
  chunkRange,
  NO_SLACK_TAB_ERROR,
  type PreparedUpload,
  SLACK_BRIDGE_METHODS,
  type SlackAccount,
  slackAccountId,
  type SlackAnswer,
  type SlackBridgeMethod,
  type SlackBridgeResult,
  type SlackIdentity,
  SlackIdentitySchema,
  type SlackMessageFrame,
  type SlackMethod,
  type SlackStatus,
  type SlackUploadMethod,
} from '../protocol/slack.js'
import { answerRequest, type IAbandonment, throwIfAbandoned } from '../service-worker/bridge-requests.js'
import { Forwarder } from '../service-worker/forwarder.js'
import { captureHealthOf, ObservedMessageSchema } from '../service-worker/observed-message.js'
import { openPendingQueue, PendingQueueWriter } from '../service-worker/pending-queue-writer.js'
import { attachRelay, type IRelayScripting, probeRelay, RelayProbeSchema } from '../service-worker/relay-attachment.js'
import { type ISlackPage, SlackClientObserver } from '../service-worker/slack-client-observer.js'
import { slackEventOf } from '../service-worker/slack-frame.js'
import {
  isAnsweredBySlack,
  runSlackPageCommand,
  type SlackPageCommand,
  type SlackPageFailure,
  type SlackPageResult,
  SlackPageResultSchema,
} from '../service-worker/slack-page.js'
import { borrowedQueryString, freshRequestId } from '../service-worker/slack-request-shape.js'
import {
  CAPTURE_QUERY,
  RECONNECT_ALARM,
  RECONNECT_PERIOD_MINUTES,
  RELAY_RUNNING_KEY,
  RELAY_SCRIPT,
  SLACK_ORIGIN,
  SLACK_REQUEST_URLS,
  SLACK_TAB_URL,
} from './config.js'
import { startTabTracking, TAB_HANDLERS } from './tab-commands.js'

// The service worker: the native port to the host, the pending queue and its forwarding, the status, the Slack bridge
// methods, each run in a Slack tab signed in as the account it names, and the tab commands of the browser tools
// (tab-commands.ts). What the page reports is data: it becomes events and status, never a native command.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

type Handlers = {
  [TMethod in SlackBridgeMethod]: (
    params: unknown,
    abandonment: IAbandonment
  ) => SlackBridgeResult<TMethod> | Promise<SlackBridgeResult<TMethod>>
}

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

// What Slack's client sends from its own pages, beside the requests the transport sends there.
const clientObserver = new SlackClientObserver(SLACK_ORIGIN, () => {
  void pushStatus()
})
const SLACK_REQUESTS: chrome.webRequest.RequestFilter = { urls: SLACK_REQUEST_URLS, types: ['xmlhttprequest'] }

const slackTabs = async (): Promise<IdentifiedTab[]> =>
  (await chrome.tabs.query({ url: SLACK_TAB_URL })).filter((tab): tab is IdentifiedTab => tab.id !== undefined)

// What the command answered in the target's page, unchecked (undefined when it answered nothing), and the document it
// ran in.
const injected = async (
  target: chrome.scripting.InjectionTarget,
  command: SlackPageCommand
): Promise<{ readonly documentId: string; readonly answered: unknown }> => {
  const [injection] = await chrome.scripting.executeScript({
    target,
    world: 'MAIN',
    func: runSlackPageCommand,
    args: [command],
  })
  if (injection === undefined) {
    throw new Error(`The Slack page in tab ${target.tabId} ran nothing`)
  }

  return { documentId: injection.documentId, answered: injection.result }
}

// What each failure code of a Slack page says (slack-page.ts SLACK_PAGE_FAILURES). Worded here, so no error quotes the
// page or a response.
const PAGE_FAILURE_TEXT: Readonly<Record<SlackPageFailure, string>> = {
  'client-state-unreadable': "Slack's saved client state does not read",
  'no-api-session': "Slack's client keeps no API session for the workspace",
  'no-api-address': "Slack's client keeps no Slack API address for the workspace",
  'no-client-query':
    "The extension has seen no Web API call of Slack's own client in this page since it started; use Slack in the tab, or reload it",
  'deadline-passed': "The caller's deadline passed before the request went out, so nothing was sent",
  'api-unreachable': "Slack's Web API could not be reached",
  'api-refused': "Slack's Web API refused the call",
  'api-no-answer': "Slack's Web API answered no JSON object with a boolean ok",
  'file-unreachable': 'Slack could not be reached for the file',
  'file-refused': 'Slack refused the file',
  'file-bytes-lost': "The file's bytes did not arrive",
  'upload-unreachable': 'The upload URL could not be reached or answered a redirect',
  'uncaught': 'The command failed in the page',
}

// What the command answered, checked. Every error here is worded by the service worker: a failure from its code and
// status, and an answer that does not read with a fixed message, since zod's would quote the keys the answer holds.
const pageResultOf = (tabId: number, command: SlackPageCommand, answered: unknown): SlackPageResult => {
  if (answered === undefined) {
    throw new Error(`The Slack page in tab ${tabId} answered nothing`)
  }

  const result = SlackPageResultSchema.safeParse(answered)
  if (!result.success) {
    throw new Error(`The Slack page in tab ${tabId} answered what does not read`)
  }

  if (result.data.kind === 'failed') {
    const { failure, status } = result.data
    const refusal = status === null ? '' : ` (HTTP ${status})`
    throw new Error(`The Slack page in tab ${tabId} failed ${command.kind}: ${PAGE_FAILURE_TEXT[failure]}${refusal}`)
  }

  return result.data
}

// Runs the command in the page's document and in no other: one the tab has navigated to since fails the injection.
const runInPage = async (page: ISlackPage, command: SlackPageCommand): Promise<SlackPageResult> => {
  const { answered } = await injected({ tabId: page.tabId, documentIds: [page.documentId] }, command)

  return pageResultOf(page.tabId, command, answered)
}

const unexpected = (result: SlackPageResult): Error => new Error(`The Slack page answered ${result.kind}`)

// Who the target's page is signed in as, from Slack's client state, and the document that was read in: only the ids
// and the workspace's name leave the page. A page the extension cannot script (discarded, still loading, an error page,
// a document that is gone) shows no account; an answer that does not read is an error.
const identityRead = async (
  target: chrome.scripting.InjectionTarget
): Promise<{ readonly page: ISlackPage; readonly identity: SlackIdentity | null } | null> => {
  const command: SlackPageCommand = { kind: 'identity' }
  const injection = await injected(target, command).catch(() => null)
  if (injection === null) {
    return null
  }

  const result = pageResultOf(target.tabId, command, injection.answered)
  if (result.kind !== 'identity') {
    throw unexpected(result)
  }

  const identity =
    result.identity === null ? null : SlackIdentitySchema.parse({ ...result.identity, tabId: target.tabId })

  return { page: { tabId: target.tabId, documentId: injection.documentId }, identity }
}

const identityOf = async (target: chrome.scripting.InjectionTarget): Promise<SlackIdentity | null> =>
  (await identityRead(target))?.identity ?? null

// A tab with no relay to answer is detached: one whose page loaded before the extension did, or one this worker has not
// given a new relay yet since the extension reloaded (attachRelays).
const captureOf = (tabId: number): Promise<CaptureHealth> =>
  chrome.tabs.sendMessage(tabId, CAPTURE_QUERY).then(
    (answer: unknown) => captureHealthOf(tabId, answer),
    (): CaptureHealth => ({ tabId, state: 'detached' })
  )

// The relay's injection, bound to the top document the probe ran in (relay-attachment.ts). A tab whose page the
// extension cannot script (still loading, an error page, a document that is gone) holds no document to probe, as for
// identityOf.
const relayScripting: IRelayScripting = {
  probe: async (tabId) => {
    const injections = await chrome.scripting
      .executeScript({ target: { tabId }, world: 'ISOLATED', func: probeRelay, args: [RELAY_RUNNING_KEY] })
      .catch(() => null)
    const [injection] = injections ?? []
    if (injection === undefined) {
      return null
    }

    return { documentId: injection.documentId, probe: RelayProbeSchema.parse(injection.result) }
  },
  inject: async (tabId, documentId) => {
    await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files: [RELAY_SCRIPT] })
  },
}

// Chrome puts the manifest's content scripts only into documents that load after the extension did, and cuts the relay
// of every open tab off from the extension once it reloads, updates or is turned off and on, which starts a new worker.
// The observer a tab loaded with keeps watching Slack's socket, so each open Slack page with no relay of this load of
// the extension gets a new one, which asks the observer for a channel of its own (capture-handshake.ts). A page that
// loaded before the extension did, or with an observer that answers only its first relay, gives the new relay no
// channel, and stays detached until it reloads. A discarded tab holds no page, and runs the manifest's scripts once it
// loads again.
const attachRelays = async (): Promise<void> => {
  const tabs = (await slackTabs()).filter((tab) => !tab.discarded)
  await Promise.all(tabs.map(({ id }) => attachRelay(relayScripting, id, SLACK_ORIGIN)))
}

// The pages signed in as the account, each in the document its identity was read in.
const signedInPages = async (account: SlackAccount): Promise<ISlackPage[]> => {
  const reads = await Promise.all((await slackTabs()).map(({ id }) => identityRead({ tabId: id })))

  return reads.flatMap((read) =>
    read?.identity?.teamId === account.teamId && read.identity.userId === account.userId ? [read.page] : []
  )
}

// A command for a page, and what its request is known by while it runs (slack-request-shape.ts requestKeyOf).
interface IPageRequest {
  readonly key: string
  readonly command: SlackPageCommand
}

// Runs the request's command in the page. While it runs, the observer takes the request it sends as Misha's, never as
// one of the client's, and checks it once the command settled.
const requestInPage = async (page: ISlackPage, { key, command }: IPageRequest): Promise<SlackPageResult> => {
  const release = clientObserver.exclude(page, key)
  let isAnswered = false
  try {
    const result = await runInPage(page, command)
    isAnswered = isAnsweredBySlack(result)

    return result
  } finally {
    release(isAnswered)
  }
}

// Runs a request in a page signed in as the account and in no other, and answers the page with what it answered; null
// when there is none. Pages are tried one at a time, so a write goes out at most once: a page whose user changed since
// its identity was read answers other-account without sending anything, and the next one is tried, while a page that
// fails during the command fails the call, since the command may have reached Slack. Nothing more is sent once the
// caller gave up, which the page checks against the deadline once more right before its request leaves.
const inSlackTab = async (
  account: SlackAccount,
  abandonment: IAbandonment,
  requestFor: (page: ISlackPage) => IPageRequest
): Promise<{ readonly page: ISlackPage; readonly result: SlackPageResult } | null> => {
  for (const page of await signedInPages(account)) {
    throwIfAbandoned(abandonment)
    const result = await requestInPage(page, requestFor(page))
    if (result.kind !== 'other-account') {
      return { page, result }
    }
  }

  return null
}

// A Web API call in a page: a fresh request id, and for each workspace API the query its client lent the transport.
const callRequest =
  (
    account: SlackAccount,
    method: SlackMethod | SlackUploadMethod,
    params: Readonly<Record<string, string>>,
    deadline: number
  ) =>
  (page: ISlackPage): IPageRequest => {
    const requestId = freshRequestId()
    const queries = new Map(
      [...clientObserver.clientQueries(page)].map(([origin, query]) => [origin, borrowedQueryString(query, requestId)])
    )

    return {
      key: requestId,
      command: { kind: 'call', account, method, params, queries: Object.fromEntries(queries), deadline },
    }
  }

const answerOf = (result: SlackPageResult): SlackAnswer => {
  if (result.kind !== 'answer') {
    throw unexpected(result)
  }

  return result.answer
}

const callSlack = async (
  account: SlackAccount,
  method: SlackMethod | SlackUploadMethod,
  params: Readonly<Record<string, string>>,
  abandonment: IAbandonment
): Promise<SlackAnswer> => {
  const answered = await inSlackTab(account, abandonment, callRequest(account, method, params, abandonment.deadline))

  return answered === null ? { ok: false, error: NO_SLACK_TAB_ERROR } : answerOf(answered.result)
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

// The upload URL and the file's id files.getUploadURLExternal answered, or the error it refused the upload with.
const uploadTicketOf = (
  answer: SlackAnswer
): { readonly uploadUrl: URL; readonly fileId: string } | { readonly error: string } => {
  if (!answer.ok && typeof answer.error === 'string') {
    return { error: answer.error }
  }

  const { upload_url: uploadUrl, file_id: fileId } = answer
  const parsed = typeof uploadUrl === 'string' ? URL.parse(uploadUrl) : null
  if (!answer.ok || parsed === null || typeof fileId !== 'string') {
    throw new Error('files.getUploadURLExternal answered neither an upload URL with a file id nor an error')
  }

  return { uploadUrl: parsed, fileId }
}

const preparedUploadOf = (uploaded: SlackPageResult, fileId: string): PreparedUpload => {
  if (uploaded.kind === 'upload-refused') {
    return { ok: false, error: `The upload URL answered HTTP ${uploaded.status}` }
  }

  if (uploaded.kind === 'other-account') {
    return { ok: false, error: NO_SLACK_TAB_ERROR }
  }

  if (uploaded.kind !== 'uploaded') {
    throw unexpected(uploaded)
  }

  return { ok: true, fileId }
}

const slackHandlers: Handlers = {
  slackCall: (raw, abandonment) => {
    const { account, method, params } = SLACK_BRIDGE_METHODS.slackCall.params.parse(raw)

    return callSlack(account, method, params, abandonment)
  },
  slackDownload: async (raw, abandonment) => {
    const { account, url } = SLACK_BRIDGE_METHODS.slackDownload.params.parse(raw)
    const answered = await inSlackTab(account, abandonment, () => ({
      key: new URL(url).href,
      command: { kind: 'download', account, url, deadline: abandonment.deadline },
    }))
    if (answered === null) {
      throw new Error(`${NO_SLACK_TAB_ERROR}: no open Slack tab is signed in as ${slackAccountId(account)}`)
    }

    const { result } = answered
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
  slackUploadPrepare: async (raw, abandonment) => {
    const { account, uploadId, filename, byteLength } = SLACK_BRIDGE_METHODS.slackUploadPrepare.params.parse(raw)
    const parts = uploadParts(uploads.get(uploadId), byteLength)
    uploads.delete(uploadId)
    if (parts === null) {
      return { ok: false, error: `The chunks pushed for upload ${uploadId} do not add up to ${byteLength} bytes` }
    }

    const params = { filename, length: String(byteLength) }
    const { deadline } = abandonment
    const ticketRequest = callRequest(account, 'files.getUploadURLExternal', params, deadline)
    const answered = await inSlackTab(account, abandonment, ticketRequest)
    if (answered === null) {
      return { ok: false, error: NO_SLACK_TAB_ERROR }
    }

    const ticket = uploadTicketOf(answerOf(answered.result))
    if ('error' in ticket) {
      return { ok: false, error: ticket.error }
    }

    // The bytes go from the page that took the ticket; a page whose user changed since sends nothing.
    const { href } = ticket.uploadUrl
    throwIfAbandoned(abandonment)
    const uploaded = await requestInPage(answered.page, {
      key: href,
      command: { kind: 'upload', account, uploadUrl: href, filename, chunks: parts, deadline },
    })

    return preparedUploadOf(uploaded, ticket.fileId)
  },
  slackUploadFinish: (raw, abandonment) => {
    const { account, fileId, title, channel, threadTs, initialComment } =
      SLACK_BRIDGE_METHODS.slackUploadFinish.params.parse(raw)

    return callSlack(
      account,
      'files.completeUploadExternal',
      {
        files: JSON.stringify([{ id: fileId, title }]),
        channel_id: channel,
        ...(threadTs === null ? {} : { thread_ts: threadTs }),
        ...(initialComment === null ? {} : { initial_comment: initialComment }),
      },
      abandonment
    )
  },
}

const handlers = { ...slackHandlers, ...TAB_HANDLERS }

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
    parity: clientObserver.parity(),
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

// A new message a Slack tab's observer saw in the document source, while the tab showed the captured account. It
// becomes an event only while that same document is still signed in as that account (slackEventOf): a document that is
// gone, or that moved to another workspace or user since, would key the message by an account it did not come to, so
// the message is dropped instead.
const admitFrame = async (
  source: chrome.scripting.InjectionTarget,
  captured: SlackAccount,
  message: SlackMessageFrame
): Promise<void> => {
  const event = slackEventOf(captured, await identityOf(source), message)
  if (event === null) {
    return
  }

  const admission = await writer.admit(event)
  if (admission === 'stored' || admission === 'held') {
    forwarder.forward(event)
  }
}

// A reply goes back only on the port its request came on, while that port is open. A newer port belongs to a new
// relay, which numbers its requests from 1 again, so a reply sent there could reach a caller that never asked. Each
// request of the port runs with a controller in running, which a cancel from the relay aborts.
const onHostFrame = (source: chrome.runtime.Port, running: Map<number, AbortController>, message: unknown): void => {
  const frame = HostFrameSchema.parse(message)
  switch (frame.type) {
    case 'request': {
      const controller = new AbortController()
      running.set(frame.id, controller)
      void answerRequest(handlers, frame, controller.signal).then((reply) => {
        running.delete(frame.id)
        if (port === source) {
          source.postMessage(reply)
        }
      })
      return
    }
    case 'cancel':
      running.get(frame.id)?.abort()
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
  const running = new Map<number, AbortController>()
  opened.onMessage.addListener((message: unknown) => onHostFrame(opened, running, message))
  // A port that dropped took its relay with it, and every caller of its requests lost the connection.
  opened.onDisconnect.addListener(() => {
    port = null
    for (const controller of running.values()) {
      controller.abort()
    }

    running.clear()
    forwarder.detach()
  })
  port = opened
}

// Only the relay in a Slack tab's top frame sends messages here. A frame is answered once its admission ran, and only
// then does the relay tell the page's observer that the frame was taken (capture-handshake.ts); until then the observer
// holds it, so a frame this worker never took reaches the relay that replaces the tab's relay if the extension reloads.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const tabId = sender.tab?.id
  const { documentId } = sender
  if (tabId === undefined || documentId === undefined || sender.origin !== SLACK_ORIGIN || sender.frameId !== 0) {
    throw new Error(`A message came from outside a Slack tab's relay (${sender.origin ?? 'no origin'})`)
  }

  const observed = ObservedMessageSchema.parse(message)
  if (observed.kind === 'capture') {
    void pushStatus()
    return false
  }

  void intake(() => admitFrame({ tabId, documentIds: [documentId] }, observed.account, observed.frame)).then(() => {
    sendResponse()
  })

  return true
})

// The listeners register when the service worker starts, as Chrome needs them to wake the worker. Chrome hands each
// request's body and headers (the token and the cookie among them) to the listeners, which keep only what the
// observer's rules keep (slack-request-shape.ts). extraHeaders adds the headers the browser sets itself.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    clientObserver.requestStarted(details)
  },
  SLACK_REQUESTS,
  ['requestBody']
)
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    clientObserver.headersSent(details)
  },
  SLACK_REQUESTS,
  ['requestHeaders', 'extraHeaders']
)
chrome.webRequest.onCompleted.addListener(({ requestId }) => {
  clientObserver.requestEnded(requestId)
}, SLACK_REQUESTS)
chrome.webRequest.onErrorOccurred.addListener(({ requestId }) => {
  clientObserver.requestEnded(requestId)
}, SLACK_REQUESTS)
chrome.tabs.onRemoved.addListener((tabId) => {
  clientObserver.forget(tabId)
  void pushStatus()
})
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if ((change.url !== undefined || change.status === 'complete') && tab.url?.startsWith(`${SLACK_ORIGIN}/`) === true) {
    void pushStatus()
  }
})

startTabTracking()
void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: RECONNECT_PERIOD_MINUTES })
chrome.alarms.onAlarm.addListener(() => connect())
void writer.recover()
void attachRelays()
connect()
