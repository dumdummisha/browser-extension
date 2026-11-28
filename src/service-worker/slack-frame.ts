import {
  type SlackAccount,
  type SlackEvent,
  slackEventKey,
  SlackEventSchema,
  type SlackMessageFrame,
} from '../protocol/slack.js'

// The event a new message makes, keyed by its dedupe key under the account its document showed when the message came
// (captured), and only while that document is still signed in as that account (signedIn, null when it shows none). Any
// other account makes none: keying the message by the account the document shows now would give it to an account it
// did not come to. One whose id runs past EVENT_ID_MAX_LENGTH (event-id.ts) throws, since the ack naming it could not
// reach the extension.
export const slackEventOf = (
  captured: SlackAccount,
  signedIn: SlackAccount | null,
  message: SlackMessageFrame
): SlackEvent | null => {
  if (signedIn?.teamId !== captured.teamId || signedIn.userId !== captured.userId) {
    return null
  }

  return SlackEventSchema.parse({
    type: 'event',
    id: slackEventKey(captured, message),
    account: captured,
    frame: message,
  })
}
