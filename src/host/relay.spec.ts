import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import { createFrameReader, createLineReader, encodeFrame, encodeLine } from '../protocol/framing.js'
import { type SlackEvent, slackEventKey } from '../protocol/slack.js'
import { startNativeHostRelay } from './relay.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const BROWSER_APP = 'Example Browser.app'
const STATUS = { type: 'status', identities: [], captures: [], queue: { state: 'committing', droppedEvents: 0 } }

interface IInbox {
  readonly put: (message: unknown) => void
  readonly next: () => Promise<unknown>
}

interface IRelay {
  readonly socketPath: string
  // The extension's end of the native messaging pipe: frames written here reach the relay, and what the relay sends
  // the extension arrives in the inbox.
  readonly input: PassThrough
  readonly extension: IInbox
}

interface IClient {
  readonly socket: Socket
  readonly inbox: IInbox
}

const eventAt = (ts: string): SlackEvent => {
  const frame = { type: 'message', channel: 'C0EXAMPLE1', ts, text: 'hello' } as const

  return { type: 'event', id: slackEventKey(ACCOUNT, frame), account: ACCOUNT, frame }
}

// Messages in the order they arrived, taken one at a time.
const createInbox = (): IInbox => {
  const messages: unknown[] = []
  const waiters: ((message: unknown) => void)[] = []

  return {
    put: (message) => {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        messages.push(message)
      } else {
        waiter(message)
      }
    },
    next: () =>
      messages.length > 0 ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)),
  }
}

const startRelay = async (context: TestContext): Promise<IRelay> => {
  const dir = await mkdtemp(join(tmpdir(), 'misha-relay-'))
  const socketPath = join(dir, 'bridge', 'bridge.sock')
  const input = new PassThrough()
  const output = new PassThrough()
  const extension = createInbox()
  output.on('data', createFrameReader(extension.put))
  const server: Server = await startNativeHostRelay({ input, output, socketPath, browserApp: BROWSER_APP })
  context.after(async () => {
    input.end()
    await once(server, 'close')
    await rm(dir, { recursive: true, force: true })
  })

  return { socketPath, input, extension }
}

const connectClient = async ({ socketPath }: IRelay): Promise<IClient> => {
  const socket = createConnection(socketPath)
  const inbox = createInbox()
  socket.setEncoding('utf8')
  socket.on('data', createLineReader(inbox.put))
  assert.deepEqual(await inbox.next(), { type: 'hello', browserApp: BROWSER_APP })

  return { socket, inbox }
}

const send = ({ socket }: IClient, message: unknown): void => {
  socket.write(encodeLine(message))
}

const fromExtension = ({ input }: IRelay, frame: unknown): void => {
  input.write(encodeFrame(frame))
}

// A request that went through and its reply came back proves the relay handled everything the client sent before it,
// and that nothing else reached the client in between.
const roundTrip = async (relay: IRelay, client: IClient): Promise<void> => {
  send(client, { type: 'request', id: 99, method: 'slackCall', params: {} })
  const request = await relay.extension.next()
  assert.ok(typeof request === 'object' && request !== null && 'id' in request && typeof request.id === 'number')
  fromExtension(relay, { type: 'reply', id: request.id, result: { ok: true } })
  assert.deepEqual(await client.inbox.next(), { type: 'reply', id: 99, result: { ok: true } })
}

