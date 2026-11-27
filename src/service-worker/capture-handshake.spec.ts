import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  answerRelays,
  HELD_FRAMES_MAX,
  holdFrames,
  type IFrameHold,
  type IRelayPage,
  OBSERVER_PORT_EVENT,
  RELAY_READY_EVENT,
  reportTaken,
  takeObserverPorts,
} from './capture-handshake.js'

// A test that fails while waiting for a message fails at this timeout, and afterEach still closes its ports, so an open
// port never keeps the run from ending.
const TEST_OPTIONS = { timeout: 5_000 }

const GREETING = { kind: 'socket', isSocketOpen: true }
const SLACK_ORIGIN = 'https://app.slack.com'

const slackPage = (document: EventTarget): IRelayPage => ({ document, origin: SLACK_ORIGIN, isTopFrame: true })

interface IMessageRecord {
  readonly onMessage: (data: unknown, port: MessagePort) => void
  // Resolves with every message so far once there are count of them. A port delivers in the order of posting.
  readonly received: (count: number) => Promise<unknown[]>
}

interface IJoinedRelay extends IMessageRecord {
  readonly port: MessagePort
}

// Ports a test opened, closed after it whatever its outcome. Closing either end of a channel closes both.
const openPorts: MessagePort[] = []

const recordMessages = (): IMessageRecord => {
  const messages: unknown[] = []
  let wake = (): void => undefined

  return {
    onMessage: (data, port) => {
      messages.push(data)
      if (!openPorts.includes(port)) {
        openPorts.push(port)
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
const joinAsRelay = (document: EventTarget): IJoinedRelay => {
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

  port.onmessage = ({ data }: MessageEvent<unknown>) => {
    record.onMessage(data, port)
  }

  return { ...record, port }
}

// Every frame the hold holds, oldest first.
const heldFrames = (hold: IFrameHold): object[] => {
  const frames: object[] = []
  hold.forEach((frame) => frames.push(frame))

  return frames
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
      const relays = answerRelays(document, () => ({ kind: 'socket', isSocketOpen }), holdFrames(HELD_FRAMES_MAX))
      const first = joinAsRelay(document)
      isSocketOpen = true
      relays.postState({ kind: 'socket', isSocketOpen })

      // Act
      const second = joinAsRelay(document)
      relays.postFrame({ kind: 'frame', text: 'message 1' })

      // Assert
      assert.deepEqual(await first.received(3), [
        { kind: 'socket', isSocketOpen: false },
        { kind: 'socket', isSocketOpen: true },
        { kind: 'frame', text: 'message 1', seq: 0 },
      ])

      assert.deepEqual(await second.received(2), [
        { kind: 'socket', isSocketOpen: true },
        { kind: 'frame', text: 'message 1', seq: 0 },
      ])
    }
  )

  it(
    'should hold a frame posted before any relay asked, and post it to the first relay after its greeting',
    TEST_OPTIONS,
    async () => {
      // Arrange - a state posted then reaches no one, and the greeting tells the relay the state as it stands
      const document = new EventTarget()
      const relays = answerRelays(document, () => GREETING, holdFrames(HELD_FRAMES_MAX))
      relays.postState({ kind: 'socket', isSocketOpen: false })
      relays.postFrame({ kind: 'frame', text: 'message 0' })

      // Act
      const relay = joinAsRelay(document)
      relays.postFrame({ kind: 'frame', text: 'message 1' })

      // Assert
      assert.deepEqual(await relay.received(3), [
        GREETING,
        { kind: 'frame', text: 'message 0', seq: 0 },
        { kind: 'frame', text: 'message 1', seq: 1 },
      ])
    }
  )

  it(
    'should post a frame no relay reported taken to the relay that replaces the one it went to',
    TEST_OPTIONS,
    async () => {
      // Arrange - the relay a reload cut off gets the frame and never reports it taken
      const document = new EventTarget()
      const relays = answerRelays(document, () => GREETING, holdFrames(HELD_FRAMES_MAX))
      const cutOff = joinAsRelay(document)
      relays.postFrame({ kind: 'frame', text: 'message 1' })
      await cutOff.received(2)

      // Act
      const replacement = joinAsRelay(document)

      // Assert
      assert.deepEqual(await replacement.received(2), [GREETING, { kind: 'frame', text: 'message 1', seq: 0 }])
    }
  )

  it('should stop holding a frame once a relay reports it taken', TEST_OPTIONS, async () => {
    // Arrange - the hold tells the test when the observer read the report
    const document = new EventTarget()
    const hold = holdFrames(HELD_FRAMES_MAX)
    const released = Promise.withResolvers<number>()

    const relays = answerRelays(document, () => GREETING, {
      ...hold,
      release: (seq) => {
        hold.release(seq)
        released.resolve(seq)
      },
    })

    const first = joinAsRelay(document)
    relays.postFrame({ kind: 'frame', text: 'message 1' })
    await first.received(2)

    // Act
    reportTaken(first.port, 0)
    const releasedSeq = await released.promise
    const later = joinAsRelay(document)
    relays.postFrame({ kind: 'frame', text: 'message 2' })

    // Assert
    assert.equal(releasedSeq, 0)
    assert.deepEqual(await later.received(2), [GREETING, { kind: 'frame', text: 'message 2', seq: 1 }])
  })
})

describe('[service-worker] Capture handshake - the frame hold', () => {
  it('should hold frames oldest first under increasing numbers, and drop the oldest once max are held', () => {
    // Arrange
    const hold = holdFrames(2)

    // Act
    const framed = ['message 0', 'message 1', 'message 2'].map((text) => hold.hold({ kind: 'frame', text }))

    // Assert
    assert.deepEqual(framed, [
      { kind: 'frame', text: 'message 0', seq: 0 },
      { kind: 'frame', text: 'message 1', seq: 1 },
      { kind: 'frame', text: 'message 2', seq: 2 },
    ])

    assert.deepEqual(heldFrames(hold), [
      { kind: 'frame', text: 'message 1', seq: 1 },
      { kind: 'frame', text: 'message 2', seq: 2 },
    ])
  })

  it('should stop holding a released frame, and change nothing for a number it holds no frame under', () => {
    // Arrange
    const hold = holdFrames(3)

    for (const text of ['message 0', 'message 1', 'message 2']) {
      hold.hold({ kind: 'frame', text })
    }

    // Act
    hold.release(1)
    hold.release(7)
    hold.release(0)
    hold.hold({ kind: 'frame', text: 'message 3' })

    // Assert
    assert.deepEqual(heldFrames(hold), [
      { kind: 'frame', text: 'message 2', seq: 2 },
      { kind: 'frame', text: 'message 3', seq: 3 },
    ])
  })
})

describe("[service-worker] Capture handshake - the relay's side", () => {
  it(
    'should take the port the observer offers during its ready event, answer that it was offered, and get what is posted on it',
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
      const isOffered = takeObserverPorts(slackPage(document), SLACK_ORIGIN, relay.onMessage)
      channel.port1.postMessage(GREETING)

      // Assert
      assert.equal(isOffered, true)
      assert.deepEqual(await relay.received(1), [GREETING])
    }
  )

  it('should take no channel, and dispatch nothing, outside the top frame of a Slack page', () => {
    // Arrange
    const document = new EventTarget()
    let readyEvents = 0

    document.addEventListener(RELAY_READY_EVENT, () => {
      readyEvents += 1
    })

    const offSlack = { document, origin: 'https://example.com', isTopFrame: true }
    const slackSubframe = { document, origin: SLACK_ORIGIN, isTopFrame: false }

    // Act + Assert
    assert.throws(() => takeObserverPorts(offSlack, SLACK_ORIGIN, () => undefined), {
      message:
        'A relay takes a channel only in the top frame of https://app.slack.com, not in a top frame of https://example.com',
    })

    assert.throws(() => takeObserverPorts(slackSubframe, SLACK_ORIGIN, () => undefined), {
      message:
        'A relay takes a channel only in the top frame of https://app.slack.com, not in a subframe of https://app.slack.com',
    })

    assert.equal(readyEvents, 0)
  })

  it('should answer that no port was offered, and leave a port offered after its ready event untaken', () => {
    // Arrange
    const document = new EventTarget()
    const channel = new MessageChannel()
    openPorts.push(channel.port1, channel.port2)
    const isOffered = takeObserverPorts(slackPage(document), SLACK_ORIGIN, () => undefined)

    // Act
    document.dispatchEvent(new MessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] }))

    // Assert
    assert.deepEqual([isOffered, channel.port2.onmessage], [false, null])
  })

  it('should get a channel of its own from an observer that answered a relay before', TEST_OPTIONS, async () => {
    // Arrange - the relay that came with the page holds the observer's first channel
    const document = new EventTarget()
    const relays = answerRelays(document, () => GREETING, holdFrames(HELD_FRAMES_MAX))
    const first = joinAsRelay(document)
    const later = recordMessages()

    // Act
    takeObserverPorts(slackPage(document), SLACK_ORIGIN, later.onMessage)
    relays.postState({ kind: 'socket', isSocketOpen: false })

    // Assert
    assert.deepEqual(await later.received(2), [GREETING, { kind: 'socket', isSocketOpen: false }])
    assert.deepEqual(await first.received(2), [GREETING, { kind: 'socket', isSocketOpen: false }])
  })
})
