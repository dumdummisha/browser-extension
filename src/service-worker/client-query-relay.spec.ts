import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { OBSERVER_PORT_EVENT, RELAY_READY_EVENT } from './capture-handshake.js'

// A Slack page's observer and relay together (extension/observer.ts, relay.ts): the build's bundles of both run against
// a fake page, whose document, ports and resource timing the test drives, and a fake chrome.runtime for the relay. Each
// bundle is imported under a query of its own, so every page and every relay is a fresh copy. The spec lives here,
// beside the modules the tests load, since the build replaces the compiled extension folder with its bundles.

// A test that fails while waiting for a message fails at this timeout, and the test's cleanup still closes every port,
// so an open port never keeps the run from ending.
const TEST_OPTIONS = { timeout: 5_000 }

// The messages the service worker sends a relay (config.ts, which the build leaves out of the compiled extension).
const CAPTURE_QUERY = 'misha-capture-query'
const CLIENT_QUERY = 'misha-client-query'
const RELAY_RUNNING_KEY = 'mishaRelayRunning'

const SLACK_ORIGIN = 'https://app.slack.com'
const API_ORIGIN = 'https://example.slack.com'
const CLIENT_CALL = `${API_ORIGIN}/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_num_retries=0`
const NEWER_CLIENT_CALL = `${API_ORIGIN}/api/conversations.history?_x_id=1a2b3c4d-1794900002.000&slack_route=T0EXAMPLE1&_x_foreground=true`

const QUERY = [
  ['_x_id', null],
  ['_x_csid', 'example-csid'],
  ['slack_route', 'T0EXAMPLE1'],
  ['_x_num_retries', null],
]

const NEWER_QUERY = [
  ['_x_id', null],
  ['slack_route', 'T0EXAMPLE1'],
  ['_x_foreground', 'true'],
]

const FRAME_MESSAGE = {
  kind: 'frame',
  account: { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' },
  frame: { type: 'message', channel: 'C0EXAMPLE1', ts: '1794900000.000100', text: 'a made-up message' },
}

const CLIENT_QUERY_UNREADABLE = 'The observer sent a client query that does not read'

// A resource timing entry the fake page reports: the address, the initiator type and when it started.
interface IReportedEntry {
  readonly name: string
  readonly initiatorType: string
  readonly startTime: number
}

// What a relay's listener did with a message from the service worker: whether it held the answer, and the answer.
interface IRelayAsked {
  readonly isHeld: boolean
  readonly answer: Promise<unknown>
}

interface IRelay {
  // What the relay sent the service worker, in order.
  readonly sent: unknown[]
  readonly untilSent: (count: number) => Promise<void>
  readonly ask: (message: string) => IRelayAsked
}

// Messages arriving on a port the test holds, in order.
interface IPortRecord {
  readonly messages: unknown[]
  readonly received: (count: number) => Promise<unknown[]>
}

interface IFakePage {
  readonly document: EventTarget
  // The options each registered PerformanceObserver observes with.
  readonly observed: unknown[]
  readonly report: (entries: readonly IReportedEntry[]) => void
  readonly loadObserver: () => Promise<void>
  readonly loadRelay: () => Promise<IRelay>
  // Joins as a relay would, on the document, and records what the one port it is handed brings.
  readonly joinAsRelay: () => IPortRecord
  // Answers each relay's ready event as an observer would, with a port that brings messages, in order.
  readonly answerAsObserver: (messages: readonly unknown[]) => IPortRecord
}

let loads = 0

// Resolves once condition holds, woken by wake; the test's timeout ends a wait that never gets there.
const waiter = (): { readonly wake: () => void; readonly until: (condition: () => boolean) => Promise<void> } => {
  let wakeUp = (): void => undefined

  return {
    wake: () => wakeUp(),
    until: async (condition) => {
      while (!condition()) {
        await new Promise<void>((resolve) => {
          wakeUp = resolve
        })
      }
    },
  }
}

const recordPort = (port: MessagePort): IPortRecord => {
  const messages: unknown[] = []
  const { wake, until } = waiter()

  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    messages.push(data)
    wake()
  }

  return {
    messages,
    received: async (count) => {
      await until(() => messages.length >= count)

      return messages
    },
  }
}

