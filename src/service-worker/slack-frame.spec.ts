import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SLACK_EVENT_ID_MAX_LENGTH } from '../protocol/slack.js'
import { slackEventOf } from './slack-frame.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const MESSAGE = { type: 'message', channel: 'C0EXAMPLE1', ts: '1700000000.000100', text: 'hello' } as const

describe('[service-worker] Slack frames - events', () => {
  it('should make an event keyed by its dedupe key, for the account its document showed and still shows', () => {
    // Act
    const event = slackEventOf(ACCOUNT, ACCOUNT, MESSAGE)

    // Assert
    assert.deepEqual(event, {
      type: 'event',
      id: 'slack:T0EXAMPLE1:U0EXAMPLE1/C0EXAMPLE1/1700000000.000100',
      account: ACCOUNT,
      frame: MESSAGE,
    })
  })

  it('should make no event once the document is signed in as another user or workspace, or as nobody', () => {
    // Arrange
    const signedInNow = [
      { teamId: ACCOUNT.teamId, userId: 'U0EXAMPLE2' },
      { teamId: 'T0EXAMPLE2', userId: ACCOUNT.userId },
      null,
    ]

    // Act
    const events = signedInNow.map((signedIn) => slackEventOf(ACCOUNT, signedIn, MESSAGE))

    // Assert
    assert.deepEqual(events, [null, null, null])
  })

  it('should refuse to make an event whose id runs past the limit, so its ack always fits', () => {
    // Arrange
    const message = { ...MESSAGE, channel: `C${'0'.repeat(SLACK_EVENT_ID_MAX_LENGTH)}` }

    // Act + Assert
    assert.throws(
      () => slackEventOf(ACCOUNT, ACCOUNT, message),
      new RegExp(`<=${SLACK_EVENT_ID_MAX_LENGTH} characters`, 'u')
    )
  })
})
