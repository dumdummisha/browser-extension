import { z } from 'zod'
import { type MessageField, NEW_MESSAGE_SUBTYPES } from './slack-message-fields.js'

// The Slack half of the protocol: who a tab is signed in as, what the page's observer reports, and what the app may ask
// the extension to do in a Slack tab. Every call names the account it acts as, and the extension acts only in a tab
// signed in as that account, so a tab that changed users never acts for the old one. Raw token and cookie values stay
// in the page: nothing here carries them.

const TEAM_ID_PATTERN = /^[TE][A-Z0-9]{2,}$/u
const USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/u
const ACCOUNT_ID_PATTERN = /^slack:(?<teamId>[TE][A-Z0-9]{2,}):(?<userId>[UW][A-Z0-9]{2,})$/u
// A Slack message timestamp: epoch seconds, a dot, then the microseconds that make it unique in its conversation.
const SLACK_TS_PATTERN = /^\d{9,10}\.\d{6}$/u
// Private files are served only from this host, with the browser's cookies; nothing else is fetched with them.
const FILE_URL_PROTOCOL = /^https$/u
const FILE_URL_HOSTNAME = /^files\.slack\.com$/u

export const SlackTsSchema = z.string().regex(SLACK_TS_PATTERN)

export const SlackAccountSchema = z.strictObject({
  teamId: z.string().regex(TEAM_ID_PATTERN),
  userId: z.string().regex(USER_ID_PATTERN),
})

export type SlackAccount = z.infer<typeof SlackAccountSchema>

// The account's key everywhere: the workspace and the signed-in user, so two workspaces or two users never collide.
export const slackAccountId = ({ teamId, userId }: SlackAccount): string => `slack:${teamId}:${userId}`

export const parseSlackAccountId = (accountId: string): SlackAccount => {
  const groups = ACCOUNT_ID_PATTERN.exec(accountId)?.groups
  if (groups?.teamId === undefined || groups.userId === undefined) {
    throw new Error(`${accountId} is not a Slack account id (slack:<team>:<user>)`)
  }

  return { teamId: groups.teamId, userId: groups.userId }
}

// The fields of a new message the app reads but its files (slack-message-fields.ts).
const messageFields = {
  type: z.literal('message'),
  subtype: z.enum(NEW_MESSAGE_SUBTYPES).optional(),
  channel: z.string().min(1),
  channel_type: z.string().min(1).optional(),
  ts: SlackTsSchema,
  user: z.string().min(1).optional(),
  bot_id: z.string().min(1).optional(),
  app_id: z.string().min(1).optional(),
  client_msg_id: z.string().min(1).optional(),
  text: z.string(),
  thread_ts: SlackTsSchema.optional(),
  parent_user_id: z.string().min(1).optional(),
} satisfies Record<MessageField, z.ZodType>

// A new message as the extension forwards it: only those fields and the ids of the files it shares, so nothing else the
// page received (file URLs, profiles, blocks) leaves it, and nothing in it ever becomes a command to the extension. The
// page's observer cuts each frame down to these before it leaves the page, and the relay checks it against this.
export const SlackMessageFrameSchema = z.strictObject({
  ...messageFields,
  files: z.array(z.strictObject({ id: z.string().min(1) })).optional(),
})

export type SlackMessageFrame = z.infer<typeof SlackMessageFrameSchema>

// Two tabs signed in as one account see the same message: its key is the account, the conversation and the
// message's ts, which no other event of that account shares. The key is also the event's id on the wire.
export const slackEventKey = (account: SlackAccount, frame: Pick<SlackMessageFrame, 'channel' | 'ts'>): string =>
  `${slackAccountId(account)}/${frame.channel}/${frame.ts}`

// The longest event id the extension admits: far longer than any real key (an account id, a channel id and a ts come
// to about 50 characters), and short enough that the ack naming it always fits a native message (framing.ts
// HOST_MESSAGE_MAX_BYTES).
export const SLACK_EVENT_ID_MAX_LENGTH = 1024