const xhr = (name: string, startTime: number): IReportedEntry => ({ name, initiatorType: 'xmlhttprequest', startTime })

// Sets globalThis[name] to value, and adds to restores what puts the global back.
const replaceGlobal = (restores: (() => void)[], name: string, value: unknown): void => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })

  restores.push(() => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, name)
    } else {
      Object.defineProperty(globalThis, name, descriptor)
    }
  })
}

// A Slack page with no observer yet: its document, window, address and storage, ports the test closes after it, and a
// resource timing whose observers get each entry the test reports, read through prototype getters as the browser's.
// One page per test: once the test ends, its ports close and every global it replaced is put back, last first.
const openPage = (context: TestContext): IFakePage => {
  const document = new EventTarget()
  const restores: (() => void)[] = []
  const ports: MessagePort[] = []
  const observers: ((list: object) => void)[] = []
  const observed: unknown[] = []

  class TrackedMessageChannel extends MessageChannel {
    constructor() {
      super()
      ports.push(this.port1, this.port2)
    }
  }

  class FakeStorage {
    public getItem(): string | null {
      return null
    }
  }

  class FakePerformanceEntry {
    constructor(protected readonly entry: IReportedEntry) {}

    public get name(): string {
      return this.entry.name
    }

    public get startTime(): number {
      return this.entry.startTime
    }
  }

  class FakeResourceTiming extends FakePerformanceEntry {
    public get initiatorType(): string {
      return this.entry.initiatorType
    }
  }

  class FakeEntryList {
    constructor(private readonly entries: readonly FakeResourceTiming[]) {}

    public getEntries(): readonly FakeResourceTiming[] {
      return this.entries
    }
  }

  class FakePerformanceObserver {
    constructor(private readonly callback: (list: object) => void) {}

    public observe(options: unknown): void {
      observed.push(options)
      observers.push(this.callback)
    }
  }

  context.after(() => {
    for (const port of ports) {
      port.close()
    }

    for (const restore of restores.toReversed()) {
      restore()
    }

    Reflect.deleteProperty(globalThis, RELAY_RUNNING_KEY)
  })

  const window = { WebSocket: class extends EventTarget {}, top: null as unknown }
  window.top = window

  for (const [name, value] of Object.entries({
    document,
    window,
    location: { origin: SLACK_ORIGIN, pathname: '/client/T0EXAMPLE1', href: `${SLACK_ORIGIN}/client/T0EXAMPLE1` },
    Storage: FakeStorage,
    localStorage: new FakeStorage(),
    MessageChannel: TrackedMessageChannel,
    PerformanceObserver: FakePerformanceObserver,
    PerformanceObserverEntryList: FakeEntryList,
    PerformanceEntry: FakePerformanceEntry,
    PerformanceResourceTiming: FakeResourceTiming,
  })) {
    replaceGlobal(restores, name, value)
  }

  return {
    document,
    observed,
    report: (entries) => {
      const list = new FakeEntryList(entries.map((entry) => new FakeResourceTiming(entry)))
      for (const callback of observers) {
        callback(list)
      }
    },
    loadObserver: async () => {
      loads += 1
      await import(`../extension/observer.js?load=${loads}`)
    },
    // A relay of a new load of the extension: a new isolated world, without the mark of the relay it replaces.
    loadRelay: async () => {
      const sent: unknown[] = []
      const listeners: ((message: unknown, sender: object, respond: (answer: unknown) => void) => unknown)[] = []
      const { wake, until } = waiter()
      Reflect.deleteProperty(globalThis, RELAY_RUNNING_KEY)

      replaceGlobal(restores, 'chrome', {
        runtime: {
          id: 'made-up-extension-id',
          sendMessage: (message: unknown) => {
            sent.push(message)
            wake()

            return Promise.resolve()
          },
          onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) },
        },
      })

      loads += 1
      await import(`../extension/relay.js?load=${loads}`)

      return {
        sent,
        untilSent: (count) => until(() => sent.length >= count),
        ask: (message) => {
          const { promise, resolve } = Promise.withResolvers<unknown>()
          const [listener] = listeners
          assert.ok(listener !== undefined, 'the relay listens for the service worker')

          return { isHeld: listener(message, {}, resolve) === true, answer: promise }
        },
      }
    },
    joinAsRelay: () => {
      const offered: MessagePort[] = []

      const take = (event: Event): void => {
        if (event instanceof MessageEvent && event.ports[0] !== undefined) {
          offered.push(event.ports[0])
        }
      }

      document.addEventListener(OBSERVER_PORT_EVENT, take)
      document.dispatchEvent(new CustomEvent(RELAY_READY_EVENT))
      document.removeEventListener(OBSERVER_PORT_EVENT, take)
      const [port] = offered
      assert.ok(port !== undefined && offered.length === 1, 'the observer answers a ready event with exactly one port')

      return recordPort(port)
    },
    answerAsObserver: (messages) => {
      const channel = new TrackedMessageChannel()

      document.addEventListener(RELAY_READY_EVENT, () => {
        document.dispatchEvent(new MessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] }))

        for (const message of messages) {
          channel.port1.postMessage(message)
        }
      })

      return recordPort(channel.port1)
    },
  }
}

