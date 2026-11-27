import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it, type TestContext } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { createLineReader, encodeFrame, encodeLine, HOST_MESSAGE_MAX_BYTES } from '../protocol/framing.js'
import { PROTOCOL_REVISION } from '../protocol/messages.js'
import { type SlackEvent, slackEventKey } from '../protocol/slack.js'
import { startNativeHostRelay } from './relay.js'
import {
  createQueue,
  drained,
  EXTENSION_HELLO,
  HOST_VERSION,
  type IQueue,
  listenOn,
  startTestRelay,
  TAKEOVER_DEADLINE_MS,
} from './testing.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const BROWSER_APP = 'Example Browser.app'

const HOST_HELLO = {
  type: 'hello',
  role: 'host',
  protocolRevision: PROTOCOL_REVISION,
  componentVersion: HOST_VERSION,
  browserApp: BROWSER_APP,
}

const CLIENT_HELLO = { type: 'hello', role: 'client', protocolRevision: PROTOCOL_REVISION, componentVersion: '1.2.4' }
// A caller's deadline that has not passed (2100-01-01).
const DEADLINE = 4_102_444_800_000

const STATUS = {
  type: 'status',
  identities: [],
  captures: [],
  queue: { state: 'committing', droppedEvents: 0 },
  parity: [],
}

interface IRelay {
  readonly server: Server
  readonly socketPath: string
  // The extension's end of the native messaging pipe: frames written here reach the relay, and what the relay sends
  // the extension arrives in the inbox.
  readonly input: PassThrough
  readonly extension: IQueue<unknown>
}

interface IClient {
  readonly socket: Socket
  readonly inbox: IQueue<unknown>
}

const eventAt = (ts: string): SlackEvent => {
  const frame = { type: 'message', channel: 'C0EXAMPLE1', ts, text: 'hello' } as const

  return { type: 'event', id: slackEventKey(ACCOUNT, frame), account: ACCOUNT, frame }
}

const tempDir = async (context: TestContext): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'misha-relay-'))
  context.after(() => rm(dir, { recursive: true, force: true }))

  return dir
}

const send = ({ socket }: IClient, message: unknown): void => {
  socket.write(encodeLine(message))
}

const fromExtension = ({ input }: IRelay, frame: unknown): void => {
  input.write(encodeFrame(frame))
}

// A relay whose extension has not said hello yet, with the host's hello it sent the extension taken.
const openRelayAt = async (context: TestContext, socketPath: string): Promise<IRelay> => {
  const { server, input, frames: extension } = await startTestRelay(context, socketPath, BROWSER_APP)
  assert.deepEqual(await extension.next(), HOST_HELLO)

  return { server, socketPath, input, extension }
}

const openRelay = async (context: TestContext): Promise<IRelay> =>
  openRelayAt(context, join(await tempDir(context), 'bridge', 'bridge.sock'))

// A relay whose extension said hello, so its extension leg is ready.
const startRelayAt = async (context: TestContext, socketPath: string): Promise<IRelay> => {
  const relay = await openRelayAt(context, socketPath)
  fromExtension(relay, EXTENSION_HELLO)

  return relay
}

const startRelay = async (context: TestContext): Promise<IRelay> =>
  startRelayAt(context, join(await tempDir(context), 'bridge', 'bridge.sock'))

const takeOverWith = (socketPath: string, input: PassThrough, takeoverDeadlineMs: number | null): Promise<Server> =>
  startNativeHostRelay({
    input,
    output: new PassThrough(),
    socketPath,
    browserApp: BROWSER_APP,
    componentVersion: HOST_VERSION,
    takeoverDeadlineMs,
  })

const startRelayIn = (socketPath: string): Promise<Server> =>
  takeOverWith(socketPath, new PassThrough(), TAKEOVER_DEADLINE_MS)

// A connection that has not said hello, with the relay's hello taken.
const openClient = async ({ socketPath }: IRelay): Promise<IClient> => {
  const socket = createConnection(socketPath)
  const inbox = createQueue<unknown>()
  socket.setEncoding('utf8')
  socket.on('data', createLineReader(inbox.put))
  assert.deepEqual(await inbox.next(), HOST_HELLO)

  return { socket, inbox }
}

