import { z } from 'zod'
import { type SlackEvent, SlackEventSchema } from './slack.js'

// The extension's pending queue: every event it captured that the app has not acknowledged yet, and the count of the
// events it lost (the status's droppedEvents). Service workers stop and restart and the browser quits, so both live in
// IndexedDB in the extension's origin, never only in memory. IndexedDB commits a transaction over several stores whole
// or not at all, so deleting an event and counting it as lost commit together, and a crash between the two can neither
// hide that loss nor count it twice. chrome.storage has no such transaction, and the queue does not use it. What a
// failing database can still lose without a count is stated below the writer's changes.
//
// The database is PENDING_QUEUE_DATABASE at PENDING_QUEUE_DATABASE_VERSION, created with two stores, each with keyPath
// STORE_KEY_PATH:
// - PENDING_EVENTS_STORE: one record per pending event, the event exactly as it goes on the wire (SlackEventSchema), so
//   a record's key is its event's id
// - LOSS_STORE: at most one record, DroppedEventsRecordSchema under DROPPED_EVENTS_ID, absent until the first loss
// Chrome may evict an extension's IndexedDB under storage pressure, which would take the queue and its count with it,
// unless the extension holds the unlimitedStorage permission, so the manifest asks for it.
//
// Only the extension's service worker opens the database, and one writer there makes every change, one at a time, each
// as one readwrite transaction over both stores with durability strict, so a commit means the change is on disk:
// 1. recovery, when the worker starts and before any intake or ack: read every pending record and the loss record
//    (restoredQueue), delete the records that hold no readable event, and add their number to the count (countedLoss).
//    Once it commits, the extension forwards the restored events. An event captured before then waits for it.
// 2. admitting a captured event: an event already pending changes nothing; with fewer than EVENT_QUEUE_MAX pending, the
//    event is put, and with the queue full it is counted instead (countedLoss). An event whose put committed is
//    forwarded from the queue.
// 3. the ack, which the app sends after the commit that took the event. The writer remembers the event as acknowledged
//    at once. An unstored event (below) is dropped from memory and from its redelivery at once, with no transaction,
//    since the app already committed it; that alone does not end a queue failure. A stored event is deleted in a
//    change's transaction, before anything else that transaction does, so the room it frees counts for the unstored
//    events the same transaction admits, and its redelivery stops only once that commits. A deletion that does not
//    commit leaves the event pending and forwarded again: every change deletes the acknowledged events still stored
//    before anything else, so the first change that commits frees their room.
// A change whose transaction does not commit (it aborts or fails, on the quota or anything else) is a queue failure,
// which the status reports as failing (slack.ts QueueHealthSchema) until a change commits. A recovery that failed runs
// again before the next change, so while it keeps failing every admission fails too. An event whose admission did not
// commit is unstored: the writer holds it in memory, at most EVENT_QUEUE_MAX of them, and forwards it to the listener
// directly, now when one is attached and to each listener that attaches later, with the same redelivery waits as a
// stored event. The app commits an event before it acknowledges it, so an acknowledged unstored event is durable on the
// app's side, and the ack drops it from memory. An unstored event beyond the limit is lost for want of room, and the
// writer keeps their number, uncounted. The next change that commits applies its own deletion first when it is an ack,
// then admits every unstored event still held by rule 2 and adds the uncounted number to the count, all in its own
// transaction, and the failure clears. If that transaction does not commit, the unstored events stay held.
//
// The limit that remains: an event is lost without a durable count only when its admission did not commit, the app did
// not commit it (no listener was attached, or the app had not acknowledged it yet), and the worker restarts before any
// later change commits. While the worker lives, the status reports the failure and the events at risk (unstoredEvents
// and uncountedEvents). No mechanism closes this. The loss happens because the queue's storage is failing, and that
// storage is the only durable place the extension has, so a record of the loss written there fails the same way. A
// marker that took every worker start after an unclean stop for a gap would report a false gap on every service-worker
// restart, since Chrome stops service workers without a clean shutdown, and a gap reported on every restart tells the
// app nothing.

