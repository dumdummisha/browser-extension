import {
  type SlackAccount,
  type SlackEvent,
  slackEventKey,
  SlackEventSchema,
  type SlackMessageFrame,
} from '../protocol/slack.js'

// The event a new message makes for the account its tab is signed in as, keyed by its dedupe key. One whose id runs past
// SLACK_EVENT_ID_MAX_LENGTH throws, since the ack naming it could not reach the extension.
export const slackEventOf = (account: SlackAccount, message: SlackMessageFrame): SlackEvent =>
  SlackEventSchema.parse({ type: 'event', id: slackEventKey(account, message), account, frame: message })
