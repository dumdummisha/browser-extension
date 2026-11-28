import { DIRECT_CHAT_WID_PATTERN, WHATSAPP_MESSAGE_TYPES } from '../protocol/whatsapp-fields.js'
import {
  type WhatsAppAccount,
  type WhatsAppBridgeMethod,
  type WhatsAppBridgeParams,
  type WhatsAppBridgeResult,
  type WhatsAppCapture,
  type WhatsAppDrift,
  type WhatsAppHistoryAnchor,
  type WhatsAppMessage,
  type WhatsAppRefusal,
  type WhatsAppUnconfirmed,
} from '../protocol/whatsapp.js'
import {
  type IPageChat,
  type IPageMessage,
  type IPageRow,
  type IPreparedText,
  type IRowKey,
  type IWhatsAppInternals,
  type PageSendResult,
  WHATSAPP_NEEDS,
  WhatsAppDriftError,
  type WhatsAppNeed,
} from './whatsapp-internals.js'

// The WhatsApp observer's rules, in the page's own world, over the page's internals as whatsapp-internals.ts reads
// them: the capture state, which messages are reported, the four commands and the prepared-send store. No WhatsApp
// name appears here. Like capture-handshake.ts it takes the built-ins it uses when the module loads, at
// document_start, and keeps what it holds in objects without a prototype; page scripts are out of scope (observer.ts).
const { apply, deleteProperty, get: valueAt } = Reflect
const { create, hasOwn, keys } = Object
const { isInteger } = Number
const execPattern = RegExp.prototype.exec

// How long a prepared message is kept: the longest the app waits on one bridge call (client bridge-client.ts
// REQUEST_TIMEOUT_MS, 120 s), so a prepared message the app has not committed within one more such period belongs to
// a flow that gave up (U2-R4, design Q6).
// The store's bound: every prepare takes a turn of its account's pace that counts (service-worker request-pace.ts),
// and its entry is kept before that turn ends, so two entries of one account are kept at least GAP_MIN_MS
// (request-pace.ts, 500 ms) apart, over every page signed in as it. Each prepare, right before it keeps its entry and
// with nothing asynchronous between, removes every entry of its page kept PREPARED_SEND_WINDOW_MS or longer ago
// (U2-R35), and only a prepare adds to the store. So a page's store never holds more than
// PREPARED_SEND_WINDOW_MS / GAP_MIN_MS = 240 entries, and the entries still inside their window number at most 240 over
// every page of the account together. Each start of the service worker inside a window can add one more to both,
// since its pace begins with no previous request (U2-R32). Each entry's timer removes it once its window ended, so an
// idle store empties when its timers run, which the browser may delay (a hidden tab's timers are throttled). Commands
// a page script posts on a channel of its own bypass the pace (docs/security.md, Out of scope).
export const PREPARED_SEND_WINDOW_MS = 120_000

// What the capture needs from the page's built-ins, taken by the observer's entry at document_start.
export interface ICaptureHost {
  readonly now: () => number
  readonly setTimer: (run: () => void, ms: number) => number
  readonly clearTimer: (timer: number) => void
  // crypto.randomUUID(), called once when the observer loads (U2-R26).
  readonly token: string
}

export interface IWhatsAppCapture {
  // The capture state as it stands, for a relay's greeting.
  readonly state: () => WhatsAppCapture
  // Checks every need of the page's internals (U2-R8), reports the state that follows, and from then on listens to the
  // page's messages and connection changes.
  readonly start: (internals: IWhatsAppInternals) => void
  // Acts on one command a relay passed on and posts its one answer with answer: { kind: 'answer', id, answer }, or
  // { kind: 'failed', id } when a prepare's or a read's page call threw while every internal it uses still checks
  // out. The relay already read the command against its schema, so this reads only what it uses, and a command that
  // does not read gets no answer.
  readonly command: (command: object, answer: (message: object) => void) => void
}

