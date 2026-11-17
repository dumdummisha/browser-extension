import { z } from 'zod'

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

// A message event from Slack's socket, as the page received it. Only what the dedupe key needs is read here; the app
// parses the rest, and nothing in it ever becomes a command to the extension.
export const SlackMessageFrameSchema = z.looseObject({
  type: z.literal('message'),
  channel: z.string().min(1),
  ts: SlackTsSchema,
})

export type SlackMessageFrame = z.infer<typeof SlackMessageFrameSchema>

// Two tabs signed in as one account see the same message: its key is the account, the conversation and the
// message's ts, which no other event of that account shares. The key is also the event's id on the wire.
export const slackEventKey = (account: SlackAccount, frame: Pick<SlackMessageFrame, 'channel' | 'ts'>): string =>
  `${slackAccountId(account)}/${frame.channel}/${frame.ts}`

// An event the extension holds until the app acknowledges it, which the app does only once it has committed it.
export const SlackEventSchema = z
  .strictObject({
    type: z.literal('event'),
    id: z.string(),
    account: SlackAccountSchema,
    frame: SlackMessageFrameSchema,
  })
  .refine((event) => event.id === slackEventKey(event.account, event.frame), {
    message: "An event's id must be its dedupe key",
    path: ['id'],
  })

export type SlackEvent = z.infer<typeof SlackEventSchema>

// Who an open Slack tab is signed in as, and whether its observer sees Slack's socket. The two are reported apart: a
// tab can be signed in while its observer is detached (a reload, a socket Slack moved), and that is a capture
// problem, not a sign-in one. droppedEvents counts the events the full pending queue had no room for since the
// extension started.
export const SlackIdentitySchema = SlackAccountSchema.extend({
  tabId: z.number().int(),
  teamName: z.string(),
})

export const CaptureHealthSchema = z.strictObject({
  tabId: z.number().int(),
  isObserverAttached: z.boolean(),
  isSocketOpen: z.boolean(),
})

export const SlackStatusSchema = z.strictObject({
  type: z.literal('status'),
  identities: z.array(SlackIdentitySchema),
  captures: z.array(CaptureHealthSchema),
  droppedEvents: z.number().int().nonnegative(),
})

export type SlackIdentity = z.infer<typeof SlackIdentitySchema>
export type CaptureHealth = z.infer<typeof CaptureHealthSchema>
export type SlackStatus = z.infer<typeof SlackStatusSchema>

// The Web API methods a Slack tab will call for the app. Reads change nothing anyone sees; writes do, so the app sends
// them only through its provenance ledger. Uploads have their own methods below.
export const SLACK_READ_METHODS = [
  'auth.test',
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
// NO_SLACK_TAB_ERROR). An answer means Slack said so; a reply error instead means the outcome is unknown, so a write
// that got one may have happened.
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

// An upload is shared once Slack completed it: the file's id is its receipt. Not ok means Slack refused a step, or the
// chunks did not add up, and nothing was shared.
export const UploadAnswerSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), fileId: z.string().min(1) }),
  z.strictObject({ ok: z.literal(false), error: z.string().min(1) }),
])

export type UploadAnswer = z.infer<typeof UploadAnswerSchema>

// The bridge methods of a Slack tab, each with its params and its result. Downloads are pulled chunk by chunk after
// slackDownload fetched the file; uploads are pushed chunk by chunk under an id the app chose, then slackUploadFinish
// runs Slack's upload flow (an upload URL, the bytes, the completion that shares the file) for that one file.
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
  slackUploadFinish: {
    params: z.strictObject({
      account: SlackAccountSchema,
      uploadId: TransferIdSchema,
      filename: z.string().min(1),
      byteLength: z.number().int().positive(),
      channel: z.string().min(1),
      threadTs: SlackTsSchema.nullable(),
    }),
    result: UploadAnswerSchema,
  },
} as const

export type SlackBridgeMethod = keyof typeof SLACK_BRIDGE_METHODS
export type SlackBridgeParams<TMethod extends SlackBridgeMethod> = z.infer<
  (typeof SLACK_BRIDGE_METHODS)[TMethod]['params']
>
export type SlackBridgeResult<TMethod extends SlackBridgeMethod> = z.infer<
  (typeof SLACK_BRIDGE_METHODS)[TMethod]['result']
>