// A client whose hello agreed, once the relay reports a ready extension leg: the leg may still have been awaiting the
// extension's hello, already on its way, when the client connected.
const connectClient = async (relay: IRelay): Promise<IClient> => {
  const client = await openClient(relay)
  send(client, CLIENT_HELLO)

  const leg = await client.inbox.next()
  if (isDeepStrictEqual(leg, { type: 'extension-leg', state: 'awaiting-hello' })) {
    assert.deepEqual(await client.inbox.next(), { type: 'extension-leg', state: 'ready' })
  } else {
    assert.deepEqual(leg, { type: 'extension-leg', state: 'ready' })
  }

  return client
}

// Resolves once the relay closed the client's connection; a write cut off by it is no failure of the test.
const closeOf = ({ socket }: IClient): Promise<unknown> => {
  socket.on('error', () => undefined)

  return new Promise((resolve) => socket.once('close', resolve))
}

// A request that went through and its reply came back proves the relay handled everything the client sent before it,
// and that nothing else reached the client in between.
const roundTrip = async (relay: IRelay, client: IClient): Promise<void> => {
  send(client, { type: 'request', id: 99, method: 'slackCall', params: {}, deadline: DEADLINE })
  const request = await relay.extension.next()
  assert.ok(typeof request === 'object' && request !== null && 'id' in request && typeof request.id === 'number')
  fromExtension(relay, { type: 'reply', id: request.id, result: { ok: true } })
  assert.deepEqual(await client.inbox.next(), { type: 'reply', id: 99, result: { ok: true } })
}

describe('[host] Relay - bridge folder', () => {
  it('should make an existing bridge folder others may open owner-only before it binds', async (context) => {
    // Arrange
    const bridgeDir = join(await tempDir(context), 'bridge')
    await mkdir(bridgeDir)
    await chmod(bridgeDir, 0o777)

    // Act
    await startRelayAt(context, join(bridgeDir, 'bridge.sock'))

    // Assert
    assert.equal((await stat(bridgeDir)).mode.toString(8).slice(-3), '700')
  })

  it('should refuse a bridge folder that is a symlink', async (context) => {
    // Arrange
    const dir = await tempDir(context)
    await mkdir(join(dir, 'elsewhere'), { mode: 0o700 })
    await symlink(join(dir, 'elsewhere'), join(dir, 'bridge'))

    // Act + Assert
    await assert.rejects(
      startRelayIn(join(dir, 'bridge', 'bridge.sock')),
      /must be a folder of this user, not a symlink/u
    )
  })

  it('should refuse a bridge folder whose parent others may write to', async (context) => {
    // Arrange
    const dir = await tempDir(context)
    await chmod(dir, 0o777)

    // Act + Assert
    await assert.rejects(startRelayIn(join(dir, 'bridge', 'bridge.sock')), /that nobody else may write to/u)
  })

  it('should refuse a bridge folder, or its parent, whose ACL allows others in, though its mode is owner-only', async (context) => {
    // Arrange
    const [grantedParent, grantedFolder] = [await tempDir(context), await tempDir(context)]
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow add_subdirectory,delete_child', grantedParent])
    await mkdir(join(grantedFolder, 'bridge'), { mode: 0o700 })
    execFileSync('/bin/chmod', ['+a', 'group:everyone allow list,search,add_file', join(grantedFolder, 'bridge')])

    // Act + Assert
    await assert.rejects(startRelayIn(join(grantedParent, 'bridge', 'bridge.sock')), {
      message: `${grantedParent} has an ACL entry that allows access (ls -le lists it, and chmod -N removes it)`,
    })

    await assert.rejects(startRelayIn(join(grantedFolder, 'bridge', 'bridge.sock')), {
      message: `${join(grantedFolder, 'bridge')} has an ACL entry that allows access (ls -le lists it, and chmod -N removes it)`,
    })
  })

  it('should take a parent whose ACL only denies', async (context) => {
    // Arrange - a home folder denies delete; this denies what the test's cleanup does not need
    const dir = await tempDir(context)
    execFileSync('/bin/chmod', ['+a', 'group:everyone deny add_file', dir])

    // Act
    const relay = await startRelayAt(context, join(dir, 'bridge', 'bridge.sock'))

    // Assert
    await roundTrip(relay, await connectClient(relay))
  })
})

