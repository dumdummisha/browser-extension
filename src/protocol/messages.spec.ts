import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ClientMessageSchema, ExtensionFrameSchema, HostFrameSchema, RelayMessageSchema } from './messages.js'
import { slackEventKey } from './slack.js'
import { whatsappEventKey } from './whatsapp.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const FRAME = { type: 'message', channel: 'D0EXAMPLE1', ts: '1700000000.000100', text: 'hello' } as const
const EVENT = { type: 'event', id: slackEventKey(ACCOUNT, FRAME), account: ACCOUNT, frame: FRAME } as const
// A caller's deadline that has not passed (2100-01-01).
const DEADLINE = 4_102_444_800_000

const LEO_NOVAK = { wid: '100000000000001@lid' }

const WHATSAPP_MESSAGE = {
  chat: '100000000000002@lid',
  id: '3EB0A1B2C3D4E5F60718',
  timestamp: 1_700_000_000,
  fromMe: false,
  type: 'chat',
  text: 'Lunch at noon?',
} as const

const WHATSAPP_EVENT = {
  type: 'event',
  id: whatsappEventKey(LEO_NOVAK, WHATSAPP_MESSAGE),
  account: LEO_NOVAK,
  message: WHATSAPP_MESSAGE,
} as const

describe('[protocol] Wire messages', () => {
  it('should take requests, cancels, listen and acks from a client', () => {
    // Arrange
    const messages = [
      { type: 'request', id: 7, method: 'slackCall', params: {}, deadline: DEADLINE },
      { type: 'cancel', id: 7 },
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

  it('should read a WhatsApp event and a status with a WhatsApp tab from the extension, and refuse a WhatsApp event from a client', () => {
    // Arrange
    const status = {
      type: 'status',
      identities: [],
      captures: [],
      queue: { state: 'committing', droppedEvents: 0 },
      parity: [],
      whatsapp: [{ tabId: 41, state: 'ready', account: LEO_NOVAK, isConnected: true, hasSynced: true }],
    }

    // Act
    const parsed = [
      ExtensionFrameSchema.safeParse(WHATSAPP_EVENT).success,
      ExtensionFrameSchema.safeParse(status).success,
      ClientMessageSchema.safeParse(WHATSAPP_EVENT).success,
    ]

    // Assert
    assert.deepEqual(parsed, [true, true, false])
  })

  it('should refuse a request with no deadline, and pass requests and cancels on to the extension', () => {
    // Arrange
    const request = { type: 'request', id: 7, method: 'slackCall', params: {}, deadline: DEADLINE }

    // Act
    const parsed = [
      ClientMessageSchema.safeParse({ type: 'request', id: 7, method: 'slackCall', params: {} }).success,
      HostFrameSchema.safeParse(request).success,
      HostFrameSchema.safeParse({ type: 'cancel', id: 7 }).success,
    ]

    // Assert
    assert.deepEqual(parsed, [false, true, true])
  })
})
