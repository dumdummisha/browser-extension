import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { COMPONENT_VERSION } from '../host/component-version.js'
import type { BridgeEvent } from '../protocol/events.js'
import type { ConnectionState } from '../protocol/handshake.js'
import type { BridgeIncompatible, RelayMessage } from '../protocol/messages.js'
import {
  chunkCount,
  chunkRange,
  type PreparedUpload,
  SLACK_BRIDGE_METHODS,
  type SlackAccount,
  type SlackAnswer,
  type SlackBridgeMethod,
  type SlackBridgeParams,
  type SlackMethod,
  type SlackStatus,
} from '../protocol/slack.js'
import {
  TAB_BRIDGE_METHODS,
  type TabBridgeMethod,
  type TabBridgeParams,
  type TabBridgeResult,
} from '../protocol/tab.js'
import { BridgeError, RelayConnection } from './relay-connection.js'

export { BridgeError, BridgeIncompatibleError } from './relay-connection.js'

// A client of the relay's socket (src/host/relay.ts): the app's Slack calls, file transfers and, once it listens, the
// extension's events and status, and the browser tools' tab commands. One connection carries all of it, once its
// handshake completed (relay-connection.ts); while the client listens, it connects again after the relay went away
// (the browser quit, the extension reloaded) and sends listen again once ready, so it stays the listener. A client that
// does not listen connects again on its next request.

// The default request timeout: an upload's bytes go to Slack within one request.
export const REQUEST_TIMEOUT_MS = 120_000
export const RECONNECT_DELAY_MS = 2_000

// Takes one event. The client acknowledges it only once the promise resolves, which the app makes happen only after it
// committed the event; a rejection leaves it unacknowledged, and the extension forwards it again.
export type EventHandler = (event: BridgeEvent) => Promise<void>
// Every status snapshot the extension pushes, and undefined each time a ready connection to the relay stops being
// ready (it dropped, or turned out incompatible).
export type StatusListener = (status: SlackStatus | undefined) => void

// The bridge's own state, apart from Slack's: the state of the client's current connection (closed when it has none),
// and the latest incompatibility it learned, kept through disconnects until a later handshake completes.
export interface IBridgeState {
  readonly connection: ConnectionState
  readonly incompatibility: BridgeIncompatible | null
}

export type BridgeStateListener = (state: IBridgeState) => void
export type UploadShare = Omit<SlackBridgeParams<'slackUploadFinish'>, 'account'>

export interface IBridgeClientOptions {
  readonly socketPath: string
  readonly requestTimeoutMs: number
  readonly reconnectDelayMs: number
  // Where an event the handler rejected is reported; it stays unacknowledged.
  readonly onHandlerError: (event: BridgeEvent, error: unknown) => void
}

type BridgeMethod = SlackBridgeMethod | TabBridgeMethod

export class BridgeClient {
  private connection: RelayConnection | null = null
  private handler: EventHandler | null = null
  private latestStatus: SlackStatus | undefined
  private incompatibility: BridgeIncompatible | null = null
  private readonly statusListeners = new Set<StatusListener>()
  private readonly bridgeStateListeners = new Set<BridgeStateListener>()
  private events: Promise<void> = Promise.resolve()
  private reconnectTimer: NodeJS.Timeout | undefined
  private nextId = 1
  private isClosed = false

  constructor(private readonly options: IBridgeClientOptions) {}

  // Starts taking events. The client connects in the background and keeps connecting while the relay is away; the
  // status stream says when it is connected. Each connection's handshake is waited for within the client's request
  // timeout, as a request would wait for it.
  public listen(handler: EventHandler): void {
    const connection = this.current()
    this.handler = handler

    if (connection.state === 'ready') {
      connection.send({ type: 'listen' })
    } else {
      this.awaitListenerReadiness(connection)
    }
  }

  // The latest status snapshot; undefined while the client is not connected or has had none since it connected.
  public status(): SlackStatus | undefined {
    return this.latestStatus
  }

