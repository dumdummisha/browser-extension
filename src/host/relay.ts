import { chmodSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { createFrameReader, createLineReader, encodeFrame, encodeLine } from '../protocol/framing.js'
import { ClientMessageSchema, ExtensionFrameSchema, type HostFrame, type RelayMessage } from '../protocol/messages.js'
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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const warn = (message: string): void => {
  process.stderr.write(`misha-browser host: ${message}\n`)
}

// The browser starts one host per extension connection, and every client process connects to its socket. The relay
// renumbers the clients' requests so each reply from the extension finds its way back to the client that asked, and
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

  const toExtension = (frame: HostFrame): void => {
    output.write(encodeFrame(frame))
  }

  const toClient = (client: Socket, message: RelayMessage): void => {
    client.write(encodeLine(message))
  }

  const relayClientMessage = (client: Socket, raw: unknown): void => {
    const message = ClientMessageSchema.parse(raw)
    switch (message.type) {
      case 'request': {
        const id = nextId
        nextId += 1
        pending.set(id, { client, clientId: message.id })
        toExtension({ ...message, id })
        return
      }
      case 'listen':
        listener = client
        toExtension({ type: 'listener' })
        return
      case 'ack':
        // Only the listener was sent the event, so only its ack can mean the app committed it.
        if (client === listener) {
          toExtension(message)
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
    const readLines = createLineReader((raw) => relayClientMessage(client, raw))
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
    client.on('close', () => {
      clients.delete(client)
      if (listener === client) {
        listener = null
      }

      for (const [id, request] of pending) {
        if (request.client === client) {
          pending.delete(id)
        }
      }
    })

    toClient(client, { type: 'hello', browserApp })
  })

  // A socket file left by a host that crashed, or by another browser's host, would make listen fail; the newest
  // browser to start its host takes the socket over. Only this user may open the folder or the socket.
  ensurePrivateDir(dirname(socketPath))
  rmSync(socketPath, { force: true })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  chmodSync(socketPath, 0o600)

  input.on('data', createFrameReader(relayExtensionFrame))
  input.on('end', () => {
    server.close()
    for (const client of clients) {
      client.destroy()
    }
  })

  return server
}