describe('[host] Relay - requests', () => {
  it('should listen on a socket only its owner can open', async (context) => {
    // Act
    const { socketPath } = await startRelay(context)

    // Assert
    const [socket, folder] = await Promise.all([stat(socketPath), stat(dirname(socketPath))])
    assert.deepEqual([socket.mode.toString(8).slice(-3), folder.mode.toString(8).slice(-3)], ['600', '700'])
  })

  it('should renumber requests and route each reply back to the client that asked, under its own id', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [first, second] = [await connectClient(relay), await connectClient(relay)]

    // Act
    send(first, { type: 'request', id: 1, method: 'slackCall', params: { order: 1 } })
    const firstRequest = await relay.extension.next()
    send(second, { type: 'request', id: 1, method: 'slackDownload', params: { order: 2 } })
    const secondRequest = await relay.extension.next()
    fromExtension(relay, { type: 'reply', id: 2, result: { ok: true } })
    fromExtension(relay, { type: 'reply', id: 1, error: 'Tab 12 closed' })

    // Assert
    assert.deepEqual(
      [firstRequest, secondRequest],
      [
        { type: 'request', id: 1, method: 'slackCall', params: { order: 1 } },
        { type: 'request', id: 2, method: 'slackDownload', params: { order: 2 } },
      ]
    )
    assert.deepEqual(await second.inbox.next(), { type: 'reply', id: 1, result: { ok: true } })
    assert.deepEqual(await first.inbox.next(), { type: 'reply', id: 1, error: 'Tab 12 closed' })
  })
})

describe('[host] Relay - events', () => {
  it('should send events and status only to the listener, and drop them while nobody listens', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [bystander, listener] = [await connectClient(relay), await connectClient(relay)]
    const [dropped, delivered] = [eventAt('1700000001.000100'), eventAt('1700000002.000100')]
    fromExtension(relay, dropped)
    await roundTrip(relay, bystander)

    // Act
    send(listener, { type: 'listen' })
    const told = await relay.extension.next()
    fromExtension(relay, delivered)
    fromExtension(relay, STATUS)

    // Assert
    assert.deepEqual(told, { type: 'listener' })
    assert.deepEqual([await listener.inbox.next(), await listener.inbox.next()], [delivered, STATUS])
    await roundTrip(relay, bystander)
  })

  it('should replace the listener with the newest client to listen, telling the extension each time', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [older, newer] = [await connectClient(relay), await connectClient(relay)]
    const event = eventAt('1700000001.000100')

    // Act
    send(older, { type: 'listen' })
    const toldFirst = await relay.extension.next()
    send(newer, { type: 'listen' })
    const toldSecond = await relay.extension.next()
    fromExtension(relay, event)

    // Assert
    assert.deepEqual([toldFirst, toldSecond], [{ type: 'listener' }, { type: 'listener' }])
    assert.deepEqual(await newer.inbox.next(), event)
    await roundTrip(relay, older)
  })

  it('should pass acks on from the listener only', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [listener, bystander] = [await connectClient(relay), await connectClient(relay)]
    const [ignored, acknowledged] = [eventAt('1700000001.000100'), eventAt('1700000002.000100')]
    send(listener, { type: 'listen' })
    await relay.extension.next()

    // Act
    send(bystander, { type: 'ack', id: ignored.id })
    send(bystander, { type: 'request', id: 5, method: 'slackCall', params: {} })
    const afterBystander = await relay.extension.next()
    send(listener, { type: 'ack', id: acknowledged.id })
    const afterListener = await relay.extension.next()

    // Assert
    assert.deepEqual(afterBystander, { type: 'request', id: 1, method: 'slackCall', params: {} })
    assert.deepEqual(afterListener, { type: 'ack', id: acknowledged.id })
  })

  it('should hand what the extension replays on attach to the listener that just attached', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const leaving = await connectClient(relay)
    const event = eventAt('1700000001.000100')
    send(leaving, { type: 'listen' })
    await relay.extension.next()
    leaving.socket.destroy()
    await once(leaving.socket, 'close')
    const next = await connectClient(relay)

    // Act
    send(next, { type: 'listen' })
    const told = await relay.extension.next()
    fromExtension(relay, STATUS)
    fromExtension(relay, event)

    // Assert
    assert.deepEqual(told, { type: 'listener' })
    assert.deepEqual([await next.inbox.next(), await next.inbox.next()], [STATUS, event])
  })
})
