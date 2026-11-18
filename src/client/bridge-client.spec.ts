import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import { startNativeHostRelay } from '../host/relay.js'
import { createFrameReader, encodeFrame } from '../protocol/framing.js'
import { type SlackEvent, slackEventKey, type SlackStatus } from '../protocol/slack.js'
import { BridgeClient } from './bridge-client.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const STATUS: SlackStatus = {
  type: 'status',
  identities: [{ tabId: 7, teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1', teamName: 'Example Workspace' }],
  captures: [{ tabId: 7, state: 'attached', isSocketOpen: true }],
  queue: { state: 'committing', droppedEvents: 0 },
}

interface IRejectedEvent {
  readonly event: SlackEvent
  readonly error: unknown
}

interface IQueue<TItem> {
  readonly put: (item: TItem) => void
  readonly next: () => Promise<TItem>
}

// The relay with the extension's end of its pipe in the test's hands: frames written to input reach the relay, and
// what the relay sends the extension is taken one frame at a time with next.
interface IExtensionEnd {
  readonly input: PassThrough
  readonly next: () => Promise<unknown>
}

const eventAt = (ts: string): SlackEvent => {
  const frame = { type: 'message', channel: 'D0EXAMPLE1', ts, text: 'hello' } as const

  return { type: 'event', id: slackEventKey(ACCOUNT, frame), account: ACCOUNT, frame }
}

// Items in the order they came, taken one at a time. Each waits in a box, since an item may itself be undefined.
const createQueue = <TItem>(): IQueue<TItem> => {
  const boxes: { readonly item: TItem }[] = []
  const waiters: ((item: TItem) => void)[] = []

  return {
    put: (item) => {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        boxes.push({ item })
      } else {
        waiter(item)
      }
    },
    next: () => {
      const box = boxes.shift()

      return box === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(box.item)
    },
  }
}

const startRelay = async (
  context: TestContext,
  socketPath: string,
  browserApp: string | null
): Promise<IExtensionEnd> => {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames = createQueue<unknown>()
  output.on('data', createFrameReader(frames.put))
  const server: Server = await startNativeHostRelay({ input, output, socketPath, browserApp })
  context.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close')
      input.end()
      await closed
    }
  })

  return { input, next: frames.next }
}

const startClient = async (
  context: TestContext,
  browserApp: string | null = null
): Promise<{ client: BridgeClient; extension: IExtensionEnd; rejected: IRejectedEvent[] }> => {
  const dir = await mkdtemp(join(tmpdir(), 'misha-client-'))
  const socketPath = join(dir, 'bridge.sock')
  const extension = await startRelay(context, socketPath, browserApp)
  const rejected: IRejectedEvent[] = []
  const client = new BridgeClient({
    socketPath,
    requestTimeoutMs: 5000,
    reconnectDelayMs: 50,
    onHandlerError: (event, error) => rejected.push({ event, error }),
  })
  context.after(async () => {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  })

  return { client, extension, rejected }
}

const fromExtension = ({ input }: IExtensionEnd, frame: unknown): void => {
  input.write(encodeFrame(frame))
}

describe('[client] Bridge client - events', () => {
  it('should acknowledge an event only once its handler resolves', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)
    const event = eventAt('1700000001.000100')
    const received = Promise.withResolvers<SlackEvent>()
    const committed = Promise.withResolvers<undefined>()
    client.listen((taken) => {
      received.resolve(taken)

      return committed.promise
    })
    assert.deepEqual(await extension.next(), { type: 'listener' })

    // Act
    fromExtension(extension, event)
    const taken = await received.promise
    const answered = client.call(ACCOUNT, 'auth.test', {})
    const beforeCommit = await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { ok: true } })
    await answered
    committed.resolve(undefined)
    const afterCommit = await extension.next()

    // Assert
    assert.deepEqual(taken, event)
    assert.deepEqual(beforeCommit, {
      type: 'request',
      id: 1,
      method: 'slackCall',
      params: { account: ACCOUNT, method: 'auth.test', params: {} },
    })
    assert.deepEqual(afterCommit, { type: 'ack', id: event.id })
  })

  it('should leave an event unacknowledged when its handler rejects, and report it', async (context) => {
    // Arrange
    const { client, extension, rejected } = await startClient(context)
    const [failed, committed] = [eventAt('1700000001.000100'), eventAt('1700000002.000100')]
    const commitError = new Error('The inbox did not commit')
    client.listen((event) => (event.id === failed.id ? Promise.reject(commitError) : Promise.resolve()))
    await extension.next()

    // Act
    fromExtension(extension, failed)
    fromExtension(extension, committed)
    const ack = await extension.next()

    // Assert
    assert.deepEqual(ack, { type: 'ack', id: committed.id })
    assert.deepEqual(rejected, [{ event: failed, error: commitError }])
  })
})

describe('[client] Bridge client - status', () => {
  it('should publish each status snapshot, and undefined once the relay went away', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)
    const published = createQueue<SlackStatus | undefined>()
    client.onStatus(published.put)
    client.listen(() => Promise.resolve())
    await extension.next()

    // Act
    fromExtension(extension, STATUS)
    const snapshot = await published.next()
    const latest = client.status()
    extension.input.end()
    const gone = await published.next()

    // Assert
    assert.deepEqual([snapshot, latest, gone], [STATUS, STATUS, undefined])
  })
})

describe('[client] Bridge client - tab commands', () => {
  it('should send a tab command and answer its checked result', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)

    // Act
    const answered = client.tab('closeTab', { tabId: 4 })
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })

    // Assert
    assert.deepEqual(request, { type: 'request', id: 1, method: 'closeTab', params: { tabId: 4 } })
    assert.deepEqual(await answered, { tabId: 4 })
  })

  it("should refuse an answer that does not read as the method's result", async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)

    // Act
    const answered = client.tab('closeTab', { tabId: 4 })
    await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 'four' } })

    // Assert
    await assert.rejects(answered, { name: 'ZodError' })
  })

  it('should fail with the error the extension answered', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)

    // Act
    const answered = client.tab('snapshot', { scope: 'viewport', maxChars: 100 })
    await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, error: 'Cannot access contents of the page' })

    // Assert
    await assert.rejects(answered, {
      name: 'BridgeError',
      message: 'The extension failed snapshot: Cannot access contents of the page',
    })
  })

  it('should report the browser app the native host was started by', async (context) => {
    // Arrange
    const { client } = await startClient(context, '/Applications/Example Browser.app')

    // Act
    const browserApp = await client.browserApp()

    // Assert
    assert.equal(browserApp, '/Applications/Example Browser.app')
  })
})