describe('[host] Relay - socket takeover', () => {
  it('should take the socket over from a live relay, whose closing later leaves the new socket in place', async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    const older = await startRelayAt(context, socketPath)
    const olderClient = await connectClient(older)
    const olderClientClose = once(olderClient.socket, 'close')

    // Act
    const newer = await startRelayAt(context, socketPath)
    await olderClientClose
    older.input.end()
    await once(older.input, 'end')

    // Assert
    assert.equal(older.server.listening, false)
    await roundTrip(newer, await connectClient(newer))
  })

  it('should remove a socket nothing listens on, left by a host that crashed', async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    await mkdir(dirname(socketPath), { mode: 0o700 })

    spawnSync(process.execPath, [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
      socketPath,
    ])

    const isStaleSocket = (await lstat(socketPath)).isSocket()

    // Act
    const relay = await startRelayAt(context, socketPath)

    // Assert
    assert.equal(isStaleSocket, true)
    await roundTrip(relay, await connectClient(relay))
  })

  it('should let two hosts that find one stale socket take the path in turn, so neither removes the live one', async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    await mkdir(dirname(socketPath), { mode: 0o700 })

    spawnSync(process.execPath, [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
      socketPath,
    ])

    // Act
    const relays = await Promise.all([startRelayAt(context, socketPath), startRelayAt(context, socketPath)])
    const taken = relays.filter(({ server }) => !server.listening)

    for (const { input } of taken) {
      input.end()
      await once(input, 'end')
    }

    // Assert
    assert.equal(taken.length, 1)
    const live = relays.find(({ server }) => server.listening)
    assert.ok(live !== undefined)
    await roundTrip(live, await connectClient(live))
  })

  it('should leave anything but a socket at the path alone, and fail', async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    await mkdir(dirname(socketPath), { mode: 0o700 })
    await writeFile(socketPath, 'not a socket')

    // Act + Assert
    await assert.rejects(startRelayIn(socketPath), /holds no socket a relay can take over/u)
    assert.equal((await lstat(socketPath)).isFile(), true)
  })
})

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
    send(first, { type: 'request', id: 1, method: 'slackCall', params: { order: 1 }, deadline: DEADLINE })
    const firstRequest = await relay.extension.next()
    send(second, { type: 'request', id: 1, method: 'slackDownload', params: { order: 2 }, deadline: DEADLINE })
    const secondRequest = await relay.extension.next()
    fromExtension(relay, { type: 'reply', id: 2, result: { ok: true } })
    fromExtension(relay, { type: 'reply', id: 1, error: 'Tab 12 closed' })

    // Assert
    assert.deepEqual(
      [firstRequest, secondRequest],
      [
        { type: 'request', id: 1, method: 'slackCall', params: { order: 1 }, deadline: DEADLINE },
        { type: 'request', id: 2, method: 'slackDownload', params: { order: 2 }, deadline: DEADLINE },
      ]
    )

    assert.deepEqual(await second.inbox.next(), { type: 'reply', id: 1, result: { ok: true } })
    assert.deepEqual(await first.inbox.next(), { type: 'reply', id: 1, error: 'Tab 12 closed' })
  })
})