// Events the queue holds at most. When it is full, a new event is dropped and counted, so the queue keeps the oldest
// run in order.
export const EVENT_QUEUE_MAX = 2000
// Event ids the extension remembers after their ack, so a second tab reporting the same message later is dropped
// there; the app's unique event receipt drops any that get past.
export const EVENT_IDS_REMEMBERED = 5000

export const PENDING_QUEUE_DATABASE = 'misha-pending-queue'
export const PENDING_QUEUE_DATABASE_VERSION = 1
export const PENDING_EVENTS_STORE = 'pending-events'
export const LOSS_STORE = 'loss'
export const STORE_KEY_PATH = 'id'
export const DROPPED_EVENTS_ID = 'dropped-events'

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

// The one record of LOSS_STORE: how many events the extension lost since it was installed (no room in the queue, a
// stored record it could not read back, and the events a queue failure lost for want of room, once a later change
// counts them). It only grows.
export const DroppedEventsRecordSchema = z.strictObject({
  id: z.literal(DROPPED_EVENTS_ID),
  droppedEvents: z.number().int().nonnegative(),
})

export type DroppedEventsRecord = z.infer<typeof DroppedEventsRecordSchema>

// A record of PENDING_EVENTS_STORE as recovery's cursor reads it: its primary key and its value.
export interface IStoredPendingEvent {
  readonly key: IDBValidKey
  readonly value: unknown
}

export interface IRestoredQueue {
  // Oldest message first (by its ts, then its id), the order they are forwarded in.
  readonly events: SlackEvent[]
  readonly droppedEvents: number
  // The records that hold no readable event. They can never be delivered: recovery deletes them and adds their number
  // to the count, in its one transaction.
  readonly unreadableKeys: IDBValidKey[]
}

// The count LOSS_STORE holds, from what IDBObjectStore.get answered for DROPPED_EVENTS_ID: zero only when there is no
// record (undefined). Anything else, null included, has to be a DroppedEventsRecord, or it is an error: guessing a
// count would hide how many events were lost. Only a get that succeeded is read here: a get or a transaction that
// failed is a queue failure, never the absent record, and until a read succeeds the status reports the count as
// unavailable (slack.ts FailingLossSchema).
export const droppedEventsOf = (lossRecord: unknown): number => {
  if (lossRecord === undefined) {
    return 0
  }

  const record = DroppedEventsRecordSchema.safeParse(lossRecord)
  if (!record.success) {
    throw new PendingQueueError(`The stored loss record is no count:\n${z.prettifyError(record.error)}`)
  }

  return record.data.droppedEvents
}

// The LOSS_STORE record that counts `lost` more events than lossRecord, which the same transaction read. The count
// only grows, so `lost` is a whole number above zero.
export const countedLoss = (lossRecord: unknown, lost: number): DroppedEventsRecord => {
  if (!Number.isInteger(lost) || lost < 1) {
    throw new RangeError(`${lost} is no number of lost events`)
  }

  return { id: DROPPED_EVENTS_ID, droppedEvents: droppedEventsOf(lossRecord) + lost }
}

// By the message's ts, as a whole number of microseconds so ten-digit and nine-digit seconds compare right, then by id.
const compareMessages = (left: SlackEvent, right: SlackEvent): number => {
  const leftTs = BigInt(left.frame.ts.replace('.', ''))
  const rightTs = BigInt(right.frame.ts.replace('.', ''))
  if (leftTs !== rightTs) {
    return Number(leftTs > rightTs) - Number(leftTs < rightTs)
  }

  return Number(left.id > right.id) - Number(left.id < right.id)
}

// The queue as recovery finds it, from every record of PENDING_EVENTS_STORE and the LOSS_STORE record (droppedEventsOf).
// The store's keyPath makes each record's key its event's id, so a record is readable exactly when its value is an
// event.
export const restoredQueue = (records: readonly IStoredPendingEvent[], lossRecord: unknown): IRestoredQueue => {
  const droppedEvents = droppedEventsOf(lossRecord)
  const events: SlackEvent[] = []
  const unreadableKeys: IDBValidKey[] = []
  for (const { key, value } of records) {
    const event = SlackEventSchema.safeParse(value)
    if (event.success) {
      events.push(event.data)
    } else {
      unreadableKeys.push(key)
    }
  }

  return { events: events.sort(compareMessages), droppedEvents, unreadableKeys }
}
