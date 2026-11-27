import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { COMPONENT_VERSION } from '../host/component-version.js'
import { createQueue, drained, EXTENSION_HELLO, HOST_VERSION, type IQueue, startTestRelay } from '../host/testing.js'
import { createLineReader, encodeFrame, encodeLine } from '../protocol/framing.js'
import { PROTOCOL_REVISION } from '../protocol/messages.js'
import { type SlackEvent, slackEventKey, type SlackStatus } from '../protocol/slack.js'
import { BridgeClient, BridgeIncompatibleError, type IBridgeState } from './bridge-client.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
// The request timeout of a client in these tests, well inside the test runner's timeout.
const REQUEST_TIMEOUT_MS = 5000

const STATUS: SlackStatus = {
  type: 'status',
  identities: [{ tabId: 7, teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1', teamName: 'Example Workspace' }],
  captures: [{ tabId: 7, state: 'attached', isSocketOpen: true }],
  queue: { state: 'committing', droppedEvents: 0 },
  parity: [],
}

interface IRejectedEvent {
  readonly event: SlackEvent
  readonly error: unknown
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

const fromExtension = ({ input }: IExtensionEnd, frame: unknown): void => {
  input.write(encodeFrame(frame))
}

// A relay whose extension has not said hello yet, with the host's hello to the extension taken.
const openRelay = async (
  context: TestContext,
  socketPath: string,
  browserApp: string | null
): Promise<IExtensionEnd> => {
  const { input, frames } = await startTestRelay(context, socketPath, browserApp)
  const hello = await frames.next()
  assert.ok(typeof hello === 'object' && hello !== null && 'type' in hello && hello.type === 'hello')

  return { input, next: frames.next }
}

const tempSocketPath = async (context: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'misha-client-'))
  context.after(() => rm(dir, { recursive: true, force: true }))

  return join(dir, 'bridge.sock')
}

const createClient = (
  context: TestContext,
  socketPath: string,
  requestTimeoutMs: number
): { client: BridgeClient; rejected: IRejectedEvent[] } => {
  const rejected: IRejectedEvent[] = []

  const client = new BridgeClient({
    socketPath,
    requestTimeoutMs,
    reconnectDelayMs: 50,
    onHandlerError: (event, error) => rejected.push({ event, error }),
  })

  context.after(() => client.close())

  return { client, rejected }
}

// A client of a relay whose extension said hello.
const startClient = async (
  context: TestContext,
  browserApp: string | null = null
): Promise<{ client: BridgeClient; extension: IExtensionEnd; rejected: IRejectedEvent[] }> => {
  const socketPath = await tempSocketPath(context)
  const extension = await openRelay(context, socketPath, browserApp)
  fromExtension(extension, EXTENSION_HELLO)

  return { ...createClient(context, socketPath, REQUEST_TIMEOUT_MS), extension }
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
    assert.ok(typeof beforeCommit === 'object' && beforeCommit !== null && 'deadline' in beforeCommit)
    const { deadline: _deadline, ...request } = beforeCommit

    assert.deepEqual(request, {
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
  it('should send a tab command with the deadline its timeout sets, and answer its checked result', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)

    const startedAt = Date.now()

    // Act
    const answered = client.tab('closeTab', { tabId: 4 })
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })

    // Assert
    assert.ok(typeof request === 'object' && request !== null && 'deadline' in request)
    const { deadline, ...sent } = request
    assert.deepEqual(sent, { type: 'request', id: 1, method: 'closeTab', params: { tabId: 4 } })

    assert.ok(
      typeof deadline === 'number' &&
        deadline >= startedAt + REQUEST_TIMEOUT_MS &&
        deadline <= Date.now() + REQUEST_TIMEOUT_MS
    )

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

describe('[client] Bridge client - abandoned calls', () => {
  it('should abandon only the call whose signal aborts, and cancel it at the extension', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)
    const controller = new AbortController()
    const abandoned = client.call(ACCOUNT, 'chat.postMessage', { channel: 'C0EXAMPLE1', text: 'hi' }, controller.signal)
    await extension.next()
    const kept = client.call(ACCOUNT, 'auth.test', {})
    await extension.next()

    const rejected = assert.rejects(abandoned, { name: 'BridgeError', message: 'The caller abandoned slackCall' })

    // Act
    controller.abort()
    const cancel = await extension.next()
    fromExtension(extension, { type: 'reply', id: 2, result: { ok: true } })

    // Assert
    assert.deepEqual(cancel, { type: 'cancel', id: 1 })
    await rejected
    assert.deepEqual(await kept, { ok: true })
  })

  it('should send nothing for a call whose signal aborted before it went out', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)
    const controller = new AbortController()
    controller.abort()

    // Act
    const abandoned = client.call(ACCOUNT, 'auth.test', {}, controller.signal)

    await assert.rejects(abandoned, {
      name: 'BridgeError',
      message: 'The caller abandoned slackCall before it was sent',
    })

    const next = client.tab('closeTab', { tabId: 4 })
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })

    // Assert
    assert.ok(typeof request === 'object' && request !== null && 'method' in request)
    assert.equal(request.method, 'closeTab')
    assert.deepEqual(await next, { tabId: 4 })
  })
})

