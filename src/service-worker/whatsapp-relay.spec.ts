import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it, type TestContext } from 'node:test'
import { OBSERVER_PORT_EVENT, RELAY_READY_EVENT } from './capture-handshake.js'

// A WhatsApp page's observer and relay (extension/whatsapp-observer.ts, whatsapp-relay.ts): the build's bundles run
// against a fake page, whose document, window and ports the test drives, and a fake chrome.runtime for the relay. Each
// bundle is imported under a query of its own, so every page and every relay is a fresh copy. The spec lives here,
// beside the modules the tests load, since the build replaces the compiled extension folder with its bundles.

// A test that fails while waiting for a message fails at this timeout, and the test's cleanup still closes every port,
// so an open port never keeps the run from ending.
const TEST_OPTIONS = { timeout: 5_000 }

// The messages the service worker sends a relay, and the relay's mark (config.ts, which the build leaves out of the
// compiled extension).
const WHATSAPP_STATE_REQUEST = 'misha-whatsapp-state-request'
const WHATSAPP_REPORT_REQUEST = 'misha-whatsapp-report-request'
const RELAY_RUNNING_KEY = 'mishaRelayRunning'

const WHATSAPP_ORIGIN = 'https://web.whatsapp.com'
const OBSERVER_BUNDLE = new URL('../extension/whatsapp-observer.js', import.meta.url)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const TOKEN = '5b0d7e3a-9c41-4f2e-8a6b-1d2c3e4f5a6b'
const COMMAND_ID = '0f6d2c1a-3b4e-4d5f-8a9b-0c1d2e3f4a5b'
const LEO_NOVAK = { wid: '100000000000001@lid' }
const EMMA_LEE = '100000000000002@lid'

const READY = { state: 'ready', account: LEO_NOVAK, isConnected: true, hasSynced: true }
const DISCONNECTED = { ...READY, isConnected: false }
const GREETING = { kind: 'greeting', token: TOKEN, capture: READY }
const OBSERVED = { state: 'observed', token: TOKEN, capture: READY }
const NOT_SHOWN = { state: 'not-shown' }
const REPORT = { kind: 'whatsapp-report' }
const UNREADABLE_MESSAGE = 'The observer sent a message that does not read'

const MESSAGE = {
  chat: EMMA_LEE,
  id: '3EB0A1B2C3D4E5F60718',
  timestamp: 1_700_000_000,
  fromMe: false,
  type: 'chat',
  text: 'Lunch at noon?',
}

const OBSERVED_MESSAGE = { kind: 'message', account: LEO_NOVAK, message: MESSAGE, seq: 0 }
const FORWARDED_MESSAGE = { kind: 'whatsapp-message', account: LEO_NOVAK, message: MESSAGE }

const CONTACT_COMMAND = {
  kind: 'whatsapp-command',
  id: COMMAND_ID,
  deadline: 1_800_000_000_000,
  command: { method: 'whatsappContact', params: { account: LEO_NOVAK, wid: EMMA_LEE } },
}

// What a relay's listener did with a message from the service worker: whether it held the answer, and the answer, which
// stays pending when the relay answers nothing.
interface IRelayAsked {
  readonly isHeld: boolean
  readonly answer: Promise<unknown>
  // Every answer the relay gave through the listener's response callback, in order.
  readonly responses: unknown[]
}

interface IRelay {
  // What the relay sent the service worker, in order.
  readonly sent: unknown[]
  readonly untilSent: (count: number) => Promise<void>
  // Answers the service worker's side of the message sent at index, as the worker does once it took it.
  readonly settle: (index: number) => void
  readonly ask: (message: unknown) => IRelayAsked
}

// Messages arriving on a port the test holds, in order, and posts on it.
interface IPortRecord {
  readonly messages: unknown[]
  readonly received: (count: number) => Promise<unknown[]>
  readonly post: (message: unknown) => void
}

