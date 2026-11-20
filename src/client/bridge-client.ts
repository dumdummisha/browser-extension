import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import type { z } from 'zod'
import { createLineReader, encodeLine } from '../protocol/framing.js'
import { type ClientMessage, type RelayMessage, RelayMessageSchema } from '../protocol/messages.js'
import {
  chunkCount,
  chunkRange,
  type PreparedUpload,
  SLACK_BRIDGE_METHODS,
  type SlackAccount,
  type SlackAnswer,
  type SlackBridgeMethod,
  type SlackBridgeParams,
  type SlackEvent,
  type SlackMethod,
  type SlackStatus,
} from '../protocol/slack.js'
import {
  TAB_BRIDGE_METHODS,
  type TabBridgeMethod,
  type TabBridgeParams,
  type TabBridgeResult,
} from '../protocol/tab.js'

// A client of the relay's socket (src/host/relay.ts): the app's Slack calls, file transfers and, once it listens, the
// extension's events and status, and the browser tools' tab commands. One connection carries all of it; while the
// client listens, it connects again after the relay went away (the browser quit, the extension reloaded) and sends
// listen again, so it stays the listener. A client that does not listen connects again on its next request.

// The default request timeout: an upload's bytes go to Slack within one request.
export const REQUEST_TIMEOUT_MS = 120_000
export const RECONNECT_DELAY_MS = 2_000

export class BridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BridgeError'
  }
}

// Takes one event. The client acknowledges it only once the promise resolves, which the app makes happen only after it
// committed the event; a rejection leaves it unacknowledged, and the extension forwards it again.
export type EventHandler = (event: SlackEvent) => Promise<void>
// Every status snapshot the extension pushes, and undefined each time the connection to the relay drops.
export type StatusListener = (status: SlackStatus | undefined) => void
export type UploadShare = Omit<SlackBridgeParams<'slackUploadFinish'>, 'account'>

export interface IBridgeClientOptions {
  readonly socketPath: string
  readonly requestTimeoutMs: number
  readonly reconnectDelayMs: number
  // Where an event the handler rejected is reported; it stays unacknowledged.
  readonly onHandlerError: (event: SlackEvent, error: unknown) => void
}

type BridgeMethod = SlackBridgeMethod | TabBridgeMethod

interface IPendingCall {
  readonly method: BridgeMethod
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  // Stops the call's timer and stops listening to its caller's signal, once the call is answered or its connection
  // closed.
  readonly release: () => void
}

interface IConnection {
  readonly socket: Socket
  // The browser's .app bundle, which the native host reads from its parent process; set by the relay's hello.
  browserApp: string | null
  readonly calls: Map<number, IPendingCall>
}

const parseWith = <TSchema extends z.ZodType>(schema: TSchema, value: unknown): z.output<TSchema> => schema.parse(value)

export class BridgeClient {
  private connection: Promise<IConnection> | null = null
  private handler: EventHandler | null = null
  private latestStatus: SlackStatus | undefined
  private readonly statusListeners = new Set<StatusListener>()
  private events: Promise<void> = Promise.resolve()
  private reconnectTimer: NodeJS.Timeout | undefined
  private nextId = 1
  private isClosed = false

  constructor(private readonly options: IBridgeClientOptions) {}

  // Starts taking events. The client connects in the background and keeps connecting while the relay is away; the
  // status stream says when it is connected.
  public listen(handler: EventHandler): void {
    this.handler = handler
    this.sendListen()
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

    return parseWith(result, await this.request(method, parseWith(paramsSchema, params)))
  }

  // The app a client brings to the front to raise the browser; null when the native host could not tell.
  public async browserApp(): Promise<string | null> {
    return (await this.connect()).browserApp
  }

  public async close(): Promise<void> {
    this.isClosed = true
    this.handler = null
    clearTimeout(this.reconnectTimer)
    const current = this.connection
    this.connection = null

    // A connection that never opened has nothing to close.
    const opened = await current?.catch(() => null)
    opened?.socket.destroy()
  }

  private async *downloadChunks(downloadId: string, byteLength: number, signal?: AbortSignal): AsyncGenerator<Buffer> {
    const { slackDownloadChunk } = SLACK_BRIDGE_METHODS
    for (let index = 0; index < chunkCount(byteLength); index += 1) {
      const params = slackDownloadChunk.params.parse({ downloadId, index })
      const { data } = slackDownloadChunk.result.parse(await this.request('slackDownloadChunk', params, signal))
      yield Buffer.from(data, 'base64')
    }
  }

