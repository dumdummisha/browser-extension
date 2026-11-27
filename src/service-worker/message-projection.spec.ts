import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SlackMessageFrameSchema } from '../protocol/slack.js'
import { projectedMessageOf } from './message-projection.js'

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

const PROJECTED_MESSAGE = {
  type: 'message',
  channel: 'C0EXAMPLE1',
  user: 'U0EXAMPLE2',
  text: 'Can someone look at the build?',
  ts: '1700000000.000100',
  client_msg_id: '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
}

// What crosses the observer's port for a socket frame, which a structured clone makes a plain object of.
const projected = (frame: unknown): unknown => structuredClone(projectedMessageOf(JSON.stringify(frame)))

describe('[service-worker] Message projection - new messages', () => {
  it('should keep only the fields the app reads, as a frame the relay accepts', () => {
    // Act
    const message = projected(SOCKET_MESSAGE)

    // Assert
    assert.deepEqual(message, PROJECTED_MESSAGE)
    assert.equal(SlackMessageFrameSchema.safeParse(message).success, true)
  })

  it('should keep a thread broadcast with its thread, and a shared file by its id alone', () => {
    // Arrange
    const broadcast = {
      ...SOCKET_MESSAGE,
      subtype: 'thread_broadcast',
      thread_ts: '1700000000.000050',
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
    const messages = [broadcast, fileShare].map(projected)

    // Assert
    assert.deepEqual(messages, [
      {
        ...PROJECTED_MESSAGE,
        subtype: 'thread_broadcast',
        thread_ts: '1700000000.000050',
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
    const { user: _projectedUser, ...projectedWithoutUser } = PROJECTED_MESSAGE

    // Act
    const message = projected({ ...withoutUser, bot_id: 'B0EXAMPLE1', app_id: 'A0EXAMPLE1' })

    // Assert
    assert.deepEqual(message, { ...projectedWithoutUser, bot_id: 'B0EXAMPLE1', app_id: 'A0EXAMPLE1' })
  })

  it('should pass on a new message whose fields Slack moved, nested values as null, for the relay to refuse', () => {
    // Arrange
    const { ts: _ts, ...withoutTs } = SOCKET_MESSAGE

    const moved = [
      withoutTs,
      { ...SOCKET_MESSAGE, text: { token: 'xoxc-0000-example' } },
      { ...SOCKET_MESSAGE, files: [{ name: 'a.png' }] },
    ]

    // Act
    const messages = moved.map(projected)

    // Assert
    const { ts: _projectedTs, ...projectedWithoutTs } = PROJECTED_MESSAGE

    assert.deepEqual(messages, [
      projectedWithoutTs,
      { ...PROJECTED_MESSAGE, text: null },
      { ...PROJECTED_MESSAGE, files: [{ id: undefined }] },
    ])

    assert.deepEqual(
      messages.map((message) => SlackMessageFrameSchema.safeParse(message).success),
      [false, false, false]
    )
  })

  it('should copy nothing a page script put on Object.prototype', (context) => {
    // Arrange
    const polluted = { subtype: 'message_changed', thread_ts: '1700000000.000099', bot_id: 'B0PAGE', files: [] }
    Object.assign(Object.prototype, polluted)

    context.after(() => {
      for (const field of Object.keys(polluted)) {
        Reflect.deleteProperty(Object.prototype, field)
      }
    })

    // Act
    const message = projected(SOCKET_MESSAGE)

    // Assert
    assert.deepEqual(message, PROJECTED_MESSAGE)
  })
})

describe('[service-worker] Message projection - everything else', () => {
  it('should leave edits, deletions and frames that are not messages alone', () => {
    // Arrange
    const frames = [
      { type: 'message', subtype: 'message_changed', channel: 'C0EXAMPLE1', ts: '1700000000.000500' },
      { type: 'message', subtype: 'message_deleted', channel: 'C0EXAMPLE1', ts: '1700000000.000600' },
      { type: 'message', subtype: 'channel_join', channel: 'C0EXAMPLE1', ts: '1700000000.000700', text: 'joined' },
      { type: 'user_typing', channel: 'C0EXAMPLE1', user: 'U0EXAMPLE2' },
      { type: 'presence_change', presence: 'active', user: 'U0EXAMPLE2' },
      { type: 'pong', reply_to: 3 },
      [{ type: 'message' }],
      'hello',
      null,
    ]

    // Act
    const messages = frames.map(projected)

    // Assert
    assert.deepEqual(
      messages,
      frames.map(() => null)
    )
  })
})