interface IPageOptions {
  readonly origin?: string
  readonly isTopFrame?: boolean
  readonly readyState?: DocumentReadyState
  // window.require and requireLazy; both absent when not given.
  readonly moduleSystem?: { readonly require: unknown; readonly requireLazy: unknown }
}

interface IFakePage {
  readonly document: EventTarget & { prerendering: boolean }
  readonly window: EventTarget
  // The listeners each relay added for the service worker; the test checks it to see whether a relay started.
  readonly relayListeners: unknown[]
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
    post: (message) => {
      port.postMessage(message)
    },
  }
}

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

const pageTransition = (type: 'pagehide' | 'pageshow', persisted: boolean): Event =>
  Object.assign(new Event(type), { persisted })

// A WhatsApp page with no observer yet: its document, window and address, and ports the test closes after it. One page
// per test: once the test ends, its ports close and every global it replaced is put back, last first.
const openPage = (context: TestContext, options: IPageOptions = {}): IFakePage => {
  const document = Object.assign(new EventTarget(), {
    prerendering: false,
    readyState: options.readyState ?? 'loading',
  })
  const restores: (() => void)[] = []
  const ports: MessagePort[] = []
  const relayListeners: unknown[] = []

  class TrackedMessageChannel extends MessageChannel {
    constructor() {
      super()
      ports.push(this.port1, this.port2)
    }
  }

  const window: EventTarget & { top?: unknown } = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    ...options.moduleSystem,
  })

  window.top = options.isTopFrame === false ? {} : window

  context.after(() => {
    for (const port of ports) {
      port.close()
    }

    for (const restore of restores.toReversed()) {
      restore()
    }

    Reflect.deleteProperty(globalThis, RELAY_RUNNING_KEY)
  })

  for (const [name, value] of Object.entries({
    document,
    window,
    location: { origin: options.origin ?? WHATSAPP_ORIGIN },
    MessageChannel: TrackedMessageChannel,
  })) {
    replaceGlobal(restores, name, value)
  }

  return {
    document,
    window,
    relayListeners,
    loadObserver: async () => {
      loads += 1
      await import(`../extension/whatsapp-observer.js?load=${loads}`)
    },
    // A relay of a new load of the extension: a new isolated world, without the mark of the relay it replaces.
    loadRelay: async () => {
      const sent: unknown[] = []
      const settles: (() => void)[] = []
      const listeners: ((message: unknown, sender: object, respond: (answer: unknown) => void) => unknown)[] = []
      const { wake, until } = waiter()
      Reflect.deleteProperty(globalThis, RELAY_RUNNING_KEY)

      replaceGlobal(restores, 'chrome', {
        runtime: {
          id: 'made-up-extension-id',
          sendMessage: (message: unknown) => {
            const { promise, resolve } = Promise.withResolvers<undefined>()
            sent.push(message)

            settles.push(() => {
              resolve(undefined)
            })

            wake()

            return promise
          },
          onMessage: {
            addListener: (listener: (typeof listeners)[number]) => {
              listeners.push(listener)
              relayListeners.push(listener)
            },
          },
        },
      })

      loads += 1
      await import(`../extension/whatsapp-relay.js?load=${loads}`)

      return {
        sent,
        untilSent: (count) => until(() => sent.length >= count),
        settle: (index) => settles[index]?.(),
        ask: (message) => {
          const { promise, resolve } = Promise.withResolvers<unknown>()
          const responses: unknown[] = []
          const [listener] = listeners
          assert.ok(listener !== undefined, 'the relay listens for the service worker')

          const respond = (answer: unknown): void => {
            responses.push(answer)
            resolve(answer)
          }

          return { isHeld: listener(message, {}, respond) === true, answer: promise, responses }
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

// What the relay answers a state request asked now.
const stateNow = (relay: IRelay): Promise<unknown> => relay.ask(WHATSAPP_STATE_REQUEST).answer

describe('[extension] WhatsApp relay - state', () => {
  it(
    'should answer the state request with detached at once when no observer offered a channel, and report once',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)

      // Act
      const relay = await page.loadRelay()
      const asked = relay.ask(WHATSAPP_STATE_REQUEST)

      // Assert
      assert.equal(asked.isHeld, false)
      assert.deepEqual(await asked.answer, { state: 'detached' })
      assert.deepEqual(relay.sent, [REPORT])
    }
  )

  it(
    "should hold the state request until the observer's greeting is read, then answer the observed state with its token",
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      page.answerAsObserver([GREETING])

      // Act
      const relay = await page.loadRelay()
      const asked = relay.ask(WHATSAPP_STATE_REQUEST)

      // Assert
      assert.equal(asked.isHeld, true)
      assert.deepEqual(await asked.answer, OBSERVED)
      assert.deepEqual(relay.sent, [REPORT])
    }
  )

  it(
    'should report on the greeting and on every capture change, and answer each state request with the latest state',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      const observer = page.answerAsObserver([GREETING])
      const relay = await page.loadRelay()
      await relay.untilSent(1)
      const first = await stateNow(relay)

      // Act
      observer.post({ kind: 'capture', capture: DISCONNECTED })
      await relay.untilSent(2)

      // Assert
      assert.deepEqual(first, OBSERVED)
      assert.deepEqual(await stateNow(relay), { ...OBSERVED, capture: DISCONNECTED })
      assert.deepEqual(relay.sent, [REPORT, REPORT])
    }
  )

  it(
    'should post a report when the service worker asks for one, and answer that request nothing',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      page.answerAsObserver([GREETING])
      const relay = await page.loadRelay()
      await relay.untilSent(1)

      // Act
      const asked = relay.ask(WHATSAPP_REPORT_REQUEST)
      await relay.untilSent(2)

      // Assert
      assert.deepEqual([asked.isHeld, asked.responses], [false, []])
      assert.deepEqual(relay.sent, [REPORT, REPORT])
    }
  )

  it(
    'should answer not-shown and post no report while its document is prerendering, and report once at prerenderingchange',
    TEST_OPTIONS,
    async (context) => {
      // Arrange - the forwarded message tells the test that the relay read the greeting before it
      const page = openPage(context)
      page.document.prerendering = true
      page.answerAsObserver([GREETING, OBSERVED_MESSAGE])
      const relay = await page.loadRelay()
      await relay.untilSent(1)
      const whilePrerendering = await stateNow(relay)
      relay.ask(WHATSAPP_REPORT_REQUEST)

      // Act
      page.document.prerendering = false
      page.document.dispatchEvent(new Event('prerenderingchange'))

      // Assert
      assert.deepEqual(whilePrerendering, NOT_SHOWN)
      assert.deepEqual(relay.sent, [FORWARDED_MESSAGE, REPORT])
      assert.deepEqual(await stateNow(relay), OBSERVED)
    }
  )

  it(
    'should answer not-shown from pagehide on, persisted or not, and report again at a pageshow that is persisted',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      page.answerAsObserver([GREETING])
      const relay = await page.loadRelay()
      await relay.untilSent(1)

      // Act
      page.window.dispatchEvent(pageTransition('pagehide', false))
      const unloading = await stateNow(relay)
      page.window.dispatchEvent(pageTransition('pageshow', false))
      page.window.dispatchEvent(pageTransition('pagehide', true))
      const cached = await stateNow(relay)
      const sentWhileCached = [...relay.sent]
      page.window.dispatchEvent(pageTransition('pageshow', true))

      // Assert
      assert.deepEqual([unloading, cached], [NOT_SHOWN, NOT_SHOWN])
      assert.deepEqual(sentWhileCached, [REPORT])
      assert.deepEqual(relay.sent, [REPORT, REPORT])
      assert.deepEqual(await stateNow(relay), OBSERVED)
    }
  )

  it('should report failed, and keep it, when an observer message does not read', TEST_OPTIONS, async (context) => {
    // Arrange - the forwarded message tells the test that the relay read the capture change before it
    const page = openPage(context)

    page.answerAsObserver([
      GREETING,
      { kind: 'capture', capture: { state: 'unheard-of' } },
      { kind: 'capture', capture: READY },
      OBSERVED_MESSAGE,
    ])

    // Act
    const relay = await page.loadRelay()
    await relay.untilSent(3)

    // Assert
    assert.deepEqual(relay.sent, [REPORT, REPORT, FORWARDED_MESSAGE])
    assert.deepEqual(await stateNow(relay), { state: 'failed', error: UNREADABLE_MESSAGE })
  })
})