// A relay of the test's own on the socket: it greets each connection as greet says, and keeps every line it is sent.
const startFakeRelay = async (
  context: TestContext,
  socketPath: string,
  greet: (socket: Socket) => void
): Promise<{ received: IQueue<unknown>; connections: IQueue<Socket> }> => {
  const received = createQueue<unknown>()
  const connections = createQueue<Socket>()
  const open = new Set<Socket>()

  const server = createServer((socket) => {
    open.add(socket)
    socket.setEncoding('utf8')
    socket.on('data', createLineReader(received.put))
    socket.on('error', () => undefined)
    socket.on('close', () => open.delete(socket))
    connections.put(socket)
    greet(socket)
  })

  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  context.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve))

    for (const socket of open) {
      socket.destroy()
    }

    await closed
  })

  return { received, connections }
}

const hostHello = (protocolRevision: number): Readonly<Record<string, unknown>> => ({
  type: 'hello',
  role: 'host',
  protocolRevision,
  componentVersion: HOST_VERSION,
  browserApp: null,
})

const READY_LEG = { type: 'extension-leg', state: 'ready' }
const CLIENT_END = { role: 'client', protocolRevision: PROTOCOL_REVISION, componentVersion: COMPONENT_VERSION }

// The diagnostic a rejection carries, or a failure of the test when it carries none.
const diagnosticOf = async (rejecting: Promise<unknown>): Promise<unknown> => {
  const error = await rejecting.then(
    () => assert.fail('The call resolved'),
    (failure: unknown) => failure
  )

  assert.ok(error instanceof BridgeIncompatibleError)

  return error.diagnostic
}