  public onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)

    return () => {
      this.statusListeners.delete(listener)
    }
  }

  public bridgeState(): IBridgeState {
    return { connection: this.connection?.state ?? 'closed', incompatibility: this.incompatibility }
  }

  // Every change of the bridge's own state: a connection that became ready, turned out incompatible or closed, and a
  // caller's deadline that passed before the handshake completed.
  public onBridgeState(listener: BridgeStateListener): () => void {
    this.bridgeStateListeners.add(listener)

    return () => {
      this.bridgeStateListeners.delete(listener)
    }
  }

  // signal, on this and the other Slack methods: aborting it abandons the call, and only that call. It rejects at once,
  // and once the cancel reaches the extension, nothing more of the call is handed to a Slack page; what was already
  // handed over still goes out.
  public async call(
    account: SlackAccount,
    method: SlackMethod,
    params: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ): Promise<SlackAnswer> {
    const { slackCall } = SLACK_BRIDGE_METHODS
    const answer = await this.request('slackCall', slackCall.params.parse({ account, method, params }), signal)

    return slackCall.result.parse(answer)
  }

  // A private file, pulled from the extension chunk by chunk as the stream is read.
  public async download(account: SlackAccount, url: string, signal?: AbortSignal): Promise<Readable> {
    const { slackDownload } = SLACK_BRIDGE_METHODS

    const { downloadId, byteLength } = slackDownload.result.parse(
      await this.request('slackDownload', slackDownload.params.parse({ account, url }), signal)
    )

    return Readable.from(this.downloadChunks(downloadId, byteLength, signal), { objectMode: false })
  }

  // The first upload step: the bytes go to Slack, which answers the file's id; nobody sees the file until finishUpload.
  public async prepareUpload(
    account: SlackAccount,
    filename: string,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<PreparedUpload> {
    const { slackUploadChunk, slackUploadPrepare } = SLACK_BRIDGE_METHODS
    const uploadId = randomUUID()

    for (let index = 0; index < chunkCount(bytes.byteLength); index += 1) {
      const { start, end } = chunkRange(index, bytes.byteLength)
      const data = Buffer.from(bytes.subarray(start, end)).toString('base64')

      slackUploadChunk.result.parse(
        await this.request('slackUploadChunk', slackUploadChunk.params.parse({ uploadId, index, data }), signal)
      )
    }

    const params = slackUploadPrepare.params.parse({ account, uploadId, filename, byteLength: bytes.byteLength })

    return slackUploadPrepare.result.parse(await this.request('slackUploadPrepare', params, signal))
  }

  // The second upload step: shares exactly the prepared file, and answers Slack's completion answer as it is.
  public async finishUpload(account: SlackAccount, share: UploadShare, signal?: AbortSignal): Promise<SlackAnswer> {
    const { slackUploadFinish } = SLACK_BRIDGE_METHODS
    const params = slackUploadFinish.params.parse({ account, ...share })

    return slackUploadFinish.result.parse(await this.request('slackUploadFinish', params, signal))
  }

  // A tab command of the browser tools, with its result checked against the protocol.
  public async tab<TMethod extends TabBridgeMethod>(
    method: TMethod,
    params: TabBridgeParams<TMethod>
  ): Promise<TabBridgeResult<TMethod>> {
    const { params: paramsSchema, result } = TAB_BRIDGE_METHODS[method]

    return result.parse(await this.request(method, paramsSchema.parse(params)))
  }

  // The app a client brings to the front to raise the browser; null when the native host could not tell. It waits for
  // the connection's handshake within the client's request timeout.
  public async browserApp(): Promise<string | null> {
    const connection = await this.ready(Date.now() + this.options.requestTimeoutMs, undefined, 'browserApp')

    return connection.browserApp
  }

  public close(): Promise<void> {
    this.isClosed = true
    this.handler = null
    clearTimeout(this.reconnectTimer)
    this.connection?.destroy()
    this.connection = null

    return Promise.resolve()
  }

  private async *downloadChunks(downloadId: string, byteLength: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const { slackDownloadChunk } = SLACK_BRIDGE_METHODS

    for (let index = 0; index < chunkCount(byteLength); index += 1) {
      const params = slackDownloadChunk.params.parse({ downloadId, index })
      const { data } = slackDownloadChunk.result.parse(await this.request('slackDownloadChunk', params, signal))
      yield Buffer.from(data, 'base64')
    }
  }

  // Resolves with the extension's result. Rejects when no answer came: the connection dropped or turned out
  // incompatible, the call timed out, the caller abandoned it, or the extension answered an error; for a write, the
  // outcome is then unknown. The deadline is set before the connection is, and bounds the handshake, the request and
  // its reply alike: the request carries it, so the extension sends nothing of it to Slack once the client stopped
  // waiting; an abandoned call is cancelled at the extension.
  private async request(method: BridgeMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const deadline = Date.now() + this.options.requestTimeoutMs

    if (signal?.aborted === true) {
      throw new BridgeError(`The caller abandoned ${method} before it was sent`)
    }

    const connection = await this.ready(deadline, signal, method)

    // Nothing asynchronous runs from here until the request is sent and registered, so the signal, the deadline and
    // the connection's state are checked where they hold for the send itself.
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new BridgeError(`The caller abandoned ${method} before it was sent`))
        return
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        reject(new BridgeError(`The caller's deadline passed before ${method} was sent`))
        return
      }

      const id = this.nextId

      try {
        connection.send({ type: 'request', id, method, params, deadline })
      } catch (error) {
        reject(error instanceof Error ? error : new BridgeError(String(error)))
        return
      }

      this.nextId += 1

      const abandon = (): void => {
        connection.calls.delete(id)
        clearTimeout(timer)
        connection.send({ type: 'cancel', id })
        reject(new BridgeError(`The caller abandoned ${method}`))
      }

      const timer = setTimeout(() => {
        connection.calls.delete(id)
        signal?.removeEventListener('abort', abandon)
        reject(new BridgeError(`The extension did not answer ${method} within ${this.options.requestTimeoutMs}ms`))
      }, remainingMs)

      const release = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abandon)
      }

      connection.calls.set(id, { method, resolve, reject, release })
      signal?.addEventListener('abort', abandon, { once: true })
    })
  }

  // The current connection once it is ready, waited for within deadline and signal.
  private async ready(deadline: number, signal: AbortSignal | undefined, what: string): Promise<RelayConnection> {
    const connection = this.current()
    await connection.whenReady(deadline, signal, what)

    return connection
  }

  // The connection a caller uses: the current one unless it closed, else a new one. An incompatible connection stays
  // current, so callers get its diagnostic at once until the relay ends it.
  private current(): RelayConnection {
    if (this.isClosed) {
      throw new BridgeError('The bridge client is closed')
    }

    if (this.connection === null || this.connection.state === 'closed') {
      this.connection = new RelayConnection(this.options.socketPath, COMPONENT_VERSION, {
        onMessage: (connection, message) => this.receive(connection, message),
        onReady: (connection) => this.connectionReady(connection),
        onIncompatible: (diagnostic) => this.connectionIncompatible(diagnostic),
        onClose: (connection, wasReady) => this.connectionClosed(connection, wasReady),
      })
    }

    return this.connection
  }

  // The listener's wait for a connection's handshake. Its failure is the connection's to report; once ready, the
  // connection sends listen (connectionReady).
  private awaitListenerReadiness(connection: RelayConnection): void {
    connection.whenReady(Date.now() + this.options.requestTimeoutMs, undefined, 'listen').catch(() => undefined)
  }

  private connectionReady(connection: RelayConnection): void {
    this.incompatibility = null

    if (this.handler !== null) {
      connection.send({ type: 'listen' })
    }

    this.publishBridgeState()
  }

  // Only a ready connection brings status, so a status still held came over the connection that just failed.
  private connectionIncompatible(diagnostic: BridgeIncompatible): void {
    this.incompatibility = diagnostic

    if (this.latestStatus !== undefined) {
      this.publishStatus(undefined)
    }

    this.publishBridgeState()
  }

  private connectionClosed(connection: RelayConnection, wasReady: boolean): void {
    if (this.connection === connection) {
      this.connection = null
    }

    this.disconnected(wasReady)
    this.publishBridgeState()
  }

  private receive(connection: RelayConnection, message: RelayMessage): void {
    switch (message.type) {
      case 'reply': {
        const call = connection.calls.get(message.id)
        if (call === undefined) {
          return
        }

        connection.calls.delete(message.id)
        call.release()

        if ('error' in message) {
          call.reject(new BridgeError(`The extension failed ${call.method}: ${message.error}`))
        } else {
          call.resolve(message.result)
        }

        return
      }
      case 'event': {
        const next = this.events.then(() => this.deliver(connection, message))
        this.events = next.catch(() => undefined)
        void next
        return
      }
      case 'status':
        this.publishStatus(message)
    }
  }

  // Events are handled one at a time, in the order they came. The ack goes back on the connection that brought the
  // event while it is still ready; if it closed or turned out incompatible meanwhile, the extension forwards the event
  // again to a compatible listener, and the app's commit takes the repeat.
  private async deliver(connection: RelayConnection, event: BridgeEvent): Promise<void> {
    const { handler } = this
    if (handler === null) {
      return
    }

    try {
      await handler(event)
    } catch (error) {
      this.options.onHandlerError(event, error)
      return
    }

    if (connection.state === 'ready') {
      connection.send({ type: 'ack', id: event.id })
    }
  }

  private disconnected(wasConnected: boolean): void {
    if (wasConnected) {
      this.publishStatus(undefined)
    }

    if (this.handler !== null && !this.isClosed) {
      this.reconnectTimer = setTimeout(() => this.reconnect(), this.options.reconnectDelayMs)
    }
  }

  // A connection a request opened meanwhile already sent listen once it became ready.
  private reconnect(): void {
    if (this.handler === null || this.isClosed) {
      return
    }

    const connection = this.current()
    if (connection.state === 'awaiting-hello') {
      this.awaitListenerReadiness(connection)
    }
  }

  private publishStatus(status: SlackStatus | undefined): void {
    this.latestStatus = status

    for (const listener of this.statusListeners) {
      listener(status)
    }
  }

  private publishBridgeState(): void {
    const state = this.bridgeState()

    for (const listener of this.bridgeStateListeners) {
      listener(state)
    }
  }
}
