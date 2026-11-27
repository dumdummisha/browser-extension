import { z } from 'zod'
import { type CaptureHealth, SlackAccountSchema, SlackMessageFrameSchema } from '../protocol/slack.js'
import { isApiOrigin, isBorrowedQuery } from './borrowed-query.js'

// The messages between a Slack tab's observer, its relay and the service worker (extension/observer.ts, relay.ts and
// background.ts). What the page reports is data: it becomes events and status, never a command. The client query it
// reports only shapes the envelope of a call the Misha app asked for (background.ts callSlack), and never starts one.

// A new message the observer saw, already cut down in the page (message-projection.ts), with the account the tab showed
// when it came: the workspace in its address, and that workspace's signed-in user in Slack's saved client state.
const FrameMessageSchema = z.strictObject({
  kind: z.literal('frame'),
  account: SlackAccountSchema,
  frame: SlackMessageFrameSchema,
})

// A client query the observer kept (client-query-keeper.ts), by the same rules borrowedQueryOf cut it down with, and the
// origin of the workspace API it belongs to, as URL writes one.
const BorrowedQuerySchema = z.array(z.tuple([z.string(), z.string().nullable()])).refine(isBorrowedQuery)
const ApiOriginSchema = z.string().refine(isApiOrigin)
const ClientQueriesSchema = z.record(ApiOriginSchema, BorrowedQuerySchema)

export type ClientQueries = z.infer<typeof ClientQueriesSchema>

// The kinds of observer message that carry a client query. One that does not read fails the capture with a fixed text,
// never zod's, whose paths would quote the record keys it rejected.
export const CLIENT_QUERY_KINDS: ReadonlySet<unknown> = new Set(['greeting', 'client-query'])

// What the observer posts the relay on their private channel:
// - greeting: its first message to each relay, with whether it sees a socket open and every client query it keeps
// - socket: a change of the socket state, and the first message of an observer from before client queries, which
//   keeps none
// - client-query: a change of the query it keeps for one workspace API
// - frame: a new message, under its number in the observer's sequence, which the relay posts back once the service
//   worker took it (capture-handshake.ts)
// The observer runs in the page's world, so the relay checks each one before it keeps or passes on anything.
export const ObserverMessageSchema = z.discriminatedUnion('kind', [
  FrameMessageSchema.extend({ seq: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('greeting'), isSocketOpen: z.boolean(), queries: ClientQueriesSchema }),
  z.strictObject({ kind: z.literal('socket'), isSocketOpen: z.boolean() }),
  z.strictObject({ kind: z.literal('client-query'), origin: ApiOriginSchema, query: BorrowedQuerySchema }),
])

export type ObserverMessage = z.infer<typeof ObserverMessageSchema>

// What a Slack tab's relay tells the service worker: a new message it checked, or that the tab's capture changed.
export const ObservedMessageSchema = z.discriminatedUnion('kind', [
  FrameMessageSchema,
  z.strictObject({ kind: z.literal('capture') }),
])

export type ObservedMessage = z.infer<typeof ObservedMessageSchema>

// What a relay answers the service worker's CAPTURE_QUERY: the observer's last socket state, null until it reported (so
// null means no observer in the page), and what the observer sent that did not read, null while nothing did.
const RelayCaptureSchema = z.strictObject({
  isSocketOpen: z.boolean().nullable(),
  error: z.string().min(1).nullable(),
})

export type RelayCapture = z.infer<typeof RelayCaptureSchema>

// What a relay answers the service worker's CLIENT_QUERY: the client queries its observer keeps, by workspace API
// origin, or null when it has none to give: no observer offered the relay a channel, the observer is from before
// client queries (its first message was a socket state), or the capture failed. The service worker reads an answer
// that does not read as null for that tab.
export const RelayClientQuerySchema = z.strictObject({ queries: ClientQueriesSchema.nullable() })

export type RelayClientQuery = z.infer<typeof RelayClientQuerySchema>

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