describe('[extension] Client query - the observer', () => {
  it("should observe the page's resource timing, buffered entries included", TEST_OPTIONS, async (context) => {
    // Arrange
    const page = openPage(context)

    // Act
    await page.loadObserver()

    // Assert
    assert.deepEqual(page.observed, [{ type: 'resource', buffered: true }])
  })

  it(
    'should greet a relay with the query of client calls that came before it joined',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      await page.loadObserver()

      page.report([
        xhr(CLIENT_CALL, 10),
        { name: `${API_ORIGIN}/api/chat.postMessage?_x_id=1`, initiatorType: 'fetch', startTime: 11 },
      ])

      // Act
      const relay = page.joinAsRelay()

      // Assert
      assert.deepEqual(await relay.received(1), [
        { kind: 'greeting', isSocketOpen: false, queries: { [API_ORIGIN]: QUERY } },
      ])
    }
  )

  it(
    'should post a changed query to every relay as it stands, never as a frame, and greet a later relay with it',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      await page.loadObserver()
      const first = page.joinAsRelay()

      // Act
      page.report([xhr(CLIENT_CALL, 10)])
      const later = page.joinAsRelay()
      page.report([xhr(NEWER_CLIENT_CALL, 20)])

      // Assert - the later relay gets no copy of the first change after its greeting
      assert.deepEqual(await first.received(3), [
        { kind: 'greeting', isSocketOpen: false, queries: {} },
        { kind: 'client-query', origin: API_ORIGIN, query: QUERY },
        { kind: 'client-query', origin: API_ORIGIN, query: NEWER_QUERY },
      ])

      assert.deepEqual(await later.received(2), [
        { kind: 'greeting', isSocketOpen: false, queries: { [API_ORIGIN]: QUERY } },
        { kind: 'client-query', origin: API_ORIGIN, query: NEWER_QUERY },
      ])
    }
  )
})

