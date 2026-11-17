import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DROPPED_EVENTS_KEY,
  EVENT_REDELIVERY_DELAYS_MS,
  PendingQueueError,
  pendingEventKey,
  redeliveryDelayMs,
  restoredQueue,
} from './pending-queue.js'
import { type SlackEvent, slackEventKey } from './slack.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }

const eventAt = (channel: string, ts: string): SlackEvent => {
  const frame = { type: 'message', channel, ts } as const

  return { type: 'event', id: slackEventKey(ACCOUNT, frame), account: ACCOUNT, frame } as const
}

describe('[protocol] Pending queue - restoring', () => {
  it('should restore stored events oldest message first, with the loss count', () => {
    // Arrange
    const later = eventAt('C0EXAMPLE1', '1700000001.000100')
    const earlier = eventAt('D0EXAMPLE1', '999999999.000900')
    const sameTs = eventAt('C0EXAMPLE2', '1700000001.000100')
    const stored = {
      [pendingEventKey(later.id)]: later,
      [pendingEventKey(earlier.id)]: earlier,
      [pendingEventKey(sameTs.id)]: sameTs,
      [DROPPED_EVENTS_KEY]: 3,
      'another-feature': { kept: true },
    }

    // Act
    const queue = restoredQueue(stored)

    // Assert
    assert.deepEqual(queue, { events: [earlier, later, sameTs], droppedEvents: 3, unreadableKeys: [] })
  })

  it('should start from no loss when nothing was ever lost', () => {
    // Act
    const queue = restoredQueue({})

    // Assert
    assert.deepEqual(queue, { events: [], droppedEvents: 0, unreadableKeys: [] })
  })

  it('should hand back entries it cannot deliver, so they are removed and counted', () => {
    // Arrange
    const event = eventAt('C0EXAMPLE1', '1700000001.000100')
    const elsewhere = eventAt('C0EXAMPLE1', '1700000002.000100')
    const stored = {
      [pendingEventKey(event.id)]: { ...event, frame: { ...event.frame, ts: 'not-a-ts' } },
      [pendingEventKey(elsewhere.id)]: event,
    }

    // Act
    const queue = restoredQueue(stored)

    // Assert
    assert.deepEqual(queue, {
      events: [],
      droppedEvents: 0,
      unreadableKeys: [pendingEventKey(event.id), pendingEventKey(elsewhere.id)],
    })
  })

  it('should refuse a loss count that is no count rather than guess one', () => {
    // Act + Assert
    assert.throws(() => restoredQueue({ [DROPPED_EVENTS_KEY]: '3' }), PendingQueueError)
    assert.throws(() => restoredQueue({ [DROPPED_EVENTS_KEY]: -1 }), PendingQueueError)
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