describe('[client] Bridge client - handshake', () => {
  it('should say hello as a client of its package version before anything else', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    const relay = await startFakeRelay(context, socketPath, () => undefined)
    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)

    // Act
    void client.browserApp().catch(() => undefined)
    const hello = await relay.received.next()

    // Assert
    assert.deepEqual(hello, { type: 'hello', ...CLIENT_END })
  })

  it('should become ready with a host and an extension of other package versions of the same revision', async (context) => {
    // Arrange
    const { client, extension } = await startClient(context)

    // Act
    const answered = client.tab('closeTab', { tabId: 4 })
    await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })

    // Assert
    assert.deepEqual(await answered, { tabId: 4 })
    assert.deepEqual(client.bridgeState(), { connection: 'ready', incompatibility: null })
  })

  for (const revision of [PROTOCOL_REVISION - 1, PROTOCOL_REVISION + 1]) {
    it(`should fail with the diagnostic against a host of revision ${revision}, and tell the host`, async (context) => {
      // Arrange
      const socketPath = await tempSocketPath(context)

      const relay = await startFakeRelay(context, socketPath, (socket) => {
        socket.write(encodeLine(hostHello(revision)))
        socket.write(encodeLine(READY_LEG))
      })

      const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)

      // Act
      const diagnostic = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))
      await relay.received.next()
      const told = await relay.received.next()

      // Assert
      const expected = {
        type: 'bridge-incompatible',
        reason: 'revision-mismatch',
        leg: 'host-client',
        local: CLIENT_END,
        peer: { role: 'host', protocolRevision: revision, componentVersion: HOST_VERSION },
        recovery: 'restart-browser-and-app',
      }

      assert.deepEqual([diagnostic, told], [expected, expected])
      assert.deepEqual(client.bridgeState(), { connection: 'incompatible', incompatibility: expected })
    })
  }

  it('should take the hello of a host from before versioned hellos for malformed, not for revision 1', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)

    await startFakeRelay(context, socketPath, (socket) => {
      socket.write(encodeLine({ type: 'hello', browserApp: null }))
    })

    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)

    // Act
    const diagnostic = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))

    // Assert
    assert.deepEqual(diagnostic, {
      type: 'bridge-incompatible',
      reason: 'malformed-hello',
      leg: 'host-client',
      local: CLIENT_END,
      peer: {},
      recovery: 'versions-unchecked',
    })
  })

  it('should fail with missing-hello once its deadline passes with the host silent, and close the connection', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    await startFakeRelay(context, socketPath, () => undefined)
    const timeoutMs = 200
    const { client } = createClient(context, socketPath, timeoutMs)
    const states = createQueue<IBridgeState>()
    client.onBridgeState(states.put)
    const startedAt = Date.now()

    // Act
    const diagnostic = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))
    const elapsedMs = Date.now() - startedAt
    const [expired, closed] = [await states.next(), await states.next()]

    // Assert
    assert.deepEqual(diagnostic, {
      type: 'bridge-incompatible',
      reason: 'missing-hello',
      leg: 'host-client',
      local: CLIENT_END,
      peer: {},
      recovery: 'versions-unchecked',
    })

    assert.ok(elapsedMs >= timeoutMs)

    assert.deepEqual(
      [expired, closed],
      [
        { connection: 'awaiting-hello', incompatibility: diagnostic },
        { connection: 'closed', incompatibility: diagnostic },
      ]
    )
  })

  it("should fail with missing-hello on the extension leg once its deadline passes before the extension's hello", async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    await openRelay(context, socketPath, null)
    const { client } = createClient(context, socketPath, 200)

    // Act
    const diagnostic = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))

    // Assert
    assert.deepEqual(diagnostic, {
      type: 'bridge-incompatible',
      reason: 'missing-hello',
      leg: 'extension-host',
      local: CLIENT_END,
      peer: {},
      recovery: 'versions-unchecked',
    })
  })

  it("should take a reply before the host's hello for an unexpected frame", async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)

    await startFakeRelay(context, socketPath, (socket) => {
      socket.write(encodeLine({ type: 'reply', id: 1, result: { tabId: 4 } }))
    })

    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)

    // Act
    const diagnostic = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))

    // Assert
    assert.deepEqual(diagnostic, {
      type: 'bridge-incompatible',
      reason: 'unexpected-frame',
      leg: 'host-client',
      local: CLIENT_END,
      peer: {},
      recovery: 'versions-unchecked',
    })
  })

  it('should fail the calls in flight when the host says hello a second time, never renegotiating', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)

    const relay = await startFakeRelay(context, socketPath, (socket) => {
      socket.write(encodeLine(hostHello(PROTOCOL_REVISION)))
      socket.write(encodeLine(READY_LEG))
    })

    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)
    const answered = client.tab('closeTab', { tabId: 4 })
    await relay.received.next()
    await relay.received.next()
    const socket = await relay.connections.next()

    // Act
    socket.write(encodeLine(hostHello(PROTOCOL_REVISION)))
    const diagnostic = await diagnosticOf(answered)

    // Assert
    assert.deepEqual(diagnostic, {
      type: 'bridge-incompatible',
      reason: 'unexpected-frame',
      leg: 'host-client',
      local: CLIENT_END,
      peer: { role: 'host', protocolRevision: PROTOCOL_REVISION, componentVersion: HOST_VERSION },
      recovery: 'versions-unchecked',
    })
  })

  it("should get the host's diagnostic when it connects after the extension's mismatch, keep it through the disconnect, and clear it on a later complete handshake", async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    const mismatched = await openRelay(context, socketPath, null)
    fromExtension(mismatched, { ...EXTENSION_HELLO, protocolRevision: PROTOCOL_REVISION - 1 })
    await mismatched.next()
    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)
    const states = createQueue<IBridgeState>()
    client.onBridgeState(states.put)

    // Act
    const first = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))
    const again = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))
    await states.next()
    mismatched.input.end()
    const afterClose = await states.next()
    const restarted = await openRelay(context, socketPath, null)
    fromExtension(restarted, EXTENSION_HELLO)
    const answered = client.tab('closeTab', { tabId: 4 })
    await restarted.next()
    fromExtension(restarted, { type: 'reply', id: 1, result: { tabId: 4 } })
    await answered

    // Assert
    const expected = {
      type: 'bridge-incompatible',
      reason: 'revision-mismatch',
      leg: 'extension-host',
      local: { role: 'host', protocolRevision: PROTOCOL_REVISION, componentVersion: HOST_VERSION },
      peer: { role: 'extension', protocolRevision: PROTOCOL_REVISION - 1, componentVersion: '1.2.3' },
      recovery: 'update-extension',
    }

    assert.deepEqual([first, again], [expected, expected])
    assert.deepEqual(afterClose, { connection: 'closed', incompatibility: expected })
    assert.deepEqual(client.bridgeState(), { connection: 'ready', incompatibility: null })
  })

  it('should set the deadline before the connection, so the handshake spends from it', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    const extension = await openRelay(context, socketPath, null)
    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)
    const startedAt = Date.now()
    const answered = client.tab('closeTab', { tabId: 4 })

    // Act - the extension says hello only after part of the call's budget went
    await delay(100)
    const greetedAt = Date.now()
    fromExtension(extension, EXTENSION_HELLO)
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })

    // Assert
    assert.ok(typeof request === 'object' && request !== null && 'deadline' in request)
    const { deadline } = request

    assert.ok(
      typeof deadline === 'number' &&
        deadline >= startedAt + REQUEST_TIMEOUT_MS &&
        deadline < greetedAt + REQUEST_TIMEOUT_MS
    )

    assert.deepEqual(await answered, { tabId: 4 })
  })

  it('should abandon a call whose signal aborts during the handshake, sending nothing of it', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    const extension = await openRelay(context, socketPath, null)
    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)
    const controller = new AbortController()
    const abandoned = client.call(ACCOUNT, 'auth.test', {}, controller.signal)
    const kept = client.tab('closeTab', { tabId: 4 })

    // Act
    controller.abort()

    await assert.rejects(abandoned, {
      name: 'BridgeError',
      message: 'The caller abandoned slackCall before it was sent',
    })

    fromExtension(extension, EXTENSION_HELLO)
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })

    // Assert
    assert.ok(typeof request === 'object' && request !== null && 'method' in request)
    assert.equal(request.method, 'closeTab')
    assert.deepEqual(await kept, { tabId: 4 })
  })

  it('should send listen only once the handshake completed, so no event or ack flows before', async (context) => {
    // Arrange
    const socketPath = await tempSocketPath(context)
    const extension = await openRelay(context, socketPath, null)
    const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)
    client.listen(() => Promise.resolve())
    const states = createQueue<IBridgeState>()
    client.onBridgeState(states.put)

    // Act
    fromExtension(extension, EXTENSION_HELLO)
    const ready = await states.next()
    const told = await extension.next()

    // Assert
    assert.deepEqual(ready, { connection: 'ready', incompatibility: null })
    assert.deepEqual(told, { type: 'listener' })
  })
})

