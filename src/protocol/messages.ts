import { z } from 'zod'
import { SlackEventSchema, SlackStatusSchema } from './slack.js'

// The wire between the extension, the native host's relay and the relay's socket clients (the app, and any process
// that drives the browser). Requests and replies work as before: a client numbers its requests, the relay renumbers
// them for the extension and routes each reply back to the client that asked. The extension also sends what nobody
// asked for: events, held in its durable pending queue until the app acknowledges each one after committing it
// (pending-queue.ts), and status snapshots. They go to the one client that listens (the newest to send listen), and
// the relay tells the extension each time a listener attaches, so the extension sends its status and every event
// still waiting, then forwards again whatever stays unacknowledged (EVENT_REDELIVERY_DELAYS_MS). With no listener the
// relay drops them; the extension still holds the events. While the pending queue fails, an event it could not store
// is forwarded directly from the extension's memory, in the same event message and acknowledged the same way, so the
// app's commit before its ack is what keeps it.

// The native messaging host's name: the extension connects to it, and the installer registers it with each browser.
export const NATIVE_HOST_NAME = 'misha.browser_bridge'

const RequestIdSchema = z.number().int()

// method stays a string on the wire, so an extension older than its client can name what it does not know. deadline:
// when the client stops waiting for the reply, in milliseconds since the epoch on this Mac's clock; the extension sends
// nothing of a request to Slack once it has passed.
const RequestSchema = z.strictObject({
  type: z.literal('request'),
  id: RequestIdSchema,
  method: z.string(),
  params: z.unknown(),
  deadline: z.number().int().positive(),
})
// A request whose caller gave up before its deadline: from a client, which abandoned it, and from the relay, for each
// request of a client whose connection closed. The extension then sends nothing more of it to Slack.
const CancelSchema = z.strictObject({ type: z.literal('cancel'), id: RequestIdSchema })
const ReplyResultSchema = z.strictObject({ type: z.literal('reply'), id: RequestIdSchema, result: z.unknown() })
const ReplyErrorSchema = z.strictObject({ type: z.literal('reply'), id: RequestIdSchema, error: z.string() })
const AckSchema = z.strictObject({ type: z.literal('ack'), id: z.string() })
const ListenSchema = z.strictObject({ type: z.literal('listen') })
const ListenerSchema = z.strictObject({ type: z.literal('listener') })
const HelloSchema = z.strictObject({ type: z.literal('hello'), browserApp: z.string().nullable() })
// The newest browser's host takes the socket over: it connects to the relay holding it and sends takeover, and that
// relay closes its server, which removes the socket's path, and then every connection, after which the new host binds
// the path. The relay that let go stays up for its own browser until its pipe ends, reaching no client.
const TakeoverSchema = z.strictObject({ type: z.literal('takeover') })

// A client to the relay, one per line.
export const ClientMessageSchema = z.union([RequestSchema, CancelSchema, ListenSchema, AckSchema, TakeoverSchema])
// The relay to a client, one per line: a hello first, then replies to its requests and, to the listener, events and
// status snapshots.
export const RelayMessageSchema = z.union([
  HelloSchema,
  ReplyResultSchema,
  ReplyErrorSchema,
  SlackEventSchema,
  SlackStatusSchema,
])
// The relay to the extension, one per native messaging frame.
export const HostFrameSchema = z.union([RequestSchema, CancelSchema, AckSchema, ListenerSchema])
// The extension to the relay, one per native messaging frame.
export const ExtensionFrameSchema = z.union([ReplyResultSchema, ReplyErrorSchema, SlackEventSchema, SlackStatusSchema])

export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type RelayMessage = z.infer<typeof RelayMessageSchema>
export type HostFrame = z.infer<typeof HostFrameSchema>
export type ExtensionFrame = z.infer<typeof ExtensionFrameSchema>