describe('[extension] WhatsApp relay - messages and commands', () => {
  it(
    'should forward a new direct message to the service worker and report it taken only after the answer',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      const observer = page.answerAsObserver([GREETING, OBSERVED_MESSAGE])
      const relay = await page.loadRelay()
      await relay.untilSent(2)
      const reportsBeforeAnswer = [...observer.messages]

      // Act
      relay.settle(1)

      // Assert
      assert.deepEqual(relay.sent, [REPORT, FORWARDED_MESSAGE])
      assert.deepEqual(reportsBeforeAnswer, [])
      assert.deepEqual(await observer.received(1), [{ kind: 'taken', seq: 0 }])
    }
  )

  it(
    "should run a command and answer with the observer's answer, read by the method's result schema",
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      const observer = page.answerAsObserver([GREETING])
      const relay = await page.loadRelay()
      await relay.untilSent(1)

      // Act
      const asked = relay.ask(CONTACT_COMMAND)
      const [posted] = await observer.received(1)
      observer.post({ kind: 'answer', id: COMMAND_ID, answer: { outcome: 'read', name: 'Emma Lee', isMe: false } })

      // Assert
      const { kind, ...command } = CONTACT_COMMAND
      assert.equal(kind, 'whatsapp-command')
      assert.deepEqual(posted, { kind: 'command', ...command })
      assert.equal(asked.isHeld, true)
      assert.deepEqual(await asked.answer, {
        kind: 'answer',
        answer: { outcome: 'read', name: 'Emma Lee', isMe: false },
      })
    }
  )

  it(
    'should answer unreadable to an answer that does not read, and fail the capture on a message that does not read',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      const observer = page.answerAsObserver([GREETING])
      const relay = await page.loadRelay()
      await relay.untilSent(1)
      const asked = relay.ask(CONTACT_COMMAND)
      await observer.received(1)

      // Act
      observer.post({ kind: 'answer', id: COMMAND_ID, answer: { outcome: 'read', name: 42, isMe: false } })
      const answer = await asked.answer
      observer.post({ kind: 'answer', id: 'not-a-command-id' })
      await relay.untilSent(2)

      // Assert
      assert.deepEqual(answer, { kind: 'unreadable' })
      assert.deepEqual(await stateNow(relay), { state: 'failed', error: UNREADABLE_MESSAGE })
      assert.deepEqual(await relay.ask(CONTACT_COMMAND).answer, { kind: 'no-observer' })
    }
  )

  it(
    'should answer a command no-observer at once when no observer offered a channel',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      const relay = await page.loadRelay()

      // Act
      const asked = relay.ask(CONTACT_COMMAND)

      // Assert
      assert.equal(asked.isHeld, false)
      assert.deepEqual(await asked.answer, { kind: 'no-observer' })
    }
  )
})