// An event the extension holds until the app acknowledges it, which the app does only once it has committed it.
export const SlackEventSchema = z
  .strictObject({
    type: z.literal('event'),
    id: z.string().max(SLACK_EVENT_ID_MAX_LENGTH),
    account: SlackAccountSchema,
    frame: SlackMessageFrameSchema,
  })
  .refine((event) => event.id === slackEventKey(event.account, event.frame), {
    message: "An event's id must be its dedupe key",
    path: ['id'],
  })

export type SlackEvent = z.infer<typeof SlackEventSchema>

const TabIdSchema = z.number().int()

// Who an open Slack tab is signed in as, and how its capture stands. The two are reported apart: a tab can be signed in
// while its capture is detached or failed, and that is a capture problem, not a sign-in one.
export const SlackIdentitySchema = SlackAccountSchema.extend({
  tabId: TabIdSchema,
  teamName: z.string(),
})

// A tab's capture. detached: no observer reports in it (a tab opened before the extension loaded, or one whose page
// runs an older build's observer, which answers only its first relay; either captures once it reloads). attached: its
// observer reports, and isSocketOpen says whether it sees Slack's socket open. failed: what the tab's capture produced
// did not read (a frame whose fields Slack moved, or its relay's answer), so its messages may be lost until it reloads
// or the extension does; error says what did not read.
export const CaptureHealthSchema = z.discriminatedUnion('state', [
  z.strictObject({ tabId: TabIdSchema, state: z.literal('detached') }),
  z.strictObject({ tabId: TabIdSchema, state: z.literal('attached'), isSocketOpen: z.boolean() }),
  z.strictObject({ tabId: TabIdSchema, state: z.literal('failed'), error: z.string().min(1) }),
])

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

export const SlackStatusSchema = z.strictObject({
  type: z.literal('status'),
  identities: z.array(SlackIdentitySchema),
  captures: z.array(CaptureHealthSchema),
  queue: QueueHealthSchema,
})

export type SlackIdentity = z.infer<typeof SlackIdentitySchema>
export type CaptureHealth = z.infer<typeof CaptureHealthSchema>
export type QueueHealth = z.infer<typeof QueueHealthSchema>
export type SlackStatus = z.infer<typeof SlackStatusSchema>

// The Web API methods a Slack tab will call for the app. Reads change nothing anyone sees; writes do, so the app sends
// them only through its provenance ledger. Uploads have their own methods below.
export const SLACK_READ_METHODS = [
  'auth.test',
  'chat.getPermalink',
  'conversations.history',
  'conversations.info',
  'conversations.list',
  'conversations.open',
  'conversations.replies',
  'emoji.list',
  'search.messages',
  'users.info',
  'users.list',
] as const

export const SLACK_WRITE_METHODS = ['chat.postMessage', 'chat.update', 'reactions.add', 'reactions.remove'] as const

export const SlackMethodSchema = z.enum([...SLACK_READ_METHODS, ...SLACK_WRITE_METHODS])

export type SlackMethod = z.infer<typeof SlackMethodSchema>
export type SlackReadMethod = (typeof SLACK_READ_METHODS)[number]
export type SlackWriteMethod = (typeof SLACK_WRITE_METHODS)[number]

// The error an answer carries when no open tab is signed in as the account: the extension sent nothing to Slack.
export const NO_SLACK_TAB_ERROR = 'misha_no_slack_tab'

// Slack's own answer, as its Web API sent it: ok with the method's fields, or not ok with Slack's error code (or
// NO_SLACK_TAB_ERROR, when the extension sent nothing). The extension passes it on as it is and draws no conclusion:
// some of Slack's errors come after part of a write took effect, so only the app, which knows the method, tells from
// the code whether a write happened. A reply error means no answer came at all.
export const SlackAnswerSchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() })

export type SlackAnswer = z.infer<typeof SlackAnswerSchema>

// Files cross native messaging in chunks of this many bytes, base64 in a frame, which keeps every frame the app sends
// under HOST_MESSAGE_MAX_BYTES with room for the envelope.
export const FILE_CHUNK_BYTES = 512 * 1024
const BASE64_CHUNK_MAX = Math.ceil(FILE_CHUNK_BYTES / 3) * 4