interface IPreparedEntry {
  // The lid wid of the account the message was prepared for (U2-R21).
  readonly account: string
  readonly chat: string
  readonly prepared: IPreparedText
  // host.now() when it was kept.
  readonly keptAt: number
  // Removes the entry PREPARED_SEND_WINDOW_MS after keptAt, so an idle store empties itself when its timers run
  // (U2-R19); a timer that runs late finds the entry already removed by a prepare's sweep or a commit, and changes
  // nothing.
  readonly timer: number
}

type CaptureCommand = {
  [TMethod in WhatsAppBridgeMethod]: { readonly method: TMethod; readonly params: WhatsAppBridgeParams<TMethod> }
}[WhatsAppBridgeMethod]

interface IReadCommand {
  readonly id: string
  readonly deadline: number
  readonly command: CaptureCommand
}

type ReadyCapture = Extract<WhatsAppCapture, { state: 'ready' }>
type HistoryDirection = WhatsAppHistoryAnchor['direction']

interface IHistoryPage {
  readonly rows: readonly IPageRow[]
  readonly next: WhatsAppHistoryAnchor | null
}

// One page call of a need, made the way its caller handles a throw: a command answers it, work the page started breaks
// the capture.
type PageCall = <TResult>(need: WhatsAppNeed, run: (internals: IWhatsAppInternals) => TResult) => TResult

// The capture turned broken while a command ran; the command answers broken with the capture's drift.
class CaptureBrokenError extends Error {
  constructor() {
    super('The WhatsApp capture is broken')
    this.name = 'CaptureBrokenError'
  }
}

// A page call threw while every internal it uses still checks out; the page's error stays in the page.
class PageCallFailedError extends Error {
  constructor() {
    super('A WhatsApp page call failed')
    this.name = 'PageCallFailedError'
  }
}

const isRecord = (value: unknown): value is object => typeof value === 'object' && value !== null

const ownValue = (record: object, key: string): unknown => (hasOwn(record, key) ? valueAt(record, key) : undefined)

const ownString = (record: object, key: string): string | null => {
  const value = ownValue(record, key)

  return typeof value === 'string' ? value : null
}

const accountOf = (params: object): WhatsAppAccount | null => {
  const account = ownValue(params, 'account')
  const wid = isRecord(account) ? ownString(account, 'wid') : null

  return wid === null ? null : { wid }
}

const anchorOf = (params: object): WhatsAppHistoryAnchor | null | undefined => {
  const anchor = ownValue(params, 'anchor')
  if (anchor === null) {
    return null
  }

  if (!isRecord(anchor)) {
    return undefined
  }

  const direction = ownValue(anchor, 'direction')
  const messageId = ownString(anchor, 'messageId')
  const fromMe = ownValue(anchor, 'fromMe')
  if ((direction !== 'before' && direction !== 'after') || messageId === null || typeof fromMe !== 'boolean') {
    return undefined
  }

  return { direction, messageId, fromMe }
}

// A command's params, read only as far as the capture uses them; null when they do not read.
const commandOf = (method: unknown, params: object): CaptureCommand | null => {
  const account = accountOf(params)
  if (account === null) {
    return null
  }

  const chat = ownString(params, 'chat')

  switch (method) {
    case 'whatsappSendPrepare': {
      const text = ownString(params, 'text')

      return chat === null || text === null ? null : { method, params: { account, chat, text } }
    }

    case 'whatsappSendCommit': {
      const messageId = ownString(params, 'messageId')
      const token = ownString(params, 'token')

      return chat === null || messageId === null || token === null
        ? null
        : { method, params: { account, chat, messageId, token } }
    }

    case 'whatsappHistory': {
      const anchor = anchorOf(params)
      const count = ownValue(params, 'count')

      return chat === null || anchor === undefined || typeof count !== 'number' || !isInteger(count) || count < 1
        ? null
        : { method, params: { account, chat, anchor, count } }
    }

    case 'whatsappContact': {
      const wid = ownString(params, 'wid')

      return wid === null ? null : { method, params: { account, wid } }
    }

    default:
      return null
  }
}

