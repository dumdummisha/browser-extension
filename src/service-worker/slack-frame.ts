import { z } from 'zod'
import {
  NEW_MESSAGE_SUBTYPES,
  type SlackAccount,
  type SlackEvent,
  slackEventKey,
  type SlackMessageFrame,
  SocketMessageSchema,
} from '../protocol/slack.js'

export class SlackFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackFrameError'
  }
}

const NEW_MESSAGE_SUBTYPE_SET: ReadonlySet<unknown> = new Set(NEW_MESSAGE_SUBTYPES)

// The new message a frame of Slack's socket carries, with only the fields the app reads; null for every other frame
// (presence, typing, an edit, a deletion), which is not the app's. A new message whose fields do not read throws: the
// socket's shape moved, and skipping it would lose the message without a word.
export const newMessageOf = (frame: unknown): SlackMessageFrame | null => {
  const isNewMessage =
    typeof frame === 'object' &&
    frame !== null &&
    'type' in frame &&
    frame.type === 'message' &&
    (!('subtype' in frame) || NEW_MESSAGE_SUBTYPE_SET.has(frame.subtype))
  if (!isNewMessage) {
    return null
  }

  const message = SocketMessageSchema.safeParse(frame)
  if (!message.success) {
    throw new SlackFrameError(`A new message from Slack's socket does not read:\n${z.prettifyError(message.error)}`)
  }

  return message.data
}

// The event a new message makes for the account its tab is signed in as, keyed by its dedupe key.
export const slackEventOf = (account: SlackAccount, message: SlackMessageFrame): SlackEvent => ({
  type: 'event',
  id: slackEventKey(account, message),
  account,
  frame: message,
})