export const chunkCount = (byteLength: number): number => Math.ceil(byteLength / FILE_CHUNK_BYTES)

// The bytes chunk index covers in a file of byteLength bytes: start inclusive, end exclusive.
export const chunkRange = (index: number, byteLength: number): { readonly start: number; readonly end: number } => {
  if (!Number.isInteger(index) || index < 0 || index >= chunkCount(byteLength)) {
    throw new RangeError(`A file of ${byteLength} bytes has no chunk ${index}`)
  }

  const start = index * FILE_CHUNK_BYTES

  return { start, end: Math.min(start + FILE_CHUNK_BYTES, byteLength) }
}

const ChunkIndexSchema = z.number().int().nonnegative()
const ChunkDataSchema = z.base64().max(BASE64_CHUNK_MAX)
const TransferIdSchema = z.uuid()

// A prepared upload: Slack gave the file its id and holds the bytes, and nobody sees the file until a completion shares
// it. Not ok means Slack refused the upload URL, the bytes did not reach it, or the chunks did not add up; either way
// nothing was shared.
export const PreparedUploadSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileId: z.string().min(1) }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1) }),
])

export type PreparedUpload = z.infer<typeof PreparedUploadSchema>

// The bridge methods of a Slack tab, each with its params and its result. Downloads are pulled chunk by chunk after
// slackDownload fetched the file. An upload takes two steps, so the app can record the file's id before anything is
// shared: the app pushes the bytes chunk by chunk under an id it chose, slackUploadPrepare asks Slack for an upload URL
// and sends them (files.getUploadURLExternal, then the raw POST) and answers the file's id, and slackUploadFinish shares
// exactly that file (files.completeUploadExternal), with the optional comment Slack posts with it, answering Slack's
// completion answer as it is.
export const SLACK_BRIDGE_METHODS = {
  slackCall: {
    params: z.strictObject({
      account: SlackAccountSchema,
      method: SlackMethodSchema,
      params: z.record(z.string(), z.string()),
    }),
    result: SlackAnswerSchema,
  },
  slackDownload: {
    params: z.strictObject({
      account: SlackAccountSchema,
      url: z.url({ protocol: FILE_URL_PROTOCOL, hostname: FILE_URL_HOSTNAME }),
    }),
    result: z.strictObject({ downloadId: TransferIdSchema, byteLength: z.number().int().nonnegative() }),
  },
  slackDownloadChunk: {
    params: z.strictObject({ downloadId: TransferIdSchema, index: ChunkIndexSchema }),
    result: z.strictObject({ data: ChunkDataSchema }),
  },
  slackUploadChunk: {
    params: z.strictObject({ uploadId: TransferIdSchema, index: ChunkIndexSchema, data: ChunkDataSchema }),
    result: z.strictObject({}),
  },
  slackUploadPrepare: {
    params: z.strictObject({
      account: SlackAccountSchema,
      uploadId: TransferIdSchema,
      filename: z.string().min(1),
      byteLength: z.number().int().positive(),
    }),
    result: PreparedUploadSchema,
  },
  slackUploadFinish: {
    params: z.strictObject({
      account: SlackAccountSchema,
      fileId: z.string().min(1),
      title: z.string().min(1),
      channel: z.string().min(1),
      threadTs: SlackTsSchema.nullable(),
      initialComment: z.string().min(1).nullable(),
    }),
    result: SlackAnswerSchema,
  },
} as const

export type SlackBridgeMethod = keyof typeof SLACK_BRIDGE_METHODS
export type SlackBridgeParams<TMethod extends SlackBridgeMethod> = z.infer<
  (typeof SLACK_BRIDGE_METHODS)[TMethod]['params']
>
export type SlackBridgeResult<TMethod extends SlackBridgeMethod> = z.infer<
  (typeof SLACK_BRIDGE_METHODS)[TMethod]['result']
>
