import { z } from 'zod'
import { CaptureHealthSchema, OperationParitySchema, SlackIdentitySchema } from './slack.js'
import { WhatsAppTabStatusSchema } from './whatsapp.js'

const EventCountSchema = z.number().int().nonnegative()

// The stored loss count as a failing queue knows it. Nothing but the queue's one writer changes it, so the count the
// writer last read or committed is the stored one (last-known). It is unavailable when no read of it succeeded since
// the worker started: the database did not open, the read failed, or the stored record is no count (pending-queue.ts
// droppedEventsOf). An unavailable count is never reported as zero, which would read as a reset.
export const FailingLossSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('last-known'), droppedEvents: EventCountSchema }),
  z.strictObject({ kind: z.literal('unavailable') }),
])

// Whether the extension's pending queue commits its changes (pending-queue.ts):
// - committing: its last change committed. droppedEvents is the stored count of every event the extension lost since
//   it was installed (no room in the queue, a stored record it could not read back, and the events a queue failure
//   lost, once a later change counts them). It survives restarts and only grows, so a count higher than the last one
//   the app saw is a loss to report.
// - failing: a change did not commit. error is what its transaction failed with. unstoredEvents are events the queue
//   could not store that the extension holds in memory only, forwarded to a listener directly; the app has not
//   acknowledged them yet, and a worker restart before a change commits loses them. uncountedEvents are events lost for
//   want of room that the stored count does not include yet. loss is the stored count as far as the writer knows it.
//   It is a capture failure, and it clears when a change commits, which stores the unstored events or counts them.
export const QueueHealthSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('committing'), droppedEvents: EventCountSchema }),
  z.strictObject({
    state: z.literal('failing'),
    error: z.string().min(1),
    unstoredEvents: EventCountSchema,
    uncountedEvents: EventCountSchema,
    loss: FailingLossSchema,
  }),
])

// The extension's status, pushed to the listener when it attaches and on every change (background.ts pushStatus).
// identities, captures and parity are Slack's (slack.ts); parity is the transport check, one entry per operation the
// transport sent since the service worker started. queue is the pending queue every platform's events share.
// whatsapp: one entry per open WhatsApp Web tab (whatsapp.ts WhatsAppTabStatusSchema).
export const BridgeStatusSchema = z.strictObject({
  type: z.literal('status'),
  identities: z.array(SlackIdentitySchema),
  captures: z.array(CaptureHealthSchema),
  queue: QueueHealthSchema,
  parity: z.array(OperationParitySchema),
  whatsapp: z.array(WhatsAppTabStatusSchema),
})

export type QueueHealth = z.infer<typeof QueueHealthSchema>
export type BridgeStatus = z.infer<typeof BridgeStatusSchema>