describe('[host] Relay - message size', () => {
  it('should refuse a request too large for the extension without writing it, keeping the pipe and the client', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const client = await connectClient(relay)
    const text = 'x'.repeat(HOST_MESSAGE_MAX_BYTES)

    // Act
    send(client, { type: 'request', id: 7, method: 'slackCall', params: { text }, deadline: DEADLINE })
    const refusal = await client.inbox.next()

    // Assert
    assert.deepEqual(refusal, {
      type: 'reply',
      id: 7,
      error: `The request is larger than the ${HOST_MESSAGE_MAX_BYTES} bytes the extension takes from its host`,
    })

    await roundTrip(relay, client)
  })

  it('should close a client whose line runs on past the limit, and keep serving the others', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [endless, other] = [await connectClient(relay), await connectClient(relay)]
    const closed = closeOf(endless)

    // Act
    endless.socket.write('x'.repeat(2 * HOST_MESSAGE_MAX_BYTES + 1))
    await closed

    // Assert
    await roundTrip(relay, other)
  })

  it('should close a listener whose ack is too large to pass on, and keep the pipe', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [listener, other] = [await connectClient(relay), await connectClient(relay)]
    send(listener, { type: 'listen' })
    await relay.extension.next()
    const closed = closeOf(listener)

    // Act
    send(listener, { type: 'ack', id: 'x'.repeat(HOST_MESSAGE_MAX_BYTES) })
    await closed

    // Assert
    await roundTrip(relay, other)
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
    send(bystander, { type: 'request', id: 5, method: 'slackCall', params: {}, deadline: DEADLINE })
    const afterBystander = await relay.extension.next()
    send(listener, { type: 'ack', id: acknowledged.id })
    const afterListener = await relay.extension.next()

    // Assert
    assert.deepEqual(afterBystander, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
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

describe('[host] Relay - callers that gave up', () => {
  it("should pass a client's cancel on under the extension's id, and drop the reply that still comes", async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [other, client] = [await connectClient(relay), await connectClient(relay)]
    send(other, { type: 'request', id: 4, method: 'slackCall', params: {}, deadline: DEADLINE })
    await relay.extension.next()
    send(client, { type: 'request', id: 4, method: 'slackCall', params: {}, deadline: DEADLINE })
    await relay.extension.next()

    // Act
    send(client, { type: 'cancel', id: 4 })
    const cancel = await relay.extension.next()
    fromExtension(relay, { type: 'reply', id: 2, error: 'The caller gave up on the request before it was sent' })
    fromExtension(relay, { type: 'reply', id: 1, result: { ok: true } })

    // Assert
    assert.deepEqual(cancel, { type: 'cancel', id: 2 })
    assert.deepEqual(await other.inbox.next(), { type: 'reply', id: 4, result: { ok: true } })
    await roundTrip(relay, client)
  })

  it("should cancel every pending request of a client whose connection closed, and no other client's", async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [leaving, staying] = [await connectClient(relay), await connectClient(relay)]
    send(leaving, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
    await relay.extension.next()
    send(staying, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
    await relay.extension.next()
    send(leaving, { type: 'request', id: 2, method: 'slackDownload', params: {}, deadline: DEADLINE })
    await relay.extension.next()

    // Act
    leaving.socket.destroy()
    const cancels = [await relay.extension.next(), await relay.extension.next()]

    // Assert
    assert.deepEqual(cancels, [
      { type: 'cancel', id: 1 },
      { type: 'cancel', id: 3 },
    ])

    fromExtension(relay, { type: 'reply', id: 2, result: { ok: true } })
    assert.deepEqual(await staying.inbox.next(), { type: 'reply', id: 1, result: { ok: true } })
  })

  it('should pass on no cancel for a request that was answered, or that another client sent', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [first, second] = [await connectClient(relay), await connectClient(relay)]
    send(first, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
    await relay.extension.next()
    fromExtension(relay, { type: 'reply', id: 1, result: { ok: true } })
    await first.inbox.next()

    // Act
    send(first, { type: 'cancel', id: 1 })
    send(second, { type: 'cancel', id: 1 })

    // Assert
    await roundTrip(relay, second)
  })
})

// The host's diagnostic for a leg, as the relay sends it.
const hostDiagnostic = (
  reason: string,
  leg: string,
  peer: Readonly<Record<string, unknown>>,
  recovery: string
): Readonly<Record<string, unknown>> => ({
  type: 'bridge-incompatible',
  reason,
  leg,
  local: { role: 'host', protocolRevision: PROTOCOL_REVISION, componentVersion: HOST_VERSION },
  peer,
  recovery,
})

describe('[host] Relay - client handshake', () => {
  it("should greet a client at once with its hello and the extension leg's state, before the extension said hello", async (context) => {
    // Arrange
    const relay = await openRelay(context)
    const client = await openClient(relay)

    // Act
    const awaiting = await client.inbox.next()
    send(client, CLIENT_HELLO)
    fromExtension(relay, EXTENSION_HELLO)
    const ready = await client.inbox.next()

    // Assert
    assert.deepEqual(
      [awaiting, ready],
      [
        { type: 'extension-leg', state: 'awaiting-hello' },
        { type: 'extension-leg', state: 'ready' },
      ]
    )

    await roundTrip(relay, client)
  })

  for (const revision of [PROTOCOL_REVISION - 1, PROTOCOL_REVISION + 1]) {
    it(`should refuse a client of revision ${revision} with its diagnostic and end its connection`, async (context) => {
      // Arrange
      const relay = await startRelay(context)
      const client = await openClient(relay)
      await client.inbox.next()
      const closed = closeOf(client)

      // Act
      send(client, { type: 'hello', role: 'client', protocolRevision: revision, componentVersion: '1.2.4' })
      const refusal = await client.inbox.next()
      await closed

      // Assert
      assert.deepEqual(
        refusal,
        hostDiagnostic(
          'revision-mismatch',
          'host-client',
          { role: 'client', protocolRevision: revision, componentVersion: '1.2.4' },
          'restart-browser-and-app'
        )
      )

      await roundTrip(relay, await connectClient(relay))
    })
  }

  it('should refuse a hello with no revision or one that does not read, naming only what read', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [missing, malformed] = [await openClient(relay), await openClient(relay)]
    await Promise.all([missing.inbox.next(), malformed.inbox.next()])

    // Act
    send(missing, { type: 'hello', role: 'client', componentVersion: '1.2.4' })
    send(malformed, { type: 'hello', role: 'client', protocolRevision: PROTOCOL_REVISION, componentVersion: 7 })
    const refusals = [await missing.inbox.next(), await malformed.inbox.next()]

    // Assert
    assert.deepEqual(refusals, [
      hostDiagnostic(
        'malformed-hello',
        'host-client',
        { role: 'client', componentVersion: '1.2.4' },
        'versions-unchecked'
      ),
      hostDiagnostic(
        'malformed-hello',
        'host-client',
        { role: 'client', protocolRevision: PROTOCOL_REVISION },
        'versions-unchecked'
      ),
    ])
  })

  it('should refuse a client that sends a request before its hello, and pass nothing on', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const client = await openClient(relay)
    await client.inbox.next()

    // Act
    send(client, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
    const refusal = await client.inbox.next()
    await drained()

    // Assert
    assert.deepEqual(refusal, hostDiagnostic('unexpected-frame', 'host-client', {}, 'versions-unchecked'))
    assert.equal(relay.extension.size(), 0)
  })

  it('should close a client that says hello twice, and keep serving the others', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const [repeating, other] = [await connectClient(relay), await connectClient(relay)]
    const closed = closeOf(repeating)

    // Act
    send(repeating, CLIENT_HELLO)
    await closed

    // Assert
    await roundTrip(relay, other)
  })

  it('should close a client that sends a request while the extension leg awaits its hello', async (context) => {
    // Arrange
    const relay = await openRelay(context)
    const client = await openClient(relay)
    await client.inbox.next()
    send(client, CLIENT_HELLO)
    const closed = closeOf(client)

    // Act
    send(client, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
    await closed
    await drained()

    // Assert
    assert.equal(relay.extension.size(), 0)
  })
})

describe('[host] Relay - extension handshake', () => {
  for (const [revision, recovery] of [
    [PROTOCOL_REVISION - 1, 'update-extension'],
    [PROTOCOL_REVISION + 1, 'update-app'],
  ] as const) {
    it(`should answer an extension of revision ${revision} with its diagnostic, which says ${recovery}`, async (context) => {
      // Arrange
      const relay = await openRelay(context)

      // Act
      fromExtension(relay, { ...EXTENSION_HELLO, protocolRevision: revision })
      const diagnostic = await relay.extension.next()

      // Assert
      assert.deepEqual(
        diagnostic,
        hostDiagnostic(
          'revision-mismatch',
          'extension-host',
          { role: 'extension', protocolRevision: revision, componentVersion: '1.2.3' },
          recovery
        )
      )
    })
  }

  it('should answer an extension whose first frame is no hello with its diagnostic', async (context) => {
    // Arrange
    const relay = await openRelay(context)

    // Act
    fromExtension(relay, STATUS)
    const diagnostic = await relay.extension.next()

    // Assert
    assert.deepEqual(diagnostic, hostDiagnostic('unexpected-frame', 'extension-host', {}, 'versions-unchecked'))
  })

  it('should make the leg incompatible on a second hello from the extension', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const client = await connectClient(relay)

    // Act
    fromExtension(relay, EXTENSION_HELLO)
    const [toExtension, toClient] = [await relay.extension.next(), await client.inbox.next()]

    // Assert
    const diagnostic = hostDiagnostic(
      'unexpected-frame',
      'extension-host',
      { role: 'extension', protocolRevision: PROTOCOL_REVISION, componentVersion: '1.2.3' },
      'versions-unchecked'
    )

    assert.deepEqual([toExtension, toClient], [diagnostic, diagnostic])
  })

  it("should hand a client that connects after the extension's mismatch the diagnostic at once, and pass none of its traffic on", async (context) => {
    // Arrange
    const relay = await openRelay(context)
    fromExtension(relay, { ...EXTENSION_HELLO, protocolRevision: PROTOCOL_REVISION + 1 })
    const diagnostic = await relay.extension.next()
    const client = await openClient(relay)

    // Act
    const retained = await client.inbox.next()
    send(client, CLIENT_HELLO)
    const closed = closeOf(client)
    send(client, { type: 'listen' })
    await closed
    await drained()

    // Assert
    assert.deepEqual(retained, diagnostic)
    assert.equal(relay.extension.size(), 0)
  })

  it('should tell its clients when the extension finds the host incompatible, and drop their requests and listener', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const client = await connectClient(relay)
    send(client, { type: 'listen' })
    await relay.extension.next()
    send(client, { type: 'request', id: 1, method: 'slackCall', params: {}, deadline: DEADLINE })
    await relay.extension.next()

    const fromTheExtension = {
      type: 'bridge-incompatible',
      reason: 'malformed-hello',
      leg: 'extension-host',
      local: { role: 'extension', protocolRevision: PROTOCOL_REVISION, componentVersion: '1.2.3' },
      peer: { role: 'host' },
      recovery: 'versions-unchecked',
    }

    // Act
    fromExtension(relay, fromTheExtension)
    const told = await client.inbox.next()
    fromExtension(relay, { type: 'reply', id: 1, result: { ok: true } })
    fromExtension(relay, eventAt('1700000001.000100'))
    const closed = closeOf(client)
    send(client, { type: 'ack', id: eventAt('1700000001.000100').id })
    await closed
    await drained()

    // Assert
    assert.deepEqual(told, fromTheExtension)
    assert.equal(client.inbox.size(), 0)
    assert.equal(relay.extension.size(), 0)
  })
})