const readCommand = (value: object): IReadCommand | null => {
  const id = ownValue(value, 'id')
  const deadline = ownValue(value, 'deadline')
  const command = ownValue(value, 'command')
  const params = isRecord(command) ? ownValue(command, 'params') : undefined
  if (typeof id !== 'string' || typeof deadline !== 'number' || !isRecord(command) || !isRecord(params)) {
    return null
  }

  const read = commandOf(ownValue(command, 'method'), params)

  return read === null ? null : { id, deadline, command: read }
}

const isReportedType = (type: string): type is WhatsAppMessage['type'] =>
  WHATSAPP_MESSAGE_TYPES.some((reported) => reported === type)

const readyWid = (capture: WhatsAppCapture): string | null => (capture.state === 'ready' ? capture.account.wid : null)

const isSameCapture = (current: WhatsAppCapture, next: WhatsAppCapture): boolean => {
  if (current.state === 'ready' && next.state === 'ready') {
    return (
      current.account.wid === next.account.wid &&
      current.isConnected === next.isConnected &&
      current.hasSynced === next.hasSynced
    )
  }

  if (current.state === 'broken' && next.state === 'broken') {
    return current.drift === next.drift
  }

  return current.state === next.state
}

const refused = <TRefusal extends WhatsAppRefusal>(
  refusal: TRefusal
): { readonly outcome: 'refused'; readonly refusal: TRefusal } => ({ outcome: 'refused', refusal })

const unconfirmed = (
  code: WhatsAppUnconfirmed
): { readonly outcome: 'unconfirmed'; readonly code: WhatsAppUnconfirmed } => ({
  outcome: 'unconfirmed',
  code,
})

// The internals' key of a history anchor (U2-R34): the wire calls the key's own id messageId (protocol whatsapp.ts
// HistoryAnchorSchema), the internals call it id, and the key's chat is the chat the read was checked against.
const rowKeyOf = (chat: IPageChat, { messageId, fromMe }: WhatsAppHistoryAnchor): IRowKey => ({
  chat,
  id: messageId,
  fromMe,
})

const anchorAt = (direction: HistoryDirection, { id, fromMe }: IPageRow): WhatsAppHistoryAnchor => ({
  direction,
  messageId: id,
  fromMe,
})

// The kept row farthest from the anchor: the oldest of a before-read, the newest of an after-read. It is asked only
// of a read that found more rows than it keeps, which keeps count of them, and count is at least 1
// (WHATSAPP_BRIDGE_METHODS whatsappHistory params), so an empty list is a defect of this file, never a page answer.
const farthestKept = (direction: HistoryDirection, rows: readonly IPageRow[]): IPageRow => {
  const farthest = direction === 'before' ? rows[0] : rows.at(-1)
  if (farthest === undefined) {
    throw new Error('A history read that found more rows than it keeps kept none')
  }

  return farthest
}

// What an anchored read keeps of the rows it found: all of them when it found at most count, else the count nearest
// the anchor (for a before-read the last count, for an after-read the first count), before any row is filtered out.
const keptRows = (direction: HistoryDirection, found: readonly IPageRow[], count: number): readonly IPageRow[] => {
  if (found.length <= count) {
    return found
  }

  return direction === 'before' ? found.slice(1) : found.slice(0, count)
}

