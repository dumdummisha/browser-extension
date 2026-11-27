import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { PROTOCOL_REVISION } from '../protocol/messages.js'
import { type SlackEvent, slackEventKey } from '../protocol/slack.js'
import { openPendingQueue, PendingQueueWriter } from './pending-queue-writer.js'
import { chromeEvent, emit, fakeWebRequest, HOST_HELLO, type IChromeEvent, settled } from './testing.js'

// The service worker's native link under the races of its asynchronous status work: the status snapshot a listener
// waits for is held by the test, and the link turns incompatible or is replaced while it waits.

// One native port the worker opened: what the host sends it, and every frame the worker posted on it.
interface IFakePort {
  readonly onMessage: IChromeEvent
  readonly onDisconnect: IChromeEvent
  readonly posted: unknown[]
}

// The fake Chrome of one worker: its ports in the order it opened them, its reconnect alarm, and the answer of
// tabs.query, which the status snapshot waits for.
interface IFakeChrome {
  readonly ports: IFakePort[]
  readonly onAlarm: IChromeEvent
  tabsAnswer: () => Promise<unknown[]>
}

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const FRAME = { type: 'message', channel: 'D0EXAMPLE1', ts: '1700000001.000100', text: 'hello' } as const
const EVENT: SlackEvent = { type: 'event', id: slackEventKey(ACCOUNT, FRAME), account: ACCOUNT, frame: FRAME }
const EXTENSION_VERSION = '1.2.3'

const EXTENSION_HELLO = {
  type: 'hello',
  role: 'extension',
  protocolRevision: PROTOCOL_REVISION,
  componentVersion: EXTENSION_VERSION,
}

let workers = 0

// Waits for the port to have posted at least count frames, and fails with what it posted when it never does.
const untilPosted = async (port: IFakePort, count: number): Promise<void> => {
  for (let step = 0; step < 50 && port.posted.length < count; step += 1) {
    await settled()
  }

  assert.ok(port.posted.length >= count, `The port posted ${JSON.stringify(port.posted)}`)
}

// A listener's link gets the extension's hello, its status, then the pending event; a status push the queue's health
// changes may follow, and nothing else.
const assertListenedOn = (port: IFakePort): void => {
  const [hello, status, event, ...later] = typesOf(port)
  assert.deepEqual([hello, status, event], ['hello', 'status', 'event'])
  assert.deepEqual(port.posted[2], EVENT)

  assert.ok(
    later.every((type) => type === 'status'),
    `The port posted ${JSON.stringify(port.posted)}`
  )
}

const fakeChrome = (state: IFakeChrome): object => ({
  runtime: {
    connectNative: () => {
      const port: IFakePort = { onMessage: chromeEvent(), onDisconnect: chromeEvent(), posted: [] }
      state.ports.push(port)

      return {
        onMessage: port.onMessage,
        onDisconnect: port.onDisconnect,
        postMessage: (frame: unknown) => port.posted.push(frame),
      }
    },
    onMessage: chromeEvent(),
    getManifest: () => ({ name: 'Misha Browser', version: EXTENSION_VERSION }),
  },
  action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
  tabs: {
    query: () => state.tabsAnswer(),
    sendMessage: () => Promise.reject(new Error('No tab in this test has a relay')),
    onRemoved: chromeEvent(),
    onUpdated: chromeEvent(),
  },
  scripting: { executeScript: () => Promise.reject(new Error('No tab in this test runs a script')) },
  webRequest: fakeWebRequest(),
  alarms: { create: () => Promise.resolve(), onAlarm: state.onAlarm },
})

