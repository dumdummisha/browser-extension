// The new messages the extension forwards, and the fields of one the app reads (desktop inbound.ts), under Slack's
// own names. slack.ts builds its message schemas from these. They live apart from it, without zod, so the extension's
// observer can cut a frame down to them inside Slack's page, before anything of it leaves.

// Routing takes only a new message: one with no subtype, or with one of these. An edit (message_changed) or a deletion
// is never forwarded, so it never becomes a command.
export const NEW_MESSAGE_SUBTYPES = ['thread_broadcast', 'file_share'] as const

// Every field but files, of which only each file's id is kept. channel_type is often missing from the socket's frames,
// and the app resolves it.
export const MESSAGE_FIELDS = [
  'type',
  'subtype',
  'channel',
  'channel_type',
  'ts',
  'user',
  'bot_id',
  'app_id',
  'client_msg_id',
  'text',
  'thread_ts',
  'parent_user_id',
] as const

export type MessageField = (typeof MESSAGE_FIELDS)[number]
