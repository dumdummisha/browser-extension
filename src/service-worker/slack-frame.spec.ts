import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SlackEventSchema } from '../protocol/slack.js'
import { newMessageOf, SlackFrameError, slackEventOf } from './slack-frame.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }

// What Slack's socket might send for a message: the fields the app reads, plus what it does not.
const SOCKET_MESSAGE = {
  type: 'message',
  channel: 'C0EXAMPLE1',
  user: 'U0EXAMPLE2',
  text: 'Can someone look at the build?',
  ts: '1700000000.000100',
  client_msg_id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
  team: 'T0EXAMPLE1',
  blocks: [{ type: 'rich_text', block_id: 'b1', elements: [] }],
  user_profile: { display_name: 'Example Person', image_72: 'https://avatars.example.org/u2.png' },
}

const toEvent = (frame: unknown): unknown => {
  const message = newMessageOf(frame)

  return message === null ? null : slackEventOf(ACCOUNT, message)
}

describe('[service-worker] Slack frames - new messages', () => {
  it('should make an event keyed by its dedupe key, with only the fields the app reads', () => {
    // Act
    const event = toEvent(SOCKET_MESSAGE)

    // Assert
    assert.deepEqual(event, {
      type: 'event',
      id: 'slack:T0EXAMPLE1:U0EXAMPLE1/C0EXAMPLE1/1700000000.000100',
      account: ACCOUNT,
      frame: {
        type: 'message',
        channel: 'C0EXAMPLE1',
        user: 'U0EXAMPLE2',
        text: 'Can someone look at the build?',
        ts: '1700000000.000100',
        client_msg_id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      },
    })
    assert.equal(SlackEventSchema.safeParse(event).success, true)
  })

  it('should keep a thread broadcast with its thread, and a shared file by its id alone', () => {
    // Arrange
    const broadcast = {
      ...SOCKET_MESSAGE,
      subtype: 'thread_broadcast',
      ts: '1700000000.000300',
      thread_ts: '1700000000.000100',
      parent_user_id: 'U0EXAMPLE1',
    }
    const fileShare = {
      type: 'message',
      subtype: 'file_share',
      channel: 'D0EXAMPLE1',
      channel_type: 'im',
      user: 'U0EXAMPLE2',
      text: '',
      ts: '1700000000.000400',
      files: [{ id: 'F0EXAMPLE1', name: 'chart.png', url_private: 'https://files.slack.com/files-pri/x/chart.png' }],
    }

    // Act
    const events = [broadcast, fileShare].map((frame) => newMessageOf(frame))

    // Assert
    assert.deepEqual(events, [
      {
        type: 'message',
        subtype: 'thread_broadcast',
        channel: 'C0EXAMPLE1',
        user: 'U0EXAMPLE2',
        text: 'Can someone look at the build?',
        ts: '1700000000.000300',
        client_msg_id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
        thread_ts: '1700000000.000100',
        parent_user_id: 'U0EXAMPLE1',
      },
      {
        type: 'message',
        subtype: 'file_share',
        channel: 'D0EXAMPLE1',
        channel_type: 'im',
        user: 'U0EXAMPLE2',
        text: '',
        ts: '1700000000.000400',
        files: [{ id: 'F0EXAMPLE1' }],
      },
    ])
  })

  it('should keep a bot post, which carries a bot id instead of a user', () => {
    // Arrange
    const { user: _user, ...withoutUser } = SOCKET_MESSAGE
    const botPost = { ...withoutUser, bot_id: 'B0EXAMPLE1', app_id: 'A0EXAMPLE1' }

    // Act
    const message = newMessageOf(botPost)

    // Assert
    assert.deepEqual(message, {
      type: 'message',
      channel: 'C0EXAMPLE1',
      bot_id: 'B0EXAMPLE1',
      app_id: 'A0EXAMPLE1',
      text: 'Can someone look at the build?',
      ts: '1700000000.000100',
      client_msg_id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
    })
  })
})

describe('[service-worker] Slack frames - everything else', () => {
  it('should leave edits, deletions and frames that are not messages alone', () => {
    // Arrange
    const frames = [
      { type: 'message', subtype: 'message_changed', channel: 'C0EXAMPLE1', ts: '1700000000.000500' },
      { type: 'message', subtype: 'message_deleted', channel: 'C0EXAMPLE1', ts: '1700000000.000600' },
      { type: 'message', subtype: 'channel_join', channel: 'C0EXAMPLE1', ts: '1700000000.000700', text: 'joined' },
      { type: 'user_typing', channel: 'C0EXAMPLE1', user: 'U0EXAMPLE2' },
      { type: 'presence_change', presence: 'active', user: 'U0EXAMPLE2' },
      { type: 'pong', reply_to: 3 },
      'hello',
      null,
    ]

    // Act
    const messages = frames.map((frame) => newMessageOf(frame))

    // Assert
    assert.deepEqual(
      messages,
      frames.map(() => null)
    )
  })

  it('should refuse a new message whose fields do not read, rather than skip it', () => {
    // Arrange
    const { ts: _ts, ...withoutTs } = SOCKET_MESSAGE
    const unreadable = [withoutTs, { ...SOCKET_MESSAGE, text: 7 }, { ...SOCKET_MESSAGE, files: [{ name: 'a.png' }] }]

    // Act + Assert
    for (const frame of unreadable) {
      assert.throws(() => newMessageOf(frame), SlackFrameError)
    }
  })
})
