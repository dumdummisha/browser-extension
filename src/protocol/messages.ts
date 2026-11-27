import { z } from 'zod'
import { BridgeEventSchema } from './events.js'
import { BridgeStatusSchema } from './status.js'

// The wire between the extension, the native host's relay and the relay's socket clients (the app, and any process
// that drives the browser). Every connection opens with a hello from each end (handshake.ts): no other traffic flows
// on a leg until both ends name the same PROTOCOL_REVISION. Requests and replies work as before: a client numbers its
// requests, the relay renumbers them for the extension and routes each reply back to the client that asked. The
// extension also sends what nobody asked for: events, held in its durable pending queue until the app acknowledges each
// one after committing it (pending-queue.ts), and status snapshots. They go to the one client that listens (the newest
// to send listen), and the relay tells the extension each time a listener attaches, so the extension sends its status
// and every event still waiting, then forwards again whatever stays unacknowledged (EVENT_REDELIVERY_DELAYS_MS). With
// no listener the relay drops them; the extension still holds the events. While the pending queue fails, an event it
// could not store is forwarded directly from the extension's memory, in the same event message and acknowledged the
// same way, so the app's commit before its ack is what keeps it.

// The native messaging host's name: the extension connects to it, and the installer registers it with each browser.
export const NATIVE_HOST_NAME = 'misha.browser_bridge'

// The wire's one protocol revision. Two ends talk only when their revisions are exactly equal, whatever their package
// versions say; there is no negotiation and no adapter between revisions. Raise it with every change to a message
// that the other end must understand. 1 is the first versioned contract: an end that sends no revision is not taken
// for revision 1.
export const PROTOCOL_REVISION = 1

// Who says hello: the extension and the host on the native leg; the host and a client, or a host that takes the socket
// over (takeover), on the socket leg.
export const BridgeRoleSchema = z.enum(['extension', 'host', 'client', 'takeover'])
export type BridgeRole = z.infer<typeof BridgeRoleSchema>

// The two legs: the extension's native port to its host, and a client's connection to the host's socket.
export const BridgeLegSchema = z.enum(['extension-host', 'host-client'])
export type BridgeLeg = z.infer<typeof BridgeLegSchema>

const ProtocolRevisionSchema = z.number().int()

// The envelope every hello keeps across revisions: its type and its protocol revision, which an end reads before
// anything else, so a hello of another revision is told apart from one that does not read.
export const HelloEnvelopeSchema = z.object({ type: z.literal('hello'), protocolRevision: ProtocolRevisionSchema })

const helloFields = {
  type: z.literal('hello'),
  protocolRevision: ProtocolRevisionSchema,
  // The package version of the end that says hello, for diagnostics only: equal revisions talk whatever it says.
  componentVersion: z.string().min(1),
}

// The host's hello, to the extension and to each client. browserApp: the browser's .app bundle, which the native host
// reads from its parent process, or null when it could not tell.
export const HostHelloSchema = z.strictObject({
  ...helloFields,
  role: z.literal('host'),
  browserApp: z.string().nullable(),
})

export const ExtensionHelloSchema = z.strictObject({ ...helloFields, role: z.literal('extension') })
export const ClientHelloSchema = z.strictObject({ ...helloFields, role: z.enum(['client', 'takeover']) })

// Why a leg cannot be used: the ends name different revisions, one said no hello in time, its hello does not read, or
// it sent something else where only a hello may come (before agreement, or a second hello after it).
export const IncompatibilityReasonSchema = z.enum([
  'revision-mismatch',
  'missing-hello',
  'malformed-hello',
  'unexpected-frame',
])

// What the user does about it (handshake.ts RECOVERY_TEXT).
export const RecoveryCodeSchema = z.enum([
  'update-extension',
  'update-app',
  'restart-browser-and-app',
  'versions-unchecked',
])

// The diagnostic an end sends when a leg cannot be used, kept stable across revisions so an end of any revision reads
// it. local is the end that found the failure; peer holds only what the other end's message said and read, so a value
// a malformed hello did not carry is absent, never made up.
export const BridgeIncompatibleSchema = z.strictObject({
  type: z.literal('bridge-incompatible'),
  reason: IncompatibilityReasonSchema,
  leg: BridgeLegSchema,
  local: z.strictObject({
    role: BridgeRoleSchema,
    protocolRevision: ProtocolRevisionSchema,
    componentVersion: z.string(),
  }),
  peer: z.strictObject({
    role: BridgeRoleSchema.optional(),
    protocolRevision: ProtocolRevisionSchema.optional(),
    componentVersion: z.string().optional(),
  }),
  recovery: RecoveryCodeSchema,
})

