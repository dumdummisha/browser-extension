import { z } from 'zod'
import { type CaptureHealth, SlackAccountSchema, SlackMessageFrameSchema } from '../protocol/slack.js'

// The messages between a Slack tab's observer, its relay and the service worker (extension/observer.ts, relay.ts and
// background.ts). What the page reports is data: it becomes events and status, never a command.

// A new message the observer saw, already cut down in the page (message-projection.ts), with the account the tab showed
// when it came: the workspace in its address, and that workspace's signed-in user in Slack's saved client state.
const FrameMessageSchema = z.strictObject({
  kind: z.literal('frame'),
  account: SlackAccountSchema,
  frame: SlackMessageFrameSchema,
})

// What the observer posts the relay on their private channel: a new message, under its number in the observer's
// sequence, which the relay posts back once the service worker took it (capture-handshake.ts), or whether it sees a
// socket open. The observer runs in the page's world, so the relay checks each one before it keeps or passes on
// anything.
export const ObserverMessageSchema = z.discriminatedUnion('kind', [
  FrameMessageSchema.extend({ seq: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('socket'), isSocketOpen: z.boolean() }),
])

// What a Slack tab's relay tells the service worker: a new message it checked, or that the tab's capture changed.
export const ObservedMessageSchema = z.discriminatedUnion('kind', [
  FrameMessageSchema,
  z.strictObject({ kind: z.literal('capture') }),
])

export type ObservedMessage = z.infer<typeof ObservedMessageSchema>

// What a relay answers the service worker's CAPTURE_QUERY: the observer's last socket state, null until it reported (so
// null means no observer in the page), and what the observer sent that did not read, null while nothing did.
export const RelayCaptureSchema = z.strictObject({
  isSocketOpen: z.boolean().nullable(),
  error: z.string().min(1).nullable(),
})

export type RelayCapture = z.infer<typeof RelayCaptureSchema>

// A tab's capture, from what its relay answered CAPTURE_QUERY. An answer that does not read is that tab's failed
// capture, so it can never fail the status of every tab.
export const captureHealthOf = (tabId: number, answer: unknown): CaptureHealth => {
  const capture = RelayCaptureSchema.safeParse(answer)
  if (!capture.success) {
    return { tabId, state: 'failed', error: `The relay in tab ${tabId} answered no capture state` }
  }

  const { isSocketOpen, error } = capture.data
  if (error !== null) {
    return { tabId, state: 'failed', error }
  }

  return isSocketOpen === null ? { tabId, state: 'detached' } : { tabId, state: 'attached', isSocketOpen }
}
