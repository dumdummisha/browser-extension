import { chmodSync, constants, lstatSync, rmSync } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import {
  createFrameReader,
  createLineReader,
  encodeFrame,
  encodeLine,
  FRAME_HEADER_BYTES,
  HOST_MESSAGE_MAX_BYTES,
} from '../protocol/framing.js'
import {
  type IHandshakeEnd,
  incompatibility,
  incompatibilityMessage,
  isHello,
  readHello,
} from '../protocol/handshake.js'
import {
  type BridgeIncompatible,
  BridgeIncompatibleSchema,
  type ClientHello,
  ClientHelloSchema,
  ClientMessageSchema,
  ExtensionFrameSchema,
  ExtensionHelloSchema,
  type HostFrame,
  type HostHello,
  HostHelloSchema,
  PROTOCOL_REVISION,
  type RelayControl,
  type RelayMessage,
  type Takeover,
  TakeoverSchema,
} from '../protocol/messages.js'
import { ensurePrivateDir } from './paths.js'

interface IRelayOptions {
  // The browser's end of the native messaging pipe: frames from the extension arrive on input, go out on output.
  readonly input: Readable
  readonly output: Writable
  readonly socketPath: string
  readonly browserApp: string | null
  // The package version the host names in its hello (component-version.ts).
  readonly componentVersion: string
  // How long a host taking the socket over waits for the holder's hello and for the holder to let go, in milliseconds;
  // when it passes, this host gives up, releases the bridge lock and leaves the holder's socket in place. null sets no
  // deadline, so only a refusal, an answer or the end of the browser's pipe ends the takeover. Its production value
  // has to come from a measurement of host startup and takeover on the supported Macs, or from the owner: none exists
  // yet, which is a release-readiness prerequisite (native-host.ts).
  readonly takeoverDeadlineMs: number | null
}

// The host's extension leg (protocol handshake.ts). It never returns to awaiting-hello, and an incompatible leg stays so
// until the browser's pipe ends, which ends this host.
type ExtensionLegState =
  | { readonly state: 'awaiting-hello' | 'ready' }
  | { readonly state: 'incompatible'; readonly diagnostic: BridgeIncompatible }

// A client connection and its leg: awaiting its hello, agreed as a client or as a host taking the socket over, or
// refused, once the relay sent it the diagnostic and ended it.
interface IClientConnection {
  readonly socket: Socket
  leg: 'awaiting-hello' | ClientHello['role'] | 'refused'
}

interface IPendingRequest {
  readonly client: Socket
  readonly clientId: number
}

// The longest line a client may send, in characters, twice the largest frame the extension takes, since a request that
// fits is about as long as its frame. A longer line closes the client's connection before it ends, so no client can
// make the relay hold an endless line; whether a message fits the extension is checked on its frame.
const CLIENT_LINE_MAX_LENGTH = 2 * HOST_MESSAGE_MAX_BYTES

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const warn = (message: string): void => {
  process.stderr.write(`misha-browser host: ${message}\n`)
}

// macOS's open(2) flag that takes an exclusive flock(2) lock on the file as it opens it, waiting while another open
// file holds one (sys/fcntl.h); Node names no constant for it. The kernel releases the lock when the file closes or its
// process dies, so a host that crashed never leaves the bridge locked.
const O_EXLOCK = 0x20
// Each flag is its own bit, so their sum is the mask open(2) takes.
const LOCK_OPEN_FLAGS = constants.O_RDWR + constants.O_CREAT + constants.O_NOFOLLOW + O_EXLOCK

// How a takeover ends when stop fires: its deadline passed or the browser's pipe ended, as stop's reason says.
const takeoverStopped = (socketPath: string, stop: AbortSignal): Error =>
  new Error(`Could not take ${socketPath} over: ${errorMessage(stop.reason)}`)