describe('[extension] Client query - the relay', () => {
  it(
    "should hold an answer asked for while the observer's greeting is not read yet, and give the queries once it is",
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      await page.loadObserver()
      page.report([xhr(CLIENT_CALL, 10)])

      // Act
      const relay = await page.loadRelay()
      const asked = relay.ask(CLIENT_QUERY)

      // Assert
      assert.equal(asked.isHeld, true)
      assert.deepEqual(await asked.answer, { queries: { [API_ORIGIN]: QUERY } })
      assert.deepEqual(relay.sent, [{ kind: 'capture' }])
    }
  )

  it('should answer at once once the greeting was read', TEST_OPTIONS, async (context) => {
    // Arrange
    const page = openPage(context)
    await page.loadObserver()
    page.report([xhr(CLIENT_CALL, 10)])
    const relay = await page.loadRelay()
    await relay.untilSent(1)

    // Act
    const asked = relay.ask(CLIENT_QUERY)

    // Assert
    assert.equal(asked.isHeld, false)
    assert.deepEqual(await asked.answer, { queries: { [API_ORIGIN]: QUERY } })
  })

  it('should answer null at once in a page no observer offered a channel in', TEST_OPTIONS, async (context) => {
    // Arrange
    const page = openPage(context)
    const relay = await page.loadRelay()

    // Act
    const queries = relay.ask(CLIENT_QUERY)
    const capture = relay.ask(CAPTURE_QUERY)

    // Assert
    assert.equal(queries.isHeld, false)
    assert.deepEqual(await queries.answer, { queries: null })
    assert.deepEqual(await capture.answer, { isSocketOpen: null, error: null })
  })

  it(
    'should answer null to an observer from before client queries, whose first message is a socket state, and still capture',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      page.answerAsObserver([{ kind: 'socket', isSocketOpen: true }])
      const relay = await page.loadRelay()

      // Act
      const asked = relay.ask(CLIENT_QUERY)

      // Assert
      assert.equal(asked.isHeld, true)
      assert.deepEqual(await asked.answer, { queries: null })
      assert.deepEqual(await relay.ask(CAPTURE_QUERY).answer, { isSocketOpen: true, error: null })
    }
  )

  it(
    'should fail the capture with a fixed text, quoting nothing, when a greeting does not read',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const rejected = 'https://example.slack.com.attacker.example'
      const page = openPage(context)
      page.answerAsObserver([{ kind: 'greeting', isSocketOpen: true, queries: { [rejected]: QUERY } }])

      // Act
      const relay = await page.loadRelay()
      const asked = relay.ask(CLIENT_QUERY)

      // Assert
      assert.deepEqual([asked.isHeld, await asked.answer], [true, { queries: null }])
      assert.deepEqual(await relay.ask(CAPTURE_QUERY).answer, { isSocketOpen: null, error: CLIENT_QUERY_UNREADABLE })
    }
  )

  it(
    'should fail the capture with a fixed text, quoting nothing, when a changed query does not read',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)

      page.answerAsObserver([
        { kind: 'greeting', isSocketOpen: true, queries: { [API_ORIGIN]: QUERY } },
        { kind: 'client-query', origin: API_ORIGIN, query: [['token', 'xoxc-0000-made-up-token']] },
      ])

      // Act
      const relay = await page.loadRelay()
      await relay.untilSent(2)

      // Assert
      assert.deepEqual(await relay.ask(CLIENT_QUERY).answer, { queries: null })
      assert.deepEqual(await relay.ask(CAPTURE_QUERY).answer, { isSocketOpen: true, error: CLIENT_QUERY_UNREADABLE })
    }
  )

  it(
    'should never let a client query change the socket state, become a frame, take an ack or go on as an event',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)

      const observer = page.answerAsObserver([
        { kind: 'greeting', isSocketOpen: true, queries: {} },
        { kind: 'client-query', origin: API_ORIGIN, query: QUERY },
        { ...FRAME_MESSAGE, seq: 0 },
        { kind: 'client-query', origin: API_ORIGIN, query: NEWER_QUERY },
        { ...FRAME_MESSAGE, seq: 1 },
      ])

      // Act - the last frame tells the test that the relay read every message before it
      const relay = await page.loadRelay()
      await relay.untilSent(3)
      await observer.received(2)

      // Assert
      assert.deepEqual(relay.sent, [{ kind: 'capture' }, FRAME_MESSAGE, FRAME_MESSAGE])

      assert.deepEqual(observer.messages, [
        { kind: 'taken', seq: 0 },
        { kind: 'taken', seq: 1 },
      ])

      assert.deepEqual(await relay.ask(CAPTURE_QUERY).answer, { isSocketOpen: true, error: null })
      assert.deepEqual(await relay.ask(CLIENT_QUERY).answer, { queries: { [API_ORIGIN]: NEWER_QUERY } })
    }
  )

  it(
    "should give a relay injected after the extension reloaded the surviving observer's queries",
    TEST_OPTIONS,
    async (context) => {
      // Arrange - the relay that came with the page saw the client's call
      const page = openPage(context)
      await page.loadObserver()
      const original = await page.loadRelay()
      page.report([xhr(CLIENT_CALL, 10)])
      await original.untilSent(1)

      // Act
      const replacement = await page.loadRelay()

      // Assert
      assert.deepEqual(await replacement.ask(CLIENT_QUERY).answer, { queries: { [API_ORIGIN]: QUERY } })
    }
  )
})
