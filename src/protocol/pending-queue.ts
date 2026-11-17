import { z } from 'zod'
import { type SlackEvent, SlackEventSchema } from './slack.js'

// The extension's pending queue: every event it captured that the app has not acknowledged yet. Service workers stop
// and restart and the browser quits, so the queue lives in the extension's own durable storage (chrome.storage.local),
// never only in memory:
// - an event is written to storage before it is forwarded; one that cannot be written is not admitted, and is counted
// - on startup the extension restores the queue (restoredQueue) before it forwards anything
// - an event leaves storage only when the app's ack for it arrives, which the app sends after the commit that took it
// - the loss count (the status's droppedEvents) is stored beside the events, so it survives restarts too
//
// Storage holds one item per event, under pendingEventKey(id), whose value is the event exactly as it goes on the wire
// (SlackEventSchema), so admitting an event writes one item rather than the whole queue. One more item,
// DROPPED_EVENTS_KEY, holds the loss count; it is absent until the first loss. A full queue can outgrow
// storage.local's default quota, so the manifest asks for unlimitedStorage.

// Events the queue holds at most. When it is full, a new event is dropped and counted, so the queue keeps the oldest
// run in order.
export const EVENT_QUEUE_MAX = 2000
// Event ids the extension remembers after their ack, so a second tab reporting the same message later is dropped
// there; the app's unique event receipt drops any that get past.
export const EVENT_IDS_REMEMBERED = 5000

export const PENDING_EVENT_KEY_PREFIX = 'pending-event:'
export const DROPPED_EVENTS_KEY = 'dropped-events'

export const pendingEventKey = (eventId: string): string => `${PENDING_EVENT_KEY_PREFIX}${eventId}`

// While a listener is attached, an event forwarded and not yet acknowledged is forwarded again under the same id after
// each of these waits in turn, and then after the last one again for as long as it stays pending. They are the retry
// waits Misha's earlier cloud router used for an event it failed to route, up to ten minutes. They repeat rather than
// end, because that router gave an event up after its last wait and an event given up here is lost. A listener attaching
// gets every pending event at once, and each one's waits start over. The app does not acknowledge an event it failed
// to commit, and taking a repeat it already has changes nothing (its receipt is unique), so redelivery needs no reply
// of its own: the extension owns it, and the app only acknowledges.
export const EVENT_REDELIVERY_DELAYS_MS = [5000, 30_000, 120_000, 600_000] as const

// The wait before forwarding a pending event again, once it has been forwarded `sends` times to the current listener.
export const redeliveryDelayMs = (sends: number): number => {
  const delay = EVENT_REDELIVERY_DELAYS_MS[Math.min(sends, EVENT_REDELIVERY_DELAYS_MS.length) - 1]
  if (delay === undefined) {
    throw new RangeError(`An event forwarded ${sends} times has no next wait`)
  }

  return delay
}

export class PendingQueueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PendingQueueError'
  }
}

export interface IRestoredQueue {
  // Oldest message first (by its ts, then its id), the order they are forwarded in.
  readonly events: SlackEvent[]
  readonly droppedEvents: number
  // Items under the prefix that hold no readable event, or another event than their key names. They can never be
  // delivered: the extension removes them and adds their number to droppedEvents.
  readonly unreadableKeys: string[]
}

const DroppedEventsSchema = z.number().int().nonnegative()

// By the message's ts, as a whole number of microseconds so ten-digit and nine-digit seconds compare right, then by id.
const compareMessages = (left: SlackEvent, right: SlackEvent): number => {
  const leftTs = BigInt(left.frame.ts.replace('.', ''))
  const rightTs = BigInt(right.frame.ts.replace('.', ''))
  if (leftTs !== rightTs) {
    return Number(leftTs > rightTs) - Number(leftTs < rightTs)
  }

  return Number(left.id > right.id) - Number(left.id < right.id)
}

// The queue as the extension finds it on startup, from everything chrome.storage.local holds (get(null)). Items under
// other keys are not the queue's and are left alone. A loss count that is not a count is an error: guessing one would
// hide how many events were lost.
export const restoredQueue = (stored: Readonly<Record<string, unknown>>): IRestoredQueue => {
  const storedCount = stored[DROPPED_EVENTS_KEY]
  const droppedEvents = DroppedEventsSchema.safeParse(storedCount ?? 0)
  if (!droppedEvents.success) {
    throw new PendingQueueError(`The stored ${DROPPED_EVENTS_KEY} is no count: ${JSON.stringify(storedCount)}`)
  }

  const events: SlackEvent[] = []
  const unreadableKeys: string[] = []
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(PENDING_EVENT_KEY_PREFIX)) {
      continue
    }

    const event = SlackEventSchema.safeParse(value)
    if (event.success && pendingEventKey(event.data.id) === key) {
      events.push(event.data)
    } else {
      unreadableKeys.push(key)
    }
  }

  return {
    events: events.sort(compareMessages),
    droppedEvents: droppedEvents.data,
    unreadableKeys,
  }
}