// Locks the bridge for this host, waiting while another host holds it, until the returned file closes. Hosts the
// browsers start together clear and bind the socket path one at a time under it, so none acts on what it found at the
// path while another changes it. The wait ends with stop. The open itself cannot be interrupted, so a lock it takes
// after stop fired is closed at once and goes no further.
const lockBridge = (socketPath: string, stop: AbortSignal): Promise<FileHandle> => {
  if (process.platform !== 'darwin') {
    throw new Error(`The bridge's lock takes macOS's O_EXLOCK, which ${process.platform} does not have`)
  }

  return new Promise((resolve, reject) => {
    const onStop = (): void => reject(takeoverStopped(socketPath, stop))
    stop.addEventListener('abort', onStop, { once: true })
    open(`${socketPath}.lock`, LOCK_OPEN_FLAGS, 0o600).then(
      (lock) => {
        stop.removeEventListener('abort', onStop)
        if (stop.aborted) {
          void lock.close()
        } else {
          resolve(lock)
        }
      },
      (error: unknown) => {
        stop.removeEventListener('abort', onStop)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
    if (stop.aborted) {
      onStop()
    }
  })
}

// The protocol fields of an end's hello.
const protocolOf = ({ componentVersion }: IHandshakeEnd): Pick<HostHello, 'protocolRevision' | 'componentVersion'> => ({
  protocolRevision: PROTOCOL_REVISION,
  componentVersion,
})

// Asks the relay holding the socket to let go, as a host taking it over (messages.ts takeover). The holder's hello must
// agree before takeover goes out; a holder of another revision, or one whose hello does not read, is refused with the
// diagnostic and keeps the socket, since the browser-restart recovery is what ends a host this one cannot talk to. A
// holder that refuses this host's hello sends its diagnostic before it ends the connection. Either refusal closes the
// connection at once, whether or not the holder ends its side. The holder's extension-leg state, which follows its
// hello, says nothing about the takeover and is dropped. stop ends the exchange from outside (its deadline passed, or
// the browser's pipe ended): the connection is destroyed and the takeover fails with stop's reason.
const takeOver = (holder: Socket, socketPath: string, local: IHandshakeEnd, stop: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const state: {
      isGreeted: boolean
      refusal: BridgeIncompatible | null
      isStopped: boolean
      failure?: Error
    } = { isGreeted: false, refusal: null, isStopped: false }
    const onStop = (): void => {
      state.isStopped = true
      holder.destroy()
    }
    const readLines = createLineReader((raw) => {
      if (state.isGreeted) {
        const diagnostic = BridgeIncompatibleSchema.safeParse(raw)
        if (diagnostic.success && diagnostic.data.leg === 'host-client') {
          state.refusal = diagnostic.data
          holder.destroy()
        }

        return
      }

      state.isGreeted = true
      const reading = readHello(raw, HostHelloSchema, local, 'host-client')
      if (reading.kind === 'incompatible') {
        state.refusal = reading.diagnostic
        holder.end(encodeLine(reading.diagnostic), () => holder.destroy())
        return
      }

      const hello: ClientHello = { type: 'hello', role: 'takeover', ...protocolOf(local) }
      holder.end(`${encodeLine(hello)}${encodeLine({ type: 'takeover' } satisfies Takeover)}`)
    }, CLIENT_LINE_MAX_LENGTH)

    holder.setEncoding('utf8')
    holder.on('data', (chunk: string) => {
      try {
        readLines(chunk)
      } catch (error) {
        holder.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })
    holder.on('error', (error) => {
      state.failure = error
    })
    holder.once('close', () => {
      stop.removeEventListener('abort', onStop)
      if (state.refusal !== null) {
        reject(new Error(`Could not take ${socketPath} over: ${incompatibilityMessage(state.refusal)}`))
      } else if (state.isStopped) {
        reject(takeoverStopped(socketPath, stop))
      } else if (state.isGreeted) {
        resolve()
      } else {
        reject(new Error(`The relay holding ${socketPath} closed before its hello`, { cause: state.failure }))
      }
    })
    if (stop.aborted) {
      onStop()
    } else {
      stop.addEventListener('abort', onStop, { once: true })
    }
  })

// Clears the socket path for this host, which holds the bridge lock, so no other host binds the path meanwhile. A relay
// listening there, another browser's host, is asked to let go (takeOver), and this host goes on only once that relay
// closed the connection, which it does after closing its server. Node removes a server's path when the
// server closes, so the path must be the other relay's to remove before this host binds it, never after. A socket
// nothing listens on, left by a host that crashed, is removed while it is still the file that refused the connection;
// anything else at the path is left alone.
const clearSocketPath = async (socketPath: string, componentVersion: string, stop: AbortSignal): Promise<void> => {
  const probed = lstatSync(socketPath, { throwIfNoEntry: false })
  if (probed === undefined) {
    return
  }

  // The connect ends with stop too: the connection is destroyed, so one that would complete later goes no further.
  const holder = createConnection(socketPath)
  const failure = await new Promise<NodeJS.ErrnoException | null>((resolve, reject) => {
    const onStop = (): void => {
      holder.destroy()
      reject(takeoverStopped(socketPath, stop))
    }
    const settle = (outcome: NodeJS.ErrnoException | null): void => {
      stop.removeEventListener('abort', onStop)
      resolve(outcome)
    }
    holder.once('connect', () => settle(null))
    holder.on('error', settle)
    stop.addEventListener('abort', onStop, { once: true })
    if (stop.aborted) {
      onStop()
    }
  })
  if (failure === null) {
    await takeOver(holder, socketPath, { role: 'takeover', componentVersion }, stop)
    return
  }

  if (failure.code === 'ENOENT') {
    return
  }

  const refused = lstatSync(socketPath, { throwIfNoEntry: false })
  const isProbedSocket = probed.isSocket() && refused?.dev === probed.dev && refused.ino === probed.ino
  if (failure.code !== 'ECONNREFUSED' || !isProbedSocket) {
    throw new Error(`${socketPath} holds no socket a relay can take over (${failure.message})`)
  }

  rmSync(socketPath)
}

// The browser starts one host per extension connection, and every client process connects to its socket. Each leg
// opens with both hellos (protocol handshake.ts): the extension's native leg, and each client's socket leg, which the
// relay greets at once whatever its extension leg says, followed by that leg's state. Once a client agreed and the
// extension leg is ready, the relay renumbers the clients' requests so each reply from the extension finds its way back
// to the client that asked, tells the extension when a request's caller has given up (the client cancelled it, or its
// connection closed), and passes what the extension sends unasked, events and status, to the one listener: the newest
// client to send listen. It tells the extension each time a listener attaches, so the extension sends its status and
// every waiting event. An incompatible extension leg carries no normal traffic, while the socket keeps listening to
// hand its diagnostic to every client that connects. The relay lives as long as the browser's pipe: when input ends,
// the socket closes and the process can exit.
export const startNativeHostRelay = async ({
  input,
  output,
  socketPath,
  browserApp,
  componentVersion,
  takeoverDeadlineMs,
}: IRelayOptions): Promise<Server> => {
  const local: IHandshakeEnd = { role: 'host', componentVersion }
  const hello: HostHello = { type: 'hello', role: 'host', ...protocolOf(local), browserApp }
  const pending = new Map<number, IPendingRequest>()
  const clients = new Set<IClientConnection>()
  // Held in an object, since the pipe's end handler changes it while the socket is being taken.
  const pipe = { isOpen: true }
  // Ends a takeover still under way when the browser's pipe ends or the takeover's deadline passes.
  const takeoverStop = new AbortController()
  let extensionLeg: ExtensionLegState = { state: 'awaiting-hello' }
  let listener: Socket | null = null
  let nextId = 1

  // Chrome closes the pipe on a frame larger than HOST_MESSAGE_MAX_BYTES, which would cut off the listener and every
  // caller; such a frame is refused here instead, and false says nothing of it went out.
  const toExtension = (frame: HostFrame | HostHello | BridgeIncompatible): boolean => {
    const encoded = encodeFrame(frame)
    if (encoded.length - FRAME_HEADER_BYTES > HOST_MESSAGE_MAX_BYTES) {
      return false
    }

    output.write(encoded)

    return true
  }

  const toClient = (client: Socket, message: RelayMessage | RelayControl | HostHello): void => {
    client.write(encodeLine(message))
  }

  const extensionLegControl = (): RelayControl =>
    extensionLeg.state === 'incompatible'
      ? extensionLeg.diagnostic
      : { type: 'extension-leg', state: extensionLeg.state }

  const announceExtensionLeg = (): void => {
    for (const { socket, leg } of clients) {
      if (leg !== 'refused') {
        toClient(socket, extensionLegControl())
      }
    }
  }

  // Tells the extension the caller of each pending request that matches has given up, and forgets the request, so a
  // reply that still comes reaches nobody. Nothing goes out once the browser's pipe has ended.
  const cancelPending = (isGivenUp: (request: IPendingRequest) => boolean): void => {
    for (const [id, request] of pending) {
      if (isGivenUp(request)) {
        pending.delete(id)
        if (pipe.isOpen) {
          toExtension({ type: 'cancel', id })
        }
      }
    }
  }

  // The extension leg cannot be used: every client learns it, and the requests in flight and the listener are dropped
  // without a word to the extension, since no normal traffic crosses an incompatible leg.
  const extensionLegFailed = (diagnostic: BridgeIncompatible): void => {
    extensionLeg = { state: 'incompatible', diagnostic }
    pending.clear()
    listener = null
    announceExtensionLeg()
  }

  // The client gets the diagnostic and the end of its connection: its leg carries nothing more.
  const refuse = (client: IClientConnection, diagnostic: BridgeIncompatible): void => {
    client.leg = 'refused'
    client.socket.end(encodeLine(diagnostic))
  }

  const relayClientMessage = (client: Socket, raw: unknown): void => {
    const message = ClientMessageSchema.parse(raw)
    if (extensionLeg.state !== 'ready') {
      throw new Error(`A client sent ${message.type} while the extension leg is ${extensionLeg.state}`)
    }

    switch (message.type) {
      case 'request': {
        const id = nextId
        nextId += 1
        if (!toExtension({ ...message, id })) {
          toClient(client, {
            type: 'reply',
            id: message.id,
            error: `The request is larger than the ${HOST_MESSAGE_MAX_BYTES} bytes the extension takes from its host`,
          })
          return
        }

        pending.set(id, { client, clientId: message.id })
        return
      }
      case 'cancel':
        cancelPending((request) => request.client === client && request.clientId === message.id)
        return
      case 'listen':
        listener = client
        toExtension({ type: 'listener' })
        return
      case 'ack':
        // Only the listener was sent the event, so only its ack can mean the app committed it. An event's id is bounded
        // (slack.ts), so an ack too large to pass on names no event.
        if (client === listener && !toExtension(message)) {
          throw new Error(`An ack is larger than the ${HOST_MESSAGE_MAX_BYTES} bytes the extension takes from its host`)
        }
    }
  }

  // A client's line in the state of its leg. A diagnostic from the client, which found this host's hello wrong, ends
  // its connection in any state. A second hello is a protocol failure, and closes the connection like any other.
  const receiveClientLine = (client: IClientConnection, raw: unknown): void => {
    if (client.leg === 'refused') {
      return
    }

    const diagnostic = BridgeIncompatibleSchema.safeParse(raw)
    if (diagnostic.success) {
      warn(`A client cannot use this host: ${incompatibilityMessage(diagnostic.data)}`)
      client.leg = 'refused'
      client.socket.end()
      return
    }

    switch (client.leg) {
      case 'awaiting-hello': {
        const reading = readHello(raw, ClientHelloSchema, local, 'host-client')
        if (reading.kind === 'incompatible') {
          refuse(client, reading.diagnostic)
        } else {
          client.leg = reading.hello.role
        }

        return
      }
      case 'takeover':
        // A takeover never waits for the extension leg: the host that takes the socket over has its own.
        TakeoverSchema.parse(raw)
        server.close()
        for (const { socket } of clients) {
          socket.destroy()
        }

        return
      case 'client':
        if (isHello(raw)) {
          throw new Error('A client said hello twice')
        }

        relayClientMessage(client.socket, raw)
    }
  }

  // The extension's frame in the state of its leg. A diagnostic from the extension, which found this host's hello
  // wrong, makes the leg incompatible in any state; so does a second hello, with this host's own diagnostic.
  const receiveExtensionFrame = (raw: unknown): void => {
    if (extensionLeg.state === 'incompatible') {
      return
    }

    const diagnostic = BridgeIncompatibleSchema.safeParse(raw)
    if (diagnostic.success) {
      warn(`The extension cannot use this host: ${incompatibilityMessage(diagnostic.data)}`)
      extensionLegFailed(diagnostic.data)
      return
    }

    if (extensionLeg.state === 'awaiting-hello') {
      const reading = readHello(raw, ExtensionHelloSchema, local, 'extension-host')
      if (reading.kind === 'incompatible') {
        toExtension(reading.diagnostic)
        extensionLegFailed(reading.diagnostic)
        return
      }

      extensionLeg = { state: 'ready' }
      announceExtensionLeg()
      return
    }

    if (isHello(raw)) {
      const repeated = incompatibility('unexpected-frame', 'extension-host', local, raw)
      toExtension(repeated)
      extensionLegFailed(repeated)
      return
    }

    relayExtensionFrame(raw)
  }

  const relayExtensionFrame = (raw: unknown): void => {
    const frame = ExtensionFrameSchema.parse(raw)
    if (frame.type !== 'reply') {
      // With no listener the extension still holds the events, and sends them again when one attaches.
      if (listener !== null) {
        toClient(listener, frame)
      }

      return
    }

    const request = pending.get(frame.id)
    if (request === undefined) {
      return
    }

    pending.delete(frame.id)
    toClient(request.client, { ...frame, id: request.clientId })
  }

  // Each client's listeners go in before its hello, then the state of the extension leg follows.
  const server = createServer((client) => {
    const connection: IClientConnection = { socket: client, leg: 'awaiting-hello' }
    clients.add(connection)
    client.setEncoding('utf8')
    const readLines = createLineReader((raw) => receiveClientLine(connection, raw), CLIENT_LINE_MAX_LENGTH)
    // A client that breaks the protocol loses its connection; the browser's host and the other clients carry on.
    client.on('data', (chunk: string) => {
      try {
        readLines(chunk)
      } catch (error) {
        warn(`Closed a client connection that sent a malformed message: ${errorMessage(error)}`)
        client.destroy()
      }
    })
    client.on('error', (error) => warn(`A client connection failed: ${error.message}`))
    // A client whose connection closed can take no reply, so its pending requests are given up.
    client.on('close', () => {
      clients.delete(connection)
      if (listener === client) {
        listener = null
      }

      cancelPending((request) => request.client === client)
    })

    toClient(client, hello)
    toClient(client, extensionLegControl())
  })

  // The extension's listeners go in before the host's hello, which goes out before the socket is taken, since a
  // takeover may wait on the relay holding it.
  input.on('data', createFrameReader(receiveExtensionFrame))
  input.on('end', () => {
    pipe.isOpen = false
    takeoverStop.abort(new Error("the browser's native pipe ended"))
    server.close()
    for (const { socket } of clients) {
      socket.destroy()
    }
  })
  toExtension(hello)

  // The newest browser to start its host takes the socket over. Only this user may open the folder or the socket. One
  // deadline and the pipe's end stop the whole takeover: the wait for the bridge lock, the connect to the holder and the
  // exchange with it. A pipe that ended meanwhile leaves the socket to whoever holds it.
  ensurePrivateDir(dirname(socketPath))
  const deadline =
    takeoverDeadlineMs === null
      ? undefined
      : setTimeout(() => {
          takeoverStop.abort(new Error(`the takeover did not finish within ${takeoverDeadlineMs} ms`))
        }, takeoverDeadlineMs)
  try {
    const lock = await lockBridge(socketPath, takeoverStop.signal)
    try {
      await clearSocketPath(socketPath, componentVersion, takeoverStop.signal)
      if (!pipe.isOpen) {
        return server
      }

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      chmodSync(socketPath, 0o600)
    } finally {
      await lock.close()
    }
  } finally {
    clearTimeout(deadline)
  }

  return server
}
