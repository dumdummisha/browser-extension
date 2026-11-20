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
  type ClientMessage,
  ClientMessageSchema,
  ExtensionFrameSchema,
  type HostFrame,
  type RelayMessage,
} from '../protocol/messages.js'
import { ensurePrivateDir } from './paths.js'

export interface IRelayOptions {
  // The browser's end of the native messaging pipe: frames from the extension arrive on input, go out on output.
  readonly input: Readable
  readonly output: Writable
  readonly socketPath: string
  readonly browserApp: string | null
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

// Locks the bridge for this host, waiting while another host holds it, until the returned file closes. Hosts the
// browsers start together clear and bind the socket path one at a time under it, so none acts on what it found at the
// path while another changes it.
const lockBridge = (socketPath: string): Promise<FileHandle> => {
  if (process.platform !== 'darwin') {
    throw new Error(`The bridge's lock takes macOS's O_EXLOCK, which ${process.platform} does not have`)
  }

  return open(`${socketPath}.lock`, LOCK_OPEN_FLAGS, 0o600)
}

// Clears the socket path for this host, which holds the bridge lock, so no other host binds the path meanwhile. A relay
// listening there, another browser's host, is asked to let go (messages.ts takeover), and this host goes on only once
// that relay closed the connection, which it does after closing its server. Node removes a server's path when the
// server closes, so the path must be the other relay's to remove before this host binds it, never after. A socket
// nothing listens on, left by a host that crashed, is removed while it is still the file that refused the connection;
// anything else at the path is left alone.
const clearSocketPath = async (socketPath: string): Promise<void> => {
  const probed = lstatSync(socketPath, { throwIfNoEntry: false })
  if (probed === undefined) {
    return
  }

  const holder = createConnection(socketPath)
  const failure = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    holder.once('connect', () => resolve(null))
    holder.on('error', resolve)
  })
  if (failure === null) {
    // The holder's hello is read and dropped, so the connection can end.
    holder.resume()
    holder.end(encodeLine({ type: 'takeover' } satisfies ClientMessage))
    await new Promise((resolve) => holder.once('close', resolve))
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

// The browser starts one host per extension connection, and every client process connects to its socket. The relay
// renumbers the clients' requests so each reply from the extension finds its way back to the client that asked, tells
// the extension when a request's caller has given up (the client cancelled it, or its connection closed), and
// passes what the extension sends unasked, events and status, to the one listener: the newest client to send listen.
// It tells the extension each time a listener attaches, so the extension sends its status and every waiting event. The
// relay lives as long as the browser's pipe: when input ends, the socket closes and the process can exit.
export const startNativeHostRelay = async ({
  input,
  output,
  socketPath,
  browserApp,
}: IRelayOptions): Promise<Server> => {
  const pending = new Map<number, IPendingRequest>()
  const clients = new Set<Socket>()
  let listener: Socket | null = null
  let nextId = 1
  let isPipeOpen = true

  // Chrome closes the pipe on a frame larger than HOST_MESSAGE_MAX_BYTES, which would cut off the listener and every
  // caller; such a frame is refused here instead, and false says nothing of it went out.
  const toExtension = (frame: HostFrame): boolean => {
    const encoded = encodeFrame(frame)
    if (encoded.length - FRAME_HEADER_BYTES > HOST_MESSAGE_MAX_BYTES) {
      return false
    }

    output.write(encoded)

    return true
  }

  const toClient = (client: Socket, message: RelayMessage): void => {
    client.write(encodeLine(message))
  }

  // Tells the extension the caller of each pending request that matches has given up, and forgets the request, so a
  // reply that still comes reaches nobody. Nothing goes out once the browser's pipe has ended.
  const cancelPending = (isGivenUp: (request: IPendingRequest) => boolean): void => {
    for (const [id, request] of pending) {
      if (isGivenUp(request)) {
        pending.delete(id)
        if (isPipeOpen) {
          toExtension({ type: 'cancel', id })
        }
      }
    }
  }

  const relayClientMessage = (client: Socket, raw: unknown): void => {
    const message = ClientMessageSchema.parse(raw)
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

        return
      case 'takeover':
        server.close()
        for (const connected of clients) {
          connected.destroy()
        }
    }
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

  const server = createServer((client) => {
    clients.add(client)
    client.setEncoding('utf8')
    const readLines = createLineReader((raw) => relayClientMessage(client, raw), CLIENT_LINE_MAX_LENGTH)
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
      clients.delete(client)
      if (listener === client) {
        listener = null
      }

      cancelPending((request) => request.client === client)
    })

    toClient(client, { type: 'hello', browserApp })
  })

  // The newest browser to start its host takes the socket over. Only this user may open the folder or the socket.
  ensurePrivateDir(dirname(socketPath))
  const lock = await lockBridge(socketPath)
  try {
    await clearSocketPath(socketPath)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
  } finally {
    await lock.close()
  }

  input.on('data', createFrameReader(relayExtensionFrame))
  input.on('end', () => {
    isPipeOpen = false
    server.close()
    for (const client of clients) {
      client.destroy()
    }
  })

  return server
}
