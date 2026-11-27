import { type SlackEvent, SlackEventSchema } from './slack.js'

// Every event the extension captures, whatever its platform: what the pending queue stores, the forwarder sends, the
// host relay passes to the listener and the client hands the app. Slack's event is the only one, so it is the schema
// itself, and a stored Slack event reads exactly as the platform's own schema reads it.
export const BridgeEventSchema = SlackEventSchema

export type BridgeEvent = SlackEvent

// When the message an event carries was sent, in whole microseconds, so the pending queue forwards restored events
// oldest first: Slack's ts already counts microseconds after its dot, and as one whole number ten-digit and nine-digit
// seconds compare right.
export const eventTimeMicros = (event: BridgeEvent): bigint => BigInt(event.frame.ts.replace('.', ''))