  // Resolves with the extension's result. Rejects when no answer came: the connection dropped, the call timed out, the
  // caller abandoned it, or the extension answered an error; for a write, the outcome is then unknown. The request
  // carries its deadline, the moment the timeout fires, so the extension sends nothing of it to Slack once the client
  // stopped waiting; an abandoned call is cancelled at the extension.
  private async request(method: BridgeMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const { socket, calls } = await this.connect()
    if (signal?.aborted === true) {
      throw new BridgeError(`The caller abandoned ${method} before it was sent`)
    }

    const id = this.nextId
    this.nextId += 1
    const deadline = Date.now() + this.options.requestTimeoutMs

    return new Promise((resolve, reject) => {
      const abandon = (): void => {
        calls.delete(id)
        clearTimeout(timer)
        this.write(socket, { type: 'cancel', id })
        reject(new BridgeError(`The caller abandoned ${method}`))
      }
      const timer = setTimeout(() => {
        calls.delete(id)
        signal?.removeEventListener('abort', abandon)
        reject(new BridgeError(`The extension did not answer ${method} within ${this.options.requestTimeoutMs}ms`))
      }, this.options.requestTimeoutMs)
      const release = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abandon)
      }
      calls.set(id, { method, resolve, reject, release })
      signal?.addEventListener('abort', abandon, { once: true })
      this.write(socket, { type: 'request', id, method, params, deadline })
    })
  }

  private write(socket: Socket, message: ClientMessage): void {
    socket.write(encodeLine(message))
  }

  // Connection failures are left to the close handler, which tries again while the client listens.
  private sendListen(): void {
    void this.connect().then(
      ({ socket }) => this.write(socket, { type: 'listen' }),
      () => undefined
    )
  }

  private connect(): Promise<IConnection> {
    if (this.isClosed) {
      return Promise.reject(new BridgeError('The bridge client is closed'))
    }

    if (this.connection === null) {
      const opening = this.open(() => {
        if (this.connection === opening) {
          this.connection = null
        }
      })
      this.connection = opening
    }

    return this.connection
  }

  private open(onClose: () => void): Promise<IConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.options.socketPath)
      const connection: IConnection = { socket, browserApp: null, calls: new Map() }
      const state: { isGreeted: boolean; failure?: Error } = { isGreeted: false }
      const readLines = createLineReader((raw) => {
        const message = RelayMessageSchema.parse(raw)
        if (message.type === 'hello' && !state.isGreeted) {
          state.isGreeted = true
          connection.browserApp = message.browserApp
          resolve(connection)
          return
        }

        this.receive(connection, message)
      })

      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        try {
          readLines(chunk)
        } catch (error) {
          socket.destroy(new BridgeError('The relay sent a message this client cannot read', { cause: error }))
        }
      })
      socket.on('error', (error) => {
        state.failure = error
      })
      socket.on('close', () => {
        const error = state.isGreeted
          ? new BridgeError('The browser bridge closed (the browser quit or the extension reloaded)', {
              cause: state.failure,
            })
          : new BridgeError(
              `Could not reach the browser bridge at ${this.options.socketPath}. Is the browser running with the ` +
                'Misha extension loaded and its native host installed?',
              { cause: state.failure }
            )
        reject(error)
        onClose()
        for (const call of connection.calls.values()) {
          call.release()
          call.reject(error)
        }

        connection.calls.clear()
        this.disconnected(state.isGreeted)
      })
    })
  }

  private receive({ socket, calls }: IConnection, message: RelayMessage): void {
    switch (message.type) {
      case 'hello':
        throw new BridgeError('The relay greeted this connection twice')
      case 'reply': {
        const call = calls.get(message.id)
        if (call === undefined) {
          return
        }

        calls.delete(message.id)
        call.release()
        if ('error' in message) {
          call.reject(new BridgeError(`The extension failed ${call.method}: ${message.error}`))
        } else {
          call.resolve(message.result)
        }

        return
      }
      case 'event': {
        const next = this.events.then(() => this.deliver(socket, message))
        this.events = next.catch(() => undefined)
        void next
        return
      }
      case 'status':
        this.publishStatus(message)
    }
  }

  // Events are handled one at a time, in the order they came. The ack goes back on the connection that brought the
  // event; if it closed meanwhile, the extension forwards the event again and the app's commit takes the repeat.
  private async deliver(socket: Socket, event: SlackEvent): Promise<void> {
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

    if (!socket.destroyed) {
      this.write(socket, { type: 'ack', id: event.id })
    }
  }

  private disconnected(wasConnected: boolean): void {
    if (wasConnected) {
      this.publishStatus(undefined)
    }

    if (this.handler !== null && !this.isClosed) {
      this.reconnectTimer = setTimeout(() => this.sendListen(), this.options.reconnectDelayMs)
    }
  }

  private publishStatus(status: SlackStatus | undefined): void {
    this.latestStatus = status
    for (const listener of this.statusListeners) {
      listener(status)
    }
  }
}