// One history read over raw rows (U2-R18). The database answers the rows nearest the key, oldest first, without the
// key itself (P7, P13), so an anchored read asks for one row more than it keeps: that row, the farthest from the
// anchor, only shows that more exist. Rows are kept before any is filtered, so a page of unreported rows still moves
// the reader on, and next anchors on the kept raw row farthest from the anchor.
const historyRows = async (
  internals: IWhatsAppInternals,
  chat: IPageChat,
  anchor: WhatsAppHistoryAnchor | null,
  count: number
): Promise<IHistoryPage | 'unknown-anchor'> => {
  if (anchor === null) {
    const newest = internals.newest(chat)
    if (newest === null) {
      return { rows: [], next: null }
    }

    // The newest message is in the page and so in the answer; count rows before it are count - 1 kept and one to
    // look ahead.
    const older = await internals.rowsAround('before', rowKeyOf(chat, anchorAt('before', newest)), count)
    if (older === null) {
      return 'unknown-anchor'
    }

    const hasMore = older.length === count
    const rows = [...older.slice(hasMore ? 1 : 0), newest]

    return { rows, next: hasMore ? anchorAt('before', farthestKept('before', rows)) : null }
  }

  const found = await internals.rowsAround(anchor.direction, rowKeyOf(chat, anchor), count + 1)
  if (found === null) {
    return 'unknown-anchor'
  }

  const rows = keptRows(anchor.direction, found, count)
  const hasMore = found.length > count

  return { rows, next: hasMore ? anchorAt(anchor.direction, farthestKept(anchor.direction, rows)) : null }
}

// The messages a read answers: the kept rows of a reported type, oldest first.
const messagesOf = (chat: string, rows: readonly IPageRow[]): WhatsAppMessage[] =>
  rows.flatMap(({ id, fromMe, type, timestamp, text }) =>
    isReportedType(type) ? [{ chat, id, timestamp, fromMe, type, text }] : []
  )