describe('[host] Relay - takeover handshake', () => {
  it("should let a host take the socket over while the holder's extension has not said hello", async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    const older = await openRelayAt(context, socketPath)

    // Act
    const newer = await startRelayAt(context, socketPath)

    // Assert
    assert.equal(older.server.listening, false)
    await roundTrip(newer, await connectClient(newer))
  })

  it('should refuse a takeover peer of another revision with its diagnostic, and keep the socket', async (context) => {
    // Arrange
    const relay = await startRelay(context)
    const peer = await openClient(relay)
    await peer.inbox.next()
    const closed = closeOf(peer)

    // Act
    send(peer, { type: 'hello', role: 'takeover', protocolRevision: PROTOCOL_REVISION + 1, componentVersion: '9.9.9' })
    send(peer, { type: 'takeover' })
    const refusal = await peer.inbox.next()
    await closed

    // Assert
    assert.deepEqual(
      refusal,
      hostDiagnostic(
        'revision-mismatch',
        'host-client',
        { role: 'takeover', protocolRevision: PROTOCOL_REVISION + 1, componentVersion: '9.9.9' },
        'restart-browser-and-app'
      )
    )

    assert.equal(relay.server.listening, true)
    await roundTrip(relay, await connectClient(relay))
  })

  for (const [holderHello, reason] of [
    [{ ...HOST_HELLO, protocolRevision: PROTOCOL_REVISION + 1 }, 'revision-mismatch'],
    [{ type: 'hello', browserApp: BROWSER_APP }, 'malformed-hello'],
  ] as const) {
    it(`should not take the socket from a holder whose hello is a ${reason}, telling it why`, async (context) => {
      // Arrange - a holder that greets each connection and keeps what it is sent
      const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
      await mkdir(dirname(socketPath), { mode: 0o700 })
      const received = createQueue<unknown>()

      const holder = createServer((socket) => {
        socket.setEncoding('utf8')
        socket.on('data', createLineReader(received.put))
        socket.on('end', () => socket.end())
        socket.write(encodeLine(holderHello))
      })

      await new Promise<void>((resolve) => holder.listen(socketPath, resolve))
      context.after(() => new Promise((resolve) => holder.close(resolve)))

      // Act + Assert
      await assert.rejects(startRelayIn(socketPath), { message: new RegExp(`^Could not take ${socketPath} over`, 'u') })
      const told = await received.next()
      assert.ok(typeof told === 'object' && told !== null && 'reason' in told && 'local' in told)

      assert.deepEqual(
        [told.reason, told.local],
        [reason, { role: 'takeover', protocolRevision: PROTOCOL_REVISION, componentVersion: HOST_VERSION }]
      )

      assert.equal(holder.listening, true)
    })
  }
})