// A worker of the test's own, whose pending queue already holds EVENT, with its first native port open. The worker is
// left with no listener attached when the test ends, so no redelivery timer outlives it.
const startWorker = async (context: TestContext): Promise<IFakeChrome> => {
  const factory = new IDBFactory()

  const seeding = new PendingQueueWriter(() => openPendingQueue(factory), {
    onRestored: () => undefined,
    onHealthChange: () => undefined,
  })

  await seeding.recover()
  assert.equal(await seeding.admit(EVENT), 'stored')

  const state: IFakeChrome = { ports: [], onAlarm: chromeEvent(), tabsAnswer: () => Promise.resolve([]) }
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true })
  Object.defineProperty(globalThis, 'chrome', { value: fakeChrome(state), configurable: true })
  workers += 1
  await import(`../extension/background.js?native-link=${workers}`)

  context.after(() => {
    for (const port of state.ports) {
      emit(port.onDisconnect)
    }
  })

  return state
}

const portAt = (state: IFakeChrome, index: number): IFakePort => {
  const port = state.ports[index]
  assert.ok(port !== undefined, `The worker opened no port ${index + 1}`)

  return port
}

const typesOf = (port: IFakePort): unknown[] =>
  port.posted.map((frame) => (typeof frame === 'object' && frame !== null && 'type' in frame ? frame.type : frame))

// Holds the answer of tabs.query, and so the status snapshot: queried resolves once the snapshot waits on it, and
// release lets it go on.
const holdSnapshot = (state: IFakeChrome): { readonly queried: Promise<void>; readonly release: () => void } => {
  const held = Promise.withResolvers<unknown[]>()
  const queried = Promise.withResolvers<undefined>()

  state.tabsAnswer = () => {
    queried.resolve(undefined)

    return held.promise
  }

  return {
    queried: queried.promise,
    release: () => {
      held.resolve([])
    },
  }
}

describe('[service-worker] Native link - listener races', () => {
  it('should send no status or event on a link that turns incompatible while its snapshot is taken, and keep the event', async (context) => {
    // Arrange - a ready link whose listener waits for its status snapshot
    const state = await startWorker(context)
    const first = portAt(state, 0)
    emit(first.onMessage, HOST_HELLO)
    const snapshot = holdSnapshot(state)
    emit(first.onMessage, { type: 'listener' })
    await snapshot.queried

    // Act - the host says hello again, then the snapshot comes
    emit(first.onMessage, HOST_HELLO)
    snapshot.release()
    await settled()
    await settled()

    // Assert - only the handshake frames went out; a fresh compatible link gets the status and the stored event
    assert.deepEqual(first.posted[0], EXTENSION_HELLO)
    assert.deepEqual(typesOf(first), ['hello', 'bridge-incompatible'])

    emit(first.onDisconnect)
    emit(state.onAlarm)
    const second = portAt(state, 1)
    emit(second.onMessage, HOST_HELLO)
    emit(second.onMessage, { type: 'listener' })
    await untilPosted(second, 3)

    assertListenedOn(second)
  })

  it('should send nothing on a new link before its hello when the old link went while its snapshot was taken', async (context) => {
    // Arrange - a ready link whose listener waits for its status snapshot
    const state = await startWorker(context)
    const first = portAt(state, 0)
    emit(first.onMessage, HOST_HELLO)
    const snapshot = holdSnapshot(state)
    emit(first.onMessage, { type: 'listener' })
    await snapshot.queried

    // Act - the port drops, the alarm opens a new one, then the snapshot comes before the new host's hello
    emit(first.onDisconnect)
    emit(state.onAlarm)
    const second = portAt(state, 1)
    snapshot.release()
    await settled()
    await settled()
    const beforeHello = typesOf(second)
    emit(second.onMessage, HOST_HELLO)
    await settled()
    const afterHello = typesOf(second)
    emit(second.onMessage, { type: 'listener' })
    await untilPosted(second, 3)

    // Assert - nothing went out on the old link after its listener, and the new one forwards only once it listens
    assert.deepEqual(typesOf(first), ['hello'])
    assert.deepEqual([beforeHello, afterHello], [['hello'], ['hello']])
    assertListenedOn(second)
  })
})