// The capture of one page. post sends what the observer tells its relays unasked: { kind: 'capture', capture } on
// every change of the state, and { kind: 'message', account, message } for each reported message, which the entry
// holds as a frame until a relay reports it taken (capture-handshake.ts).
export const whatsappCapture = (post: (message: object) => void, host: ICaptureHost): IWhatsAppCapture => {
  const store = create(null) as Record<string, IPreparedEntry>
  let capture: WhatsAppCapture = { state: 'loading' }
  let page: IWhatsAppInternals | null = null
  let stopMessages: (() => void) | null = null

  const remove = (messageId: string): void => {
    const entry = store[messageId]
    if (entry !== undefined) {
      host.clearTimer(entry.timer)
      deleteProperty(store, messageId)
    }
  }

  const sweepExpired = (now: number): void => {
    for (const messageId of keys(store)) {
      const entry = store[messageId]
      if (entry !== undefined && now - entry.keptAt >= PREPARED_SEND_WINDOW_MS) {
        host.clearTimer(entry.timer)
        deleteProperty(store, messageId)
      }
    }
  }

  // Every entry was prepared for the account the capture is ready as, so the store empties whenever it stops being
  // ready as that account (U2-R21).
  const setCapture = (next: WhatsAppCapture): void => {
    if (isSameCapture(capture, next)) {
      return
    }

    if (readyWid(next) !== readyWid(capture)) {
      for (const messageId of keys(store)) {
        remove(messageId)
      }
    }

    capture = next
    post({ kind: 'capture', capture: next })
  }

  // A broken capture stays broken until the page reloads: the observer's closure ends with the document.
  const breakWith = (drift: WhatsAppDrift): void => {
    if (capture.state === 'broken') {
      return
    }

    const stop = stopMessages
    stopMessages = null
    setCapture({ state: 'broken', drift })

    try {
      stop?.()
    } catch {
      // The message listener reports nothing once the capture is broken, so a page that cannot remove it changes
      // nothing.
    }
  }

  const internalsOf = (): IWhatsAppInternals => {
    if (page === null) {
      throw new Error('The WhatsApp capture has not started')
    }

    return page
  }

  // The first of needs whose check fails after a page call threw, or the drift the call reported itself.
  const driftAfter = (error: unknown, needs: readonly WhatsAppNeed[]): WhatsAppDrift | null => {
    if (error instanceof WhatsAppDriftError) {
      return error.drift
    }

    for (const need of needs) {
      const drift = internalsOf().check(need)
      if (drift !== null) {
        return drift
      }
    }

    return null
  }

  const failure = (error: unknown, needs: readonly WhatsAppNeed[]): Error => {
    const drift = driftAfter(error, needs)
    if (drift === null) {
      return new PageCallFailedError()
    }

    breakWith(drift)

    return new CaptureBrokenError()
  }

  // A page call: a throw re-runs the checks of the needs it uses, and becomes CaptureBrokenError when one fails,
  // PageCallFailedError when all pass.
  const attempt = <TResult>(
    needs: readonly WhatsAppNeed[],
    run: (internals: IWhatsAppInternals) => TResult
  ): TResult => {
    const internals = internalsOf()

    try {
      return run(internals)
    } catch (error) {
      throw failure(error, needs)
    }
  }

  const attemptAsync = async <TResult>(
    needs: readonly WhatsAppNeed[],
    run: (internals: IWhatsAppInternals) => Promise<TResult>
  ): Promise<TResult> => {
    const internals = internalsOf()

    try {
      return await run(internals)
    } catch (error) {
      throw failure(error, needs)
    }
  }

  const commandCall: PageCall = (need, run) => attempt([need], run)

  // Outside a command nobody can be answered, so a page call that throws breaks the capture with its need's code,
  // whether or not the need's check still passes: a function that throws is not the function the check found
  // (U2-R52). The throw ends the work for that event.
  const unaskedCall: PageCall = (need, run) => {
    const internals = internalsOf()

    try {
      return run(internals)
    } catch {
      breakWith(need)

      throw new CaptureBrokenError()
    }
  }

  // The state from the page's users and connection (U2-R2, U2-R16): ready with the lid user, broken with no-lid-user
  // when only a phone-number user exists, signed-out with neither. The socket's state never decides signed-out. Once
  // it returns, the capture is what this call read, or broken.
  const recompute = (call: PageCall): void => {
    if (page === null || capture.state === 'broken') {
      return
    }

    const { lid, hasPnUser } = call('signed-in-user', (internals) => internals.signedIn())
    if (lid === null) {
      if (hasPnUser) {
        breakWith('no-lid-user')
      } else {
        setCapture({ state: 'signed-out' })
      }

      return
    }

    const { isConnected, hasSynced } = call('connection', (internals) => internals.connection())
    setCapture({ state: 'ready', account: { wid: lid }, isConnected, hasSynced })
  }

  // Runs work started by the page, not by a command (a message, a connection change, the start): a page call that
  // throws in it has already broken the capture.
  const unasked = (run: (call: PageCall) => void): void => {
    try {
      run(unaskedCall)
    } catch (error) {
      if (!(error instanceof CaptureBrokenError)) {
        throw error
      }
    }
  }

  const passesChecks = (internals: IWhatsAppInternals): boolean => {
    for (const need of WHATSAPP_NEEDS) {
      const drift = internals.check(need)
      if (drift !== null) {
        breakWith(drift)

        return false
      }
    }

    return true
  }

  // The event rule (U2-R14, design C.3): a new message (isNewMsg true; messages the page loads or syncs never carry
  // it) of a direct chat, of a reported type, while the capture is ready, under the account read successfully while
  // this message is handled (U2-R52).
  const onMessage = (message: IPageMessage): void => {
    const { chat, id, timestamp, fromMe, type, text } = message
    if (!message.isNewMsg || !message.isDirect || !isReportedType(type)) {
      return
    }

    unasked((call) => {
      recompute(call)
      if (capture.state === 'ready') {
        post({
          kind: 'message',
          account: { wid: capture.account.wid },
          message: { chat, id, timestamp, fromMe, type, text },
        })
      }
    })
  }

  const onConnectionChange = (): void => {
    if (page === null || capture.state === 'broken' || !passesChecks(page)) {
      return
    }

    unasked(recompute)
  }

  // Recomputes the state for a command: the capture when it is ready as account, else null. A broken capture
  // answers the command broken.
  const readyAs = (account: WhatsAppAccount): ReadyCapture | null => {
    recompute(commandCall)

    const current = capture
    if (current.state === 'broken') {
      throw new CaptureBrokenError()
    }

    return current.state === 'ready' && current.account.wid === account.wid ? current : null
  }

  const prepare = async (
    { account, chat: wid, text }: WhatsAppBridgeParams<'whatsappSendPrepare'>,
    deadline: number
  ): Promise<WhatsAppBridgeResult<'whatsappSendPrepare'>> => {
    const ready = readyAs(account)
    if (ready === null) {
      return refused('other-account')
    }

    if (!ready.isConnected) {
      return refused('not-connected')
    }

    const chat = attempt(['collections'], (internals) => internals.chat(wid))
    if (chat === null) {
      return refused('no-chat')
    }

    if (chat.wid !== wid) {
      return refused('chat-mismatch')
    }

    if (!chat.isDirect) {
      return refused('not-direct-chat')
    }

    if (host.now() >= deadline) {
      return refused('deadline-passed')
    }

    const prepared = await attemptAsync(['send'], (internals) => internals.prepareText(chat, text))

    // The page's account, its connection and the caller's deadline may have changed while the message was built; an
    // entry whose id the caller can no longer receive could never be committed.
    const after = readyAs(account)
    if (after === null) {
      return refused('other-account')
    }

    if (!after.isConnected) {
      return refused('not-connected')
    }

    const now = host.now()
    if (now >= deadline) {
      return refused('deadline-passed')
    }

    sweepExpired(now)
    store[prepared.messageId] = {
      account: account.wid,
      chat: wid,
      prepared,
      keptAt: now,
      timer: host.setTimer(() => {
        remove(prepared.messageId)
      }, PREPARED_SEND_WINDOW_MS),
    }

    return { outcome: 'prepared', messageId: prepared.messageId, token: host.token }
  }

  // From the hand-off on, the answer is sent or unconfirmed and nothing else (U2-R23); drift found then breaks the
  // capture through its state, apart from the answer.
  const afterHandOff = (result: PageSendResult, timestamp: number): WhatsAppBridgeResult<'whatsappSendCommit'> => {
    switch (result) {
      case 'ok':
        return { outcome: 'sent', timestamp }

      case 'not-ok':
        return unconfirmed('result-not-ok')

      case 'result-unreadable':
        breakWith('send')

        return unconfirmed(result)

      case 'send-rejected':
      case 'result-rejected': {
        const drift = internalsOf().check('send')
        if (drift !== null) {
          breakWith(drift)
        }

        return unconfirmed(result)
      }
    }
  }

  // Everything that can refuse is checked before the hand-off; then the entry is removed, the message's time stamped
  // and the message handed to the page's sender, with nothing asynchronous between (U2-R4, U2-R22, U2-R23). A stamp
  // whose write failed is the send drift, found before the hand-off, so the commit answers broken (U2-R55).
  const commit = async (
    { account, chat: wid, messageId }: WhatsAppBridgeParams<'whatsappSendCommit'>,
    deadline: number
  ): Promise<WhatsAppBridgeResult<'whatsappSendCommit'>> => {
    const ready = readyAs(account)
    if (ready === null) {
      return refused('other-account')
    }

    const entry = store[messageId]
    if (entry === undefined || entry.account !== account.wid) {
      return refused('unknown-message')
    }

    // A timer that fired late, or not yet: the entry is past its window all the same.
    if (host.now() - entry.keptAt >= PREPARED_SEND_WINDOW_MS) {
      remove(messageId)

      return refused('unknown-message')
    }

    if (entry.chat !== wid) {
      return refused('chat-mismatch')
    }

    if (!ready.isConnected) {
      return refused('not-connected')
    }

    const chat = attempt(['collections'], (internals) => internals.chat(wid))
    if (chat === null) {
      return refused('no-chat')
    }

    if (chat.wid !== wid) {
      return refused('chat-mismatch')
    }

    if (host.now() >= deadline) {
      return refused('deadline-passed')
    }

    remove(messageId)
    const timestamp = attempt(['clock'], (internals) => internals.stamp(entry.prepared))
    const result = await internalsOf().send(chat, entry.prepared)

    return afterHandOff(result, timestamp)
  }

  const history = async (
    { account, chat: wid, anchor, count }: WhatsAppBridgeParams<'whatsappHistory'>,
    deadline: number
  ): Promise<WhatsAppBridgeResult<'whatsappHistory'>> => {
    if (readyAs(account) === null) {
      return refused('other-account')
    }

    const chat = attempt(['collections'], (internals) => internals.chat(wid))
    if (chat === null) {
      return refused('no-chat')
    }

    if (chat.wid !== wid) {
      return refused('chat-mismatch')
    }

    if (!chat.isDirect) {
      return refused('not-direct-chat')
    }

    if (host.now() >= deadline) {
      return refused('deadline-passed')
    }

    const read = await attemptAsync(['chat-shape', 'message-shape', 'message-key', 'history'], (internals) =>
      historyRows(internals, chat, anchor, count)
    )

    if (read === 'unknown-anchor') {
      return refused('unknown-anchor')
    }

    return { outcome: 'read', messages: messagesOf(chat.wid, read.rows), next: read.next }
  }

  const contact = (
    { account, wid }: WhatsAppBridgeParams<'whatsappContact'>,
    deadline: number
  ): WhatsAppBridgeResult<'whatsappContact'> => {
    if (readyAs(account) === null) {
      return refused('other-account')
    }

    if (apply(execPattern, DIRECT_CHAT_WID_PATTERN, [wid]) === null) {
      return refused('not-direct-chat')
    }

    if (host.now() >= deadline) {
      return refused('deadline-passed')
    }

    const found = attempt(['collections', 'contact'], (internals) => internals.contact(wid))
    if (found === null) {
      return refused('unknown-contact')
    }

    return { outcome: 'read', name: found.name, isMe: found.isMe }
  }

  const run = async ({ command, deadline }: IReadCommand): Promise<object> => {
    switch (command.method) {
      case 'whatsappSendPrepare':
        return prepare(command.params, deadline)

      case 'whatsappSendCommit':
        return commit(command.params, deadline)

      case 'whatsappHistory':
        return history(command.params, deadline)

      case 'whatsappContact':
        return contact(command.params, deadline)
    }
  }

  // A command's answer, or null for failed. A commit's page call that failed before the hand-off is its refusal
  // page-failed, never failed (S.8).
  const answerOf = async (read: IReadCommand): Promise<object | null> => {
    try {
      return await run(read)
    } catch (error) {
      if (error instanceof CaptureBrokenError && capture.state === 'broken') {
        return { outcome: 'broken', drift: capture.drift }
      }

      if (error instanceof PageCallFailedError) {
        return read.command.method === 'whatsappSendCommit' ? refused('page-failed') : null
      }

      throw error
    }
  }

  return {
    state: () => capture,
    start: (internals) => {
      page = internals
      if (!passesChecks(internals)) {
        return
      }

      unasked((call) => {
        recompute(call)
        if (capture.state === 'broken') {
          return
        }

        stopMessages = call('collections', (pageInternals) => pageInternals.onMessage(onMessage, breakWith))
        call('connection', (pageInternals) => {
          pageInternals.onConnectionChange(onConnectionChange)
        })
      })
    },
    command: (raw, answer) => {
      const read = readCommand(raw)
      if (read === null) {
        return
      }

      void answerOf(read).then((result) => {
        answer(result === null ? { kind: 'failed', id: read.id } : { kind: 'answer', id: read.id, answer: result })
      })
    },
  }
}
