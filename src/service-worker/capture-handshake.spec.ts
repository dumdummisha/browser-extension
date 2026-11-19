import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { answerRelays, OBSERVER_PORT_EVENT, RELAY_READY_EVENT, takeObserverPorts } from './capture-handshake.js'

// A test that fails while waiting for a message fails at this timeout, and afterEach still closes its ports, so an open
// port never keeps the run from ending.
const TEST_OPTIONS = { timeout: 5_000 }

interface IMessageRecord {
  readonly onMessage: (event: MessageEvent<unknown>) => void
  // Resolves with every message so far once there are count of them. A port delivers in the order of posting.
  readonly received: (count: number) => Promise<unknown[]>
}

// Ports a test opened, closed after it whatever its outcome. Closing either end of a channel closes both.
const openPorts: MessagePort[] = []

const recordMessages = (): IMessageRecord => {
  const messages: unknown[] = []
  let wake = (): void => undefined

  return {
    onMessage: (event) => {
      messages.push(event.data)
      if (event.currentTarget instanceof MessagePort && !openPorts.includes(event.currentTarget)) {
        openPorts.push(event.currentTarget)
      }

      wake()
    },
    received: async (count) => {
      while (messages.length < count) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }

      return messages
    },
  }
}

// A relay as the observer meets it: dispatches the ready event on the document, and records what the one port it is
// handed brings.
const joinAsRelay = (document: EventTarget): IMessageRecord => {
  const ports: MessagePort[] = []
  const take = (event: Event): void => {
    if (event instanceof MessageEvent && event.ports[0] !== undefined) {
      ports.push(event.ports[0])
    }
  }
  document.addEventListener(OBSERVER_PORT_EVENT, take)
  document.dispatchEvent(new CustomEvent(RELAY_READY_EVENT))
  document.removeEventListener(OBSERVER_PORT_EVENT, take)
  openPorts.push(...ports)

  const [port] = ports
  assert.ok(port !== undefined && ports.length === 1, 'the observer answers a ready event with exactly one port')
  const record = recordMessages()
  port.onmessage = record.onMessage

  return record
}

afterEach(() => {
  for (const port of openPorts.splice(0)) {
    port.close()
  }
})

describe("[service-worker] Capture handshake - the observer's side", () => {
  it(
    'should greet a relay that comes later with the state as it stands, and post on to every relay',
    TEST_OPTIONS,
    async () => {
      // Arrange
      const document = new EventTarget()
      let isSocketOpen = false
      const toRelays = answerRelays(document, () => ({ kind: 'socket', isSocketOpen }))
      const first = joinAsRelay(document)
      isSocketOpen = true
      toRelays({ kind: 'socket', isSocketOpen })

      // Act
      const second = joinAsRelay(document)
      toRelays({ kind: 'frame', text: 'message 1' })

      // Assert
      assert.deepEqual(await first.received(3), [
        { kind: 'socket', isSocketOpen: false },
        { kind: 'socket', isSocketOpen: true },
        { kind: 'frame', text: 'message 1' },
      ])
      assert.deepEqual(await second.received(2), [
        { kind: 'socket', isSocketOpen: true },
        { kind: 'frame', text: 'message 1' },
      ])
    }
  )

  it(
    'should post nothing before the first relay asked, so its greeting is the first message it gets',
    TEST_OPTIONS,
    async () => {
      // Arrange
      const document = new EventTarget()
      const toRelays = answerRelays(document, () => ({ kind: 'socket', isSocketOpen: true }))
      toRelays({ kind: 'frame', text: 'message 0' })

      // Act
      const relay = joinAsRelay(document)
      toRelays({ kind: 'frame', text: 'message 1' })

      // Assert
      assert.deepEqual(await relay.received(2), [
        { kind: 'socket', isSocketOpen: true },
        { kind: 'frame', text: 'message 1' },
      ])
    }
  )
})

describe("[service-worker] Capture handshake - the relay's side", () => {
  it(
    'should take the port the observer offers during its ready event, and get what is posted on it',
    TEST_OPTIONS,
    async () => {
      // Arrange
      const document = new EventTarget()
      const channel = new MessageChannel()
      openPorts.push(channel.port1, channel.port2)
      document.addEventListener(RELAY_READY_EVENT, () => {
        document.dispatchEvent(new MessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] }))
      })
      const relay = recordMessages()

      // Act
      takeObserverPorts(document, relay.onMessage)
      channel.port1.postMessage({ kind: 'socket', isSocketOpen: true })

      // Assert
      assert.deepEqual(await relay.received(1), [{ kind: 'socket', isSocketOpen: true }])
    }
  )

  it('should leave a port offered after its ready event untaken', () => {
    // Arrange
    const document = new EventTarget()
    const channel = new MessageChannel()
    openPorts.push(channel.port1, channel.port2)
    takeObserverPorts(document, () => undefined)

    // Act
    document.dispatchEvent(new MessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] }))

    // Assert
    assert.equal(channel.port2.onmessage, null)
  })

  it('should get a channel of its own from an observer that answered a relay before', TEST_OPTIONS, async () => {
    // Arrange - the relay that came with the page holds the observer's first channel
    const document = new EventTarget()
    const toRelays = answerRelays(document, () => ({ kind: 'socket', isSocketOpen: true }))
    const first = joinAsRelay(document)
    const later = recordMessages()

    // Act
    takeObserverPorts(document, later.onMessage)
    toRelays({ kind: 'frame', text: 'message 1' })

    // Assert
    assert.deepEqual(await later.received(2), [
      { kind: 'socket', isSocketOpen: true },
      { kind: 'frame', text: 'message 1' },
    ])
    assert.deepEqual(await first.received(2), [
      { kind: 'socket', isSocketOpen: true },
      { kind: 'frame', text: 'message 1' },
    ])
  })
})
