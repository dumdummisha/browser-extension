import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClientMessageSchema, ExtensionFrameSchema, HostFrameSchema, RelayMessageSchema } from './messages.js'
import { slackEventKey } from './slack.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const FRAME = { type: 'message', channel: 'D0EXAMPLE1', ts: '1700000000.000100', text: 'hello' } as const
const EVENT = { type: 'event', id: slackEventKey(ACCOUNT, FRAME), account: ACCOUNT, frame: FRAME } as const

describe('[protocol] Wire messages', () => {
  it('should take requests, listen and acks from a client', () => {
    // Arrange
    const messages = [
      { type: 'request', id: 7, method: 'slackCall', params: {} },
      { type: 'listen' },
      { type: 'ack', id: EVENT.id },
    ]

    // Act
    const parsed = messages.map((message) => ClientMessageSchema.parse(message))

    // Assert
    assert.deepEqual(parsed, messages)
  })

  it('should tell a reply with a result from a reply with an error', () => {
    // Act
    const result = RelayMessageSchema.parse({ type: 'reply', id: 3, result: { ok: true } })
    const failure = RelayMessageSchema.parse({ type: 'reply', id: 4, error: 'Tab 12 closed' })

    // Assert
    assert.deepEqual(result, { type: 'reply', id: 3, result: { ok: true } })
    assert.deepEqual(failure, { type: 'reply', id: 4, error: 'Tab 12 closed' })
  })

  it('should carry events only from the extension, never to it', () => {
    // Act
    const fromExtension = ExtensionFrameSchema.safeParse(EVENT)
    const toExtension = HostFrameSchema.safeParse(EVENT)

    // Assert
    assert.equal(fromExtension.success, true)
    assert.equal(toExtension.success, false)
  })
})
