import { type ConnectionState, type IHandshakeEnd, incompatibility, isHello, readHello } from '../protocol/handshake.js'
import {
  type BridgeIncompatible,
  BridgeIncompatibleSchema,
  type ExtensionHello,
  type HostFrame,
  HostFrameSchema,
  HostHelloSchema,
  PROTOCOL_REVISION,
} from '../protocol/messages.js'

interface IHostHandshakeEvents {
  // Posts a frame on the native port.
  readonly send: (frame: ExtensionHello | BridgeIncompatible) => void
  readonly onReady: () => void
  readonly onIncompatible: (diagnostic: BridgeIncompatible) => void
}

// The extension's end of one native port's handshake (protocol handshake.ts). start sends the extension's hello, once
// the port's listeners are in. The host's hello of the same revision makes the leg ready; anything else before it, a
// second hello after it, or the host's diagnostic makes it incompatible, and the extension's own diagnostic goes to the
// host when the extension found the failure. An incompatible leg hands nothing on, so no request runs and no ack or
// listener reaches the pending queue: its events wait for a compatible listener. The port stays open for the
// diagnostic until it really disconnects. The native port's wait for the host's hello has no deadline: no measured
// startup envelope of the host exists to bound it yet.
export class HostHandshake {
  private current: ConnectionState = 'awaiting-hello'

  constructor(
    private readonly local: IHandshakeEnd,
    private readonly events: IHostHandshakeEvents
  ) {}

  public get state(): ConnectionState {
    return this.current
  }

  public start(): void {
    this.events.send({
      type: 'hello',
      role: 'extension',
      protocolRevision: PROTOCOL_REVISION,
      componentVersion: this.local.componentVersion,
    })
  }

  // The host's frame for the service worker to act on, once the leg is ready; null for a handshake frame and for any
  // frame the leg's state refuses.
  public receive(raw: unknown): HostFrame | null {
    if (this.current === 'incompatible' || this.current === 'closed') {
      return null
    }

    const diagnostic = BridgeIncompatibleSchema.safeParse(raw)
    if (diagnostic.success) {
      this.incompatible(diagnostic.data)
      return null
    }

    if (this.current === 'awaiting-hello') {
      const reading = readHello(raw, HostHelloSchema, this.local, 'extension-host')
      if (reading.kind === 'incompatible') {
        this.events.send(reading.diagnostic)
        this.incompatible(reading.diagnostic)
        return null
      }

      this.current = 'ready'
      this.events.onReady()
      return null
    }

    if (isHello(raw)) {
      const repeated = incompatibility('unexpected-frame', 'extension-host', this.local, raw)
      this.events.send(repeated)
      this.incompatible(repeated)
      return null
    }

    return HostFrameSchema.parse(raw)
  }

  public close(): void {
    this.current = 'closed'
  }

  private incompatible(diagnostic: BridgeIncompatible): void {
    this.current = 'incompatible'
    this.events.onIncompatible(diagnostic)
  }
}