// A holder of the socket path that the test controls: it greets each connection with greeting, or stays silent when
// greeting is null, keeps every line it is sent, and keeps its side of each connection open whatever the peer does.
// ends: one entry each time a peer ended its side of a connection.
const startHolder = async (
  context: TestContext,
  socketPath: string,
  greeting: unknown
): Promise<{
  readonly server: Server
  readonly accepted: IQueue<unknown>
  readonly received: IQueue<unknown>
  readonly ends: IQueue<unknown>
}> => {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  const accepted = createQueue<unknown>()
  const received = createQueue<unknown>()
  const ends = createQueue<unknown>()

  const server = await listenOn(context, socketPath, { allowHalfOpen: true }, (socket) => {
    accepted.put('accepted')
    socket.setEncoding('utf8')
    socket.on('data', createLineReader(received.put))
    socket.on('error', () => undefined)
    socket.on('end', () => ends.put('ended'))

    if (greeting !== null) {
      socket.write(encodeLine(greeting))
    }
  })

  return { server, accepted, received, ends }
}

// A deadline far shorter than the tests' own, for the takeovers that are meant to run into it.
const SHORT_TAKEOVER_DEADLINE_MS = 100

describe('[host] Relay - takeover bounds', () => {
  it('should give up on a silent holder at its deadline, leave its socket in place and release the bridge lock', async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    const holder = await startHolder(context, socketPath, null)

    // Act
    const first = takeOverWith(socketPath, new PassThrough(), SHORT_TAKEOVER_DEADLINE_MS)

    await assert.rejects(first, {
      message: `Could not take ${socketPath} over: the takeover did not finish within ${SHORT_TAKEOVER_DEADLINE_MS} ms`,
    })

    await holder.ends.next()
    const second = takeOverWith(socketPath, new PassThrough(), SHORT_TAKEOVER_DEADLINE_MS)

    // Assert - the second host got the lock, so the first released it
    await assert.rejects(second, {
      message: new RegExp(`the takeover did not finish within ${SHORT_TAKEOVER_DEADLINE_MS} ms$`, 'u'),
    })

    assert.equal(holder.server.listening, true)
    assert.equal((await lstat(socketPath)).isSocket(), true)
  })

  it('should close the connection to a holder of another revision that keeps it open, with no deadline set', async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    const holder = await startHolder(context, socketPath, { ...HOST_HELLO, protocolRevision: PROTOCOL_REVISION + 1 })

    // Act
    await assert.rejects(takeOverWith(socketPath, new PassThrough(), null), {
      message: new RegExp(`^Could not take ${socketPath} over: The browser bridge between the native host`, 'u'),
    })

    const told = await holder.received.next()
    await holder.ends.next()

    // Assert
    assert.ok(typeof told === 'object' && told !== null && 'reason' in told)
    assert.equal(told.reason, 'revision-mismatch')
    assert.equal(holder.server.listening, true)
    assert.equal((await lstat(socketPath)).isSocket(), true)
  })

  it("should give up the takeover when the browser's pipe ends, with no deadline set, and release the bridge lock", async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    const holder = await startHolder(context, socketPath, null)
    const input = new PassThrough()
    const taking = takeOverWith(socketPath, input, null)

    const rejected = assert.rejects(taking, {
      message: `Could not take ${socketPath} over: the browser's native pipe ended`,
    })

    // Act
    await holder.accepted.next()
    input.end()
    await rejected
    await holder.ends.next()

    // Assert - a later host gets the lock, so the one whose pipe ended released it
    await assert.rejects(takeOverWith(socketPath, new PassThrough(), SHORT_TAKEOVER_DEADLINE_MS), {
      message: new RegExp(`the takeover did not finish within ${SHORT_TAKEOVER_DEADLINE_MS} ms$`, 'u'),
    })

    assert.equal(holder.server.listening, true)
  })
})