describe('[extension] WhatsApp relay - where it runs', () => {
  it('should take no channel off https://web.whatsapp.com', TEST_OPTIONS, async (context) => {
    // Arrange
    const page = openPage(context, { origin: 'https://example.com' })
    let readyEvents = 0

    page.document.addEventListener(RELAY_READY_EVENT, () => {
      readyEvents += 1
    })

    // Act + Assert
    await assert.rejects(page.loadRelay(), {
      message:
        'A relay takes a channel only in the top frame of https://web.whatsapp.com, not in a top frame of https://example.com',
    })

    assert.deepEqual(
      [readyEvents, page.relayListeners.length, Reflect.has(globalThis, RELAY_RUNNING_KEY)],
      [0, 0, false]
    )
  })

  it("should not start in a frame that is not its tab's top frame", TEST_OPTIONS, async (context) => {
    // Arrange
    const page = openPage(context, { isTopFrame: false })
    let readyEvents = 0

    page.document.addEventListener(RELAY_READY_EVENT, () => {
      readyEvents += 1
    })

    // Act + Assert
    await assert.rejects(page.loadRelay(), {
      message:
        'A relay takes a channel only in the top frame of https://web.whatsapp.com, not in a subframe of https://web.whatsapp.com',
    })

    assert.deepEqual(
      [readyEvents, page.relayListeners.length, Reflect.has(globalThis, RELAY_RUNNING_KEY)],
      [0, 0, false]
    )
  })
})

