import { z } from 'zod'
import { type SlackEvent, SlackEventSchema } from './slack.js'
import { WhatsAppEventSchema } from './whatsapp.js'

// Every event the extension captures, whatever its platform: what the pending queue stores, the forwarder sends, the
// host relay passes to the listener and the client hands the app. Each platform's event is a strict object with its
// own payload field (a Slack event's frame, a WhatsApp event's message), so exactly one schema reads any event, and a
// stored Slack event reads as it did before WhatsApp existed.
export const BridgeEventSchema = z.union([SlackEventSchema, WhatsAppEventSchema])

export type BridgeEvent = z.infer<typeof BridgeEventSchema>

export const isSlackEvent = (event: BridgeEvent): event is SlackEvent => 'frame' in event

// The platforms whose events the extension captures. Each is the scheme its account ids, and so its event ids, start
// with (slack.ts slackAccountId, whatsapp.ts whatsappAccountId).
export const BRIDGE_PLATFORMS = ['slack', 'whatsapp'] as const

export type BridgePlatform = (typeof BRIDGE_PLATFORMS)[number]

// The platform an event id belongs to, from the scheme before its first colon, which every platform's event schema
// fixes (an event's id is its key, which starts with its account id); null for an id no platform's event can carry.
export const platformOfEventId = (id: string): BridgePlatform | null => {
  const colon = id.indexOf(':')
  const scheme = colon === -1 ? null : id.slice(0, colon)

  return BRIDGE_PLATFORMS.find((platform) => platform === scheme) ?? null
}

// An event's platform. Every event that read has one, so none is an error.
export const platformOf = (event: BridgeEvent): BridgePlatform => {
  const platform = platformOfEventId(event.id)
  if (platform === null) {
    throw new Error(`The event ${event.id} names no platform`)
  }

  return platform
}

// When the message an event carries was sent, in whole microseconds, so the pending queue forwards restored events of
// both platforms oldest first on one clock: Slack's ts already counts microseconds after its dot, and as one whole
// number ten-digit and nine-digit seconds compare right; WhatsApp's timestamp counts seconds.
export const eventTimeMicros = (event: BridgeEvent): bigint =>
  isSlackEvent(event) ? BigInt(event.frame.ts.replace('.', '')) : BigInt(event.message.timestamp) * 1_000_000n