// The host's state of its extension leg, sent to every client when it connects and whenever it changes, whatever the
// client's own leg says. A client is usable only once its own hello agreed and this says ready. An incompatible
// extension leg is sent as the host's diagnostic instead.
const ExtensionLegSchema = z.strictObject({
  type: z.literal('extension-leg'),
  state: z.enum(['awaiting-hello', 'ready']),
})

const RequestIdSchema = z.number().int()

// method stays a string on the wire, so an extension older than its client can name what it does not know. deadline:
// when the client stops waiting for the reply, in milliseconds since the epoch on this Mac's clock; once it has passed,
// the extension hands nothing of the request to a Slack page, and the page fetches nothing.
const RequestSchema = z.strictObject({
  type: z.literal('request'),
  id: RequestIdSchema,
  method: z.string(),
  params: z.unknown(),
  deadline: z.number().int().positive(),
})

// A request whose caller gave up before its deadline: from a client, which abandoned it, and from the relay, for each
// request of a client whose connection closed. The extension then hands nothing more of it to a Slack page; a command
// already handed to the page still goes out, as a fetch already started would.
const CancelSchema = z.strictObject({ type: z.literal('cancel'), id: RequestIdSchema })
const ReplyResultSchema = z.strictObject({ type: z.literal('reply'), id: RequestIdSchema, result: z.unknown() })
const ReplyErrorSchema = z.strictObject({ type: z.literal('reply'), id: RequestIdSchema, error: z.string() })
const AckSchema = z.strictObject({ type: z.literal('ack'), id: z.string() })
const ListenSchema = z.strictObject({ type: z.literal('listen') })
const ListenerSchema = z.strictObject({ type: z.literal('listener') })

// The newest browser's host takes the socket over: it connects to the relay holding it, and once both hellos agreed (it
// says hello as takeover), sends takeover, and that relay closes its server, which removes the socket's path, and then
// every connection, after which the new host binds the path. The relay that let go stays up for its own browser until
// its pipe ends, reaching no client. A takeover never waits for either relay's extension leg.
export const TakeoverSchema = z.strictObject({ type: z.literal('takeover') })

// A client to the relay, one per line, once both hellos agreed and the extension leg is ready.
export const ClientMessageSchema = z.union([RequestSchema, CancelSchema, ListenSchema, AckSchema])
// The relay to a client, one per line, at any time after its hello: the state of its extension leg, or its diagnostic.
export const RelayControlSchema = z.union([ExtensionLegSchema, BridgeIncompatibleSchema])
// The relay to a ready client, one per line: replies to its requests and, to the listener, events and status snapshots.
export const RelayMessageSchema = z.union([ReplyResultSchema, ReplyErrorSchema, BridgeEventSchema, BridgeStatusSchema])
// The relay to the extension, one per native messaging frame, once both hellos agreed.
export const HostFrameSchema = z.union([RequestSchema, CancelSchema, AckSchema, ListenerSchema])
// The extension to the relay, one per native messaging frame, once both hellos agreed.
export const ExtensionFrameSchema = z.union([
  ReplyResultSchema,
  ReplyErrorSchema,
  BridgeEventSchema,
  BridgeStatusSchema,
])

export type HostHello = z.infer<typeof HostHelloSchema>
export type ExtensionHello = z.infer<typeof ExtensionHelloSchema>
export type ClientHello = z.infer<typeof ClientHelloSchema>
export type BridgeIncompatible = z.infer<typeof BridgeIncompatibleSchema>
export type IncompatibilityReason = z.infer<typeof IncompatibilityReasonSchema>
export type RecoveryCode = z.infer<typeof RecoveryCodeSchema>
export type Takeover = z.infer<typeof TakeoverSchema>
export type ClientMessage = z.infer<typeof ClientMessageSchema>
export type RelayControl = z.infer<typeof RelayControlSchema>
export type RelayMessage = z.infer<typeof RelayMessageSchema>
export type HostFrame = z.infer<typeof HostFrameSchema>
export type ExtensionFrame = z.infer<typeof ExtensionFrameSchema>
