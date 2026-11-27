import { createConnection, type Socket } from 'node:net'
import { createLineReader, encodeLine } from '../protocol/framing.js'
import {
  type ConnectionState,
  type IHandshakeEnd,
  incompatibility,
  incompatibilityMessage,
  isHello,
  readHello,
} from '../protocol/handshake.js'
import {
  type BridgeIncompatible,
  type ClientHello,
  type ClientMessage,
  HostHelloSchema,
  PROTOCOL_REVISION,
  type RelayControl,
  RelayControlSchema,
  type RelayMessage,
  RelayMessageSchema,
} from '../protocol/messages.js'

export class BridgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BridgeError'
  }
}

// The bridge cannot be used until both ends of the failing leg are brought to one protocol revision; diagnostic says
// which leg failed, why, and the recovery (protocol handshake.ts RECOVERY_TEXT).
export class BridgeIncompatibleError extends BridgeError {
  constructor(public readonly diagnostic: BridgeIncompatible) {
    super(incompatibilityMessage(diagnostic))
    this.name = 'BridgeIncompatibleError'
  }
}

interface IPendingCall {
  readonly method: string
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  // Stops the call's timer and stops listening to its caller's signal, once the call is answered or its connection
  // closed.
  readonly release: () => void
}

interface IRelayConnectionEvents {
  // A reply, event or status, once the connection is ready.
  readonly onMessage: (connection: RelayConnection, message: RelayMessage) => void
  readonly onReady: (connection: RelayConnection) => void
  // The connection, or a caller's wait for it, found the bridge incompatible.
  readonly onIncompatible: (diagnostic: BridgeIncompatible) => void
  readonly onClose: (connection: RelayConnection, wasReady: boolean) => void
}

type ConnectionStatus =
  | { readonly state: 'awaiting-hello' | 'ready' }
  | { readonly state: 'incompatible'; readonly diagnostic: BridgeIncompatible }
  | { readonly state: 'closed'; readonly error: BridgeError }

// One wait for the connection to become ready, bounded by its caller's own deadline and signal.
interface IReadinessWaiter {
  readonly ready: () => void
  readonly fail: (error: Error) => void
}

// One connection to the relay's socket and its handshake (protocol handshake.ts). It becomes ready once the host's
// hello agreed and the host reports a ready extension leg, and only then carries replies, events and status. Callers
// wait for that each within their own deadline: a deadline that passes first fails that caller alone with missing-hello,
// and once nobody waits on a handshake that is still incomplete, the connection closes. An incompatible connection
// fails every caller and every call with the diagnostic, carries nothing more, and stays open until the relay ends it,
// so a later caller gets the same diagnostic at once instead of a new connection.
export class RelayConnection {
  // The browser's .app bundle, which the native host reads from its parent process; set by the host's hello.
  public browserApp: string | null = null
  public readonly calls = new Map<number, IPendingCall>()
  private status: ConnectionStatus = { state: 'awaiting-hello' }
  private readonly socket: Socket
  private readonly local: IHandshakeEnd
  private readonly waiters = new Set<IReadinessWaiter>()
  private isHostAgreed = false

  constructor(
    private readonly socketPath: string,
    componentVersion: string,
    private readonly events: IRelayConnectionEvents
  ) {
    this.local = { role: 'client', componentVersion }
    this.socket = createConnection(socketPath)
    const readLines = createLineReader((raw) => this.receive(raw))
    let failure: Error | undefined

    this.socket.setEncoding('utf8')

    this.socket.on('data', (chunk: string) => {
      try {
        readLines(chunk)
      } catch (error) {
        this.socket.destroy(new BridgeError('The relay sent a message this client cannot read', { cause: error }))
      }
    })

    this.socket.on('error', (error) => {
      failure = error
    })

    this.socket.on('close', () => this.closed(failure))

    this.socket.once('connect', () => {
      const hello: ClientHello = {
        type: 'hello',
        role: 'client',
        protocolRevision: PROTOCOL_REVISION,
        componentVersion,
      }

      this.socket.write(encodeLine(hello))
    })
  }

  // Resolves once the connection is ready, and rejects when it turns out incompatible or closes, when deadline (in
  // milliseconds since the epoch) passes first, which is a missing-hello, or when signal aborts, which abandons what
  // was waiting before it was sent.
  public whenReady(deadline: number, signal: AbortSignal | undefined, what: string): Promise<void> {
    const { status } = this

    switch (status.state) {
      case 'ready':
        return Promise.resolve()
      case 'incompatible':
        return Promise.reject(new BridgeIncompatibleError(status.diagnostic))
      case 'closed':
        return Promise.reject(status.error)
      case 'awaiting-hello':
        return this.awaitReady(deadline, signal, what)
    }
  }

  public get state(): ConnectionState {
    return this.status.state
  }