describe('[extension] WhatsApp observer', () => {
  it(
    'should greet a relay with its token and loading, and report broken with no-module-system once the page loaded without one',
    TEST_OPTIONS,
    async (context) => {
      // Arrange
      const page = openPage(context)
      await page.loadObserver()
      const relay = page.joinAsRelay()
      const [greeting] = await relay.received(1)

      // Act
      page.window.dispatchEvent(new Event('load'))

      // Assert
      const token: unknown = Reflect.get(greeting as object, 'token')
      assert.ok(typeof token === 'string' && UUID_PATTERN.test(token))

      assert.deepEqual(await relay.received(2), [
        { kind: 'greeting', token, capture: { state: 'loading' } },
        { kind: 'capture', capture: { state: 'broken', drift: 'no-module-system' } },
      ])
    }
  )

  it(
    "should start the capture on the page's module system once requireLazy defined the core modules",
    TEST_OPTIONS,
    async (context) => {
      // Arrange - a module system that holds no module, so the capture's first check fails
      const waited: unknown[] = []
      let defineCoreModules = (): void => undefined

      const page = openPage(context, {
        readyState: 'complete',
        moduleSystem: {
          require: (name: string) => {
            throw new Error(`No module ${name}`)
          },
          requireLazy: (names: unknown, callback: () => void) => {
            waited.push(names)
            defineCoreModules = callback
          },
        },
      })

      await page.loadObserver()
      const relay = page.joinAsRelay()
      await relay.received(1)

      // Act
      defineCoreModules()

      // Assert
      assert.deepEqual(waited, [['WAWebCollections', 'WAWebUserPrefsMeUser', 'WAWebSocketModel']])

      assert.deepEqual((await relay.received(2))[1], {
        kind: 'capture',
        capture: { state: 'broken', drift: 'collections' },
      })
    }
  )

  it("should add no property to the page's window and no attribute to its document", TEST_OPTIONS, async (context) => {
    // Arrange
    const page = openPage(context, { readyState: 'complete' })
    const before = [
      Object.getOwnPropertyNames(globalThis),
      Object.getOwnPropertyNames(page.window),
      Object.getOwnPropertyNames(page.document),
    ]

    // Act
    await page.loadObserver()
    page.joinAsRelay()

    // Assert
    const after = [
      Object.getOwnPropertyNames(globalThis),
      Object.getOwnPropertyNames(page.window),
      Object.getOwnPropertyNames(page.document),
    ]
    assert.deepEqual(after, before)
  })

  it('should bundle no schema library into the observer', () => {
    // Act
    const bundle = readFileSync(OBSERVER_BUNDLE, 'utf8')

    // Assert
    assert.deepEqual([bundle.includes('ZodError'), bundle.includes('ZodType')], [false, false])
  })
})