describe('[client] Bridge client - send boundary', () => {
  it('should send nothing of a call whose signal aborts right after it was made on a ready connection', async (context) => {
    // Arrange - the connection is ready before the call
    const { client, extension } = await startClient(context)
    const warmUp = client.tab('closeTab', { tabId: 4 })
    await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })
    await warmUp
    const controller = new AbortController()

    // Act
    const abandoned = client.call(ACCOUNT, 'chat.postMessage', { channel: 'C0EXAMPLE1', text: 'hi' }, controller.signal)
    controller.abort()

    await assert.rejects(abandoned, {
      name: 'BridgeError',
      message: 'The caller abandoned slackCall before it was sent',
    })

    const next = client.tab('closeTab', { tabId: 5 })
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 2, result: { tabId: 5 } })

    // Assert
    assert.ok(typeof request === 'object' && request !== null && 'method' in request && 'id' in request)
    assert.deepEqual([request.method, request.id], ['closeTab', 2])
    assert.deepEqual(await next, { tabId: 5 })
  })

  for (const [last, reason, isToldBack] of [
    [
      {
        type: 'bridge-incompatible',
        reason: 'malformed-hello',
        leg: 'extension-host',
        local: { role: 'host', protocolRevision: PROTOCOL_REVISION, componentVersion: HOST_VERSION },
        peer: { role: 'extension' },
        recovery: 'versions-unchecked',
      },
      'malformed-hello',
      false,
    ],
    [hostHello(PROTOCOL_REVISION), 'unexpected-frame', true],
  ] as const) {
    it(`should fail with the typed diagnostic and send nothing when ready and a ${reason} arrive in one chunk`, async (context) => {
      // Arrange
      const socketPath = await tempSocketPath(context)

      const relay = await startFakeRelay(context, socketPath, (socket) => {
        socket.write(`${encodeLine(hostHello(PROTOCOL_REVISION))}${encodeLine(READY_LEG)}${encodeLine(last)}`)
      })

      const { client } = createClient(context, socketPath, REQUEST_TIMEOUT_MS)

      // Act
      const diagnostic = await diagnosticOf(client.tab('closeTab', { tabId: 4 }))
      await relay.received.next()
      const toldBack = isToldBack ? await relay.received.next() : null
      await drained()

      // Assert
      assert.ok(typeof diagnostic === 'object' && diagnostic !== null && 'reason' in diagnostic)
      assert.equal(diagnostic.reason, reason)
      assert.deepEqual(toldBack, isToldBack ? diagnostic : null)
      assert.equal(relay.received.size(), 0)
      assert.equal(client.bridgeState().connection, 'incompatible')
    })
  }

  it('should send nothing of a call whose deadline passed between the ready connection and the send', async (context) => {
    // Arrange - the connection is ready, and the clock is the test's from here
    const { client, extension } = await startClient(context)
    const warmUp = client.tab('closeTab', { tabId: 4 })
    await extension.next()
    fromExtension(extension, { type: 'reply', id: 1, result: { tabId: 4 } })
    await warmUp
    context.mock.timers.enable({ apis: ['Date'], now: Date.now() })

    // Act
    const late = client.tab('closeTab', { tabId: 5 })
    context.mock.timers.tick(REQUEST_TIMEOUT_MS)

    await assert.rejects(late, {
      name: 'BridgeError',
      message: "The caller's deadline passed before closeTab was sent",
    })

    context.mock.timers.reset()
    const next = client.tab('closeTab', { tabId: 6 })
    const request = await extension.next()
    fromExtension(extension, { type: 'reply', id: 2, result: { tabId: 6 } })

    // Assert
    assert.ok(typeof request === 'object' && request !== null && 'params' in request)
    assert.deepEqual(request.params, { tabId: 6 })
    assert.deepEqual(await next, { tabId: 6 })
  })
})