// The bridge lock as relay.ts takes it: macOS's O_EXLOCK (0x20 in sys/fcntl.h) opens the file with an exclusive flock,
// waiting while another open file holds one. Each flag is its own bit, so their sum is the mask.
const O_EXLOCK = 0x20
const LOCK_OPEN_FLAGS = constants.O_RDWR + constants.O_CREAT + O_EXLOCK

// Takes the bridge lock twice in a row and lets it go each time. Whichever order the test and a host's late lock open
// take it in, the second take returns only once that late open got the lock and closed it again.
const lockTakenTwice = async (socketPath: string): Promise<void> => {
  for (let take = 0; take < 2; take += 1) {
    const lock = await open(`${socketPath}.lock`, LOCK_OPEN_FLAGS, 0o600)
    await lock.close()
  }
}

describe('[host] Relay - takeover acquisition', () => {
  it('should give up at its deadline while another host holds the bridge lock, and close the lock it gets later without binding', async (context) => {
    // Arrange - the test holds the bridge lock as another host would
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    await mkdir(dirname(socketPath), { mode: 0o700 })
    const held = await open(`${socketPath}.lock`, LOCK_OPEN_FLAGS, 0o600)

    // Act
    await assert.rejects(takeOverWith(socketPath, new PassThrough(), SHORT_TAKEOVER_DEADLINE_MS), {
      message: `Could not take ${socketPath} over: the takeover did not finish within ${SHORT_TAKEOVER_DEADLINE_MS} ms`,
    })

    await held.close()
    await lockTakenTwice(socketPath)

    // Assert - the late lock was closed, and nothing was bound at the path
    assert.equal(await lstat(socketPath).catch(() => null), null)
  })

  it("should give up when the browser's pipe ends while another host holds the bridge lock, with no deadline set", async (context) => {
    // Arrange
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    await mkdir(dirname(socketPath), { mode: 0o700 })
    const held = await open(`${socketPath}.lock`, LOCK_OPEN_FLAGS, 0o600)
    const input = new PassThrough()
    const taking = takeOverWith(socketPath, input, null)

    // Act
    input.end()
    await assert.rejects(taking, { message: `Could not take ${socketPath} over: the browser's native pipe ended` })
    await held.close()
    await lockTakenTwice(socketPath)

    // Assert
    assert.equal(await lstat(socketPath).catch(() => null), null)
  })

  it("should give up when the browser's pipe ends before its connect to the holder completed, leaving the holder's socket", async (context) => {
    // Arrange - the holder ends the new host's pipe as it accepts, before the new host's side sees its connect
    const socketPath = join(await tempDir(context), 'bridge', 'bridge.sock')
    await mkdir(dirname(socketPath), { mode: 0o700 })
    const input = new PassThrough()

    const holder = await listenOn(context, socketPath, { allowHalfOpen: true }, (socket) => {
      socket.on('error', () => undefined)
      input.end()
    })

    // Act
    await assert.rejects(takeOverWith(socketPath, input, null), {
      message: `Could not take ${socketPath} over: the browser's native pipe ended`,
    })

    await lockTakenTwice(socketPath)

    // Assert
    assert.equal(holder.listening, true)
    assert.equal((await lstat(socketPath)).isSocket(), true)
  })
})
