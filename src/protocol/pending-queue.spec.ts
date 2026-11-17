import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countedLoss,
  DROPPED_EVENTS_ID,
  droppedEventsOf,
  EVENT_REDELIVERY_DELAYS_MS,
  PendingQueueError,
  redeliveryDelayMs,
  restoredQueue,
} from './pending-queue.js'
import { type SlackEvent, slackEventKey } from './slack.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }

const eventAt = (channel: string, ts: string): SlackEvent => {
  const frame = { type: 'message', channel, ts } as const

  return { type: 'event', id: slackEventKey(ACCOUNT, frame), account: ACCOUNT, frame } as const
}

const recordOf = (event: SlackEvent): { key: string; value: SlackEvent } => ({ key: event.id, value: event })

describe('[protocol] Pending queue - restoring', () => {
  it('should restore stored events oldest message first, with the loss count', () => {
    // Arrange
    const later = eventAt('C0EXAMPLE1', '1700000001.000100')
    const earlier = eventAt('D0EXAMPLE1', '999999999.000900')
    const sameTs = eventAt('C0EXAMPLE2', '1700000001.000100')
    const records = [later, earlier, sameTs].map(recordOf)

    // Act
    const queue = restoredQueue(records, { id: DROPPED_EVENTS_ID, droppedEvents: 3 })

    // Assert
    assert.deepEqual(queue, { events: [earlier, later, sameTs], droppedEvents: 3, unreadableKeys: [] })
  })

  it('should start from no loss when nothing was ever lost', () => {
    // Act
    const queue = restoredQueue([], undefined)

    // Assert
    assert.deepEqual(queue, { events: [], droppedEvents: 0, unreadableKeys: [] })
  })

  it('should hand back the records it cannot deliver, so recovery deletes and counts them', () => {
    // Arrange
    const event = eventAt('C0EXAMPLE1', '1700000001.000100')
    const records = [
      { key: event.id, value: { ...event, frame: { ...event.frame, ts: 'not-a-ts' } } },
      { key: 'older-format', value: { id: 'older-format', text: 'hello' } },
    ]

    // Act
    const queue = restoredQueue(records, undefined)

    // Assert
    assert.deepEqual(queue, { events: [], droppedEvents: 0, unreadableKeys: [event.id, 'older-format'] })
  })
})

describe('[protocol] Pending queue - loss count', () => {
  it('should read zero only when there is no loss record', () => {
    // Act
    const counts = [droppedEventsOf(undefined), droppedEventsOf({ id: DROPPED_EVENTS_ID, droppedEvents: 7 })]

    // Assert
    assert.deepEqual(counts, [0, 7])
  })

  it('should refuse a loss record that is there but holds no count, null included, rather than guess one', () => {
    // Arrange
    const invalid = [
      null,
      3,
      { id: DROPPED_EVENTS_ID, droppedEvents: null },
      { id: DROPPED_EVENTS_ID, droppedEvents: -1 },
      { id: 'another-record', droppedEvents: 3 },
    ]

    // Act + Assert
    for (const record of invalid) {
      assert.throws(() => droppedEventsOf(record), PendingQueueError)
      assert.throws(() => countedLoss(record, 1), PendingQueueError)
    }
  })

  it('should count lost events on top of the stored count, starting from none', () => {
    // Act
    const first = countedLoss(undefined, 1)
    const recovered = countedLoss(first, 4)

    // Assert
    assert.deepEqual(
      [first, recovered],
      [
        { id: DROPPED_EVENTS_ID, droppedEvents: 1 },
        { id: DROPPED_EVENTS_ID, droppedEvents: 5 },
      ]
    )
  })

  it('should never count no loss or a negative one', () => {
    // Act + Assert
    assert.throws(() => countedLoss(undefined, 0), RangeError)
    assert.throws(() => countedLoss(undefined, -1), RangeError)
    assert.throws(() => countedLoss(undefined, 1.5), RangeError)
  })
})

describe('[protocol] Pending queue - redelivery', () => {
  it('should back off through the waits and then repeat the last one', () => {
    // Act
    const waits = [1, 2, 3, 4, 5, 50].map((sends) => redeliveryDelayMs(sends))

    // Assert
    assert.deepEqual(waits, [5000, 30_000, 120_000, 600_000, 600_000, 600_000])
    assert.equal(EVENT_REDELIVERY_DELAYS_MS.at(-1), 600_000)
  })

  it('should have no wait for an event never forwarded', () => {
    // Act + Assert
    assert.throws(() => redeliveryDelayMs(0), RangeError)
    assert.throws(() => redeliveryDelayMs(1.5), RangeError)
  })
})