  // Sends normal traffic, which only a ready connection carries: otherwise it throws what keeps the connection from
  // being ready, the diagnostic of an incompatible one included, and sends nothing.
  public send(message: ClientMessage): void {
    const { status } = this

    switch (status.state) {
      case 'ready':
        this.socket.write(encodeLine(message))
        return
      case 'incompatible':
        throw new BridgeIncompatibleError(status.diagnostic)
      case 'closed':
        throw status.error
      case 'awaiting-hello':
        throw new BridgeError(`The browser bridge's handshake has not completed, so ${message.type} was not sent`)
    }
  }

  public destroy(): void {
    this.socket.destroy()
  }

  private awaitReady(deadline: number, signal: AbortSignal | undefined, what: string): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(new BridgeError(`The caller abandoned ${what} before it was sent`))
    }

    return new Promise((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abandon)
        this.waiters.delete(waiter)
      }

      const waiter: IReadinessWaiter = {
        ready: () => {
          settle()
          resolve()
        },
        fail: (error) => {
          settle()
          reject(error)
        },
      }

      const abandon = (): void => {
        waiter.fail(new BridgeError(`The caller abandoned ${what} before it was sent`))
        this.closeIfUnwaited()
      }

      const timer = setTimeout(() => {
        const diagnostic = this.missingHello()
        waiter.fail(new BridgeIncompatibleError(diagnostic))
        this.events.onIncompatible(diagnostic)
        this.closeIfUnwaited()
      }, deadline - Date.now())

      this.waiters.add(waiter)
      signal?.addEventListener('abort', abandon, { once: true })
    })
  }

  // The leg whose hello had not come when a deadline passed: the host's own, or its extension leg once the host agreed.
  private missingHello(): BridgeIncompatible {
    return incompatibility('missing-hello', this.isHostAgreed ? 'extension-host' : 'host-client', this.local, undefined)
  }

  // Nobody waits for a handshake that has not completed, so nothing keeps waiting on it.
  private closeIfUnwaited(): void {
    if (this.waiters.size === 0 && this.state === 'awaiting-hello') {
      this.socket.destroy()
    }
  }

  // A line in the state of the connection: before the host's hello agreed only its hello or its diagnostic, then the
  // extension leg's state or the diagnostic at any time, and replies, events and status only once ready.
  private receive(raw: unknown): void {
    if (this.state === 'incompatible') {
      return
    }

    if (!this.isHostAgreed) {
      this.receiveHello(raw)
      return
    }

    const control = RelayControlSchema.safeParse(raw)
    if (control.success) {
      this.receiveControl(control.data)
      return
    }

    if (this.state !== 'ready' || isHello(raw)) {
      this.failOwnHandshake(incompatibility('unexpected-frame', 'host-client', this.local, raw))
      return
    }

    this.events.onMessage(this, RelayMessageSchema.parse(raw))
  }

  private receiveHello(raw: unknown): void {
    const control = RelayControlSchema.safeParse(raw)
    if (control.success && control.data.type === 'bridge-incompatible') {
      this.incompatible(control.data)
      return
    }

    const reading = readHello(raw, HostHelloSchema, this.local, 'host-client')
    if (reading.kind === 'incompatible') {
      this.failOwnHandshake(reading.diagnostic)
      return
    }

    this.isHostAgreed = true
    this.browserApp = reading.hello.browserApp
  }

  private receiveControl(control: RelayControl): void {
    if (control.type === 'bridge-incompatible') {
      this.incompatible(control)
      return
    }

    if (control.state === 'ready' && this.state === 'awaiting-hello') {
      this.status = { state: 'ready' }

      for (const waiter of this.waiters) {
        waiter.ready()
      }

      this.events.onReady(this)
    }
  }

  // This end found the failure: the relay is told before the connection turns incompatible.
  private failOwnHandshake(diagnostic: BridgeIncompatible): void {
    this.socket.write(encodeLine(diagnostic))
    this.incompatible(diagnostic)
  }

  private incompatible(diagnostic: BridgeIncompatible): void {
    const error = new BridgeIncompatibleError(diagnostic)
    this.status = { state: 'incompatible', diagnostic }

    for (const waiter of this.waiters) {
      waiter.fail(error)
    }

    this.rejectCalls(error)
    this.events.onIncompatible(diagnostic)
  }

  private closed(failure: Error | undefined): void {
    const hasBeenReady = this.state === 'ready'

    const error = this.isHostAgreed
      ? new BridgeError('The browser bridge closed (the browser quit or the extension reloaded)', { cause: failure })
      : new BridgeError(
          `Could not reach the browser bridge at ${this.socketPath}. Is the browser running with the Misha extension ` +
            'loaded and its native host installed?',
          { cause: failure }
        )

    this.status = { state: 'closed', error }

    for (const waiter of this.waiters) {
      waiter.fail(error)
    }

    this.rejectCalls(error)
    this.events.onClose(this, hasBeenReady)
  }

  private rejectCalls(error: Error): void {
    for (const call of this.calls.values()) {
      call.release()
      call.reject(error)
    }

    this.calls.clear()
  }
}
