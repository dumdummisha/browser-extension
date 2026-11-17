import { z } from 'zod'

// What a Slack tab's relay tells the service worker: a frame the observer saw on Slack's socket, as its raw text, or
// that the observer's socket state changed. It comes from the page, so it is data the service worker checks and never a
// command.
export const ObservedMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('frame'), text: z.string() }),
  z.strictObject({ kind: z.literal('capture') }),
])

export type ObservedMessage = z.infer<typeof ObservedMessageSchema>

// The observer's socket state, as the relay keeps it for the service worker to ask for.
export const SocketStateSchema = z.strictObject({ isSocketOpen: z.boolean() })
