import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EVENT_ID_MAX_LENGTH } from './event-id.js'
import {
  DirectChatWidSchema,
  parseWhatsAppAccountId,
  WHATSAPP_BRIDGE_METHODS,
  WHATSAPP_HISTORY_COUNT_MAX,
  whatsappAccountId,
  whatsappEventKey,
  WhatsAppEventSchema,
  WhatsAppMessageIdSchema,
  WhatsAppMessageSchema,
  WhatsAppTabStatusSchema,
} from './whatsapp.js'

// Leo Novak's account, and his chats with Emma Lee (lid) and Max Becker (phone-number wid). Every wid is made up.
const ACCOUNT = { wid: '100000000000001@lid' }
const EMMA_LEE = '100000000000002@lid'
const MAX_BECKER = '100000000000003@c.us'
const MESSAGE_ID = '3EB0A1B2C3D4E5F60718'
const TOKEN = '5b0d7e3a-9c41-4f2e-8a6b-1d2c3e4f5a6b'

const MESSAGE = {
  chat: EMMA_LEE,
  id: MESSAGE_ID,
  timestamp: 1_700_000_000,
  fromMe: false,
  type: 'chat',
  text: 'See you at ten',
}

describe('[protocol] WhatsApp accounts and events', () => {
  it("should key an event by the account, the chat and the message's own id, so two tabs give one id", () => {
    // Act
    const first = whatsappEventKey(ACCOUNT, MESSAGE)
    const again = whatsappEventKey({ ...ACCOUNT }, { chat: EMMA_LEE, id: MESSAGE_ID })
    const next = whatsappEventKey(ACCOUNT, { ...MESSAGE, id: '3EB0A1B2C3D4E5F60719' })

    // Assert
    assert.equal(first, 'whatsapp:100000000000001@lid/100000000000002@lid/3EB0A1B2C3D4E5F60718')
    assert.equal(again, first)
    assert.notEqual(next, first)
  })

  it('should accept an event whose id is its key and refuse any other id', () => {
    // Arrange
    const event = { type: 'event', id: whatsappEventKey(ACCOUNT, MESSAGE), account: ACCOUNT, message: MESSAGE }

    // Act
    const accepted = WhatsAppEventSchema.safeParse(event)
    const refused = WhatsAppEventSchema.safeParse({ ...event, id: `${event.id}0` })

    // Assert
    assert.equal(accepted.success, true)
    assert.equal(refused.success, false)
  })

  it('should read an account id back, and refuse one that is not whatsapp:<digits>@lid', () => {
    // Act
    const accountId = whatsappAccountId(ACCOUNT)

    // Assert
    assert.equal(accountId, 'whatsapp:100000000000001@lid')
    assert.deepEqual(parseWhatsAppAccountId(accountId), ACCOUNT)
    assert.throws(() => parseWhatsAppAccountId('whatsapp:100000000000004@c.us'), /is not a WhatsApp account id/u)
    assert.throws(() => parseWhatsAppAccountId('whatsapp:120363000000000001@g.us'), /is not a WhatsApp account id/u)
    assert.throws(() => parseWhatsAppAccountId('slack:T0EXAMPLE1:U0EXAMPLE1'), /is not a WhatsApp account id/u)
  })

  it("should take a direct chat's lid or phone-number wid and refuse a group's, a broadcast's or a newsletter's", () => {
    // Arrange
    const wids = [EMMA_LEE, MAX_BECKER, '120363000000000001@g.us', 'status@broadcast', '120363000000000002@newsletter']

    // Act
    const taken = wids.map((wid) => DirectChatWidSchema.safeParse(wid).success)

    // Assert
    assert.deepEqual(taken, [true, true, false, false, false])
  })

  it("should take a message id of upper-case letters, digits and '-', and refuse one with a lower-case letter, '/', '_', or longer than an event id", () => {
    // Arrange
    const ids = [
      MESSAGE_ID,
      '1700000000-0001',
      '3EB0a1B2C3D4E5F60718',
      '3EB0/A1B2C3D4E5F6',
      '3EB0_A1B2C3D4E5F6',
      'A'.repeat(EVENT_ID_MAX_LENGTH + 1),
    ]

    // Act
    const taken = ids.map((id) => WhatsAppMessageIdSchema.safeParse(id).success)

    // Assert
    assert.deepEqual(taken, [true, true, false, false, false, false])
  })

  it('should refuse a message type outside the reported ones', () => {
    // Arrange
    const types = ['chat', 'image', 'video', 'document', 'audio', 'ptt', 'sticker']
    const unreported = ['album', 'interactive', 'call_log', 'ciphertext', 'protocol']

    // Act
    const reported = types.map((type) => WhatsAppMessageSchema.safeParse({ ...MESSAGE, type }).success)
    const refused = unreported.map((type) => WhatsAppMessageSchema.safeParse({ ...MESSAGE, type }).success)

    // Assert
    assert.deepEqual(reported, [true, true, true, true, true, true, true])
    assert.deepEqual(refused, [false, false, false, false, false])
  })

  it('should read every tab state with its tab id, and refuse a ready tab without an account', () => {
    // Arrange
    const states = [
      { tabId: 7, state: 'detached' },
      { tabId: 7, state: 'failed', error: 'The observer sent a message that does not read' },
      { tabId: 7, state: 'loading' },
      { tabId: 7, state: 'signed-out' },
      { tabId: 7, state: 'ready', account: ACCOUNT, isConnected: true, hasSynced: true },
      { tabId: 7, state: 'broken', drift: 'clock' },
    ]

    // Act
    const read = states.map((status) => WhatsAppTabStatusSchema.safeParse(status).success)
    const withoutTab = WhatsAppTabStatusSchema.safeParse({ state: 'loading' })
    const withoutAccount = WhatsAppTabStatusSchema.safeParse({
      tabId: 7,
      state: 'ready',
      isConnected: true,
      hasSynced: true,
    })

    // Assert
    assert.deepEqual(read, [true, true, true, true, true, true])
    assert.equal(withoutTab.success, false)
    assert.equal(withoutAccount.success, false)
  })
})

describe('[protocol] WhatsApp bridge methods', () => {
  it('should refuse a history count below 1 or above WHATSAPP_HISTORY_COUNT_MAX, and an anchor without fromMe', () => {
    // Arrange
    const read = {
      account: ACCOUNT,
      chat: EMMA_LEE,
      anchor: { direction: 'before', messageId: MESSAGE_ID, fromMe: true },
    }
    const history = (params: object): boolean =>
      WHATSAPP_BRIDGE_METHODS.whatsappHistory.params.safeParse(params).success

    // Act
    const taken = [
      history({ ...read, count: 1 }),
      history({ ...read, count: WHATSAPP_HISTORY_COUNT_MAX }),
      history({ ...read, anchor: null, count: 20 }),
    ]

    const refused = [
      history({ ...read, count: 0 }),
      history({ ...read, count: WHATSAPP_HISTORY_COUNT_MAX + 1 }),
      history({ ...read, anchor: { direction: 'before', messageId: MESSAGE_ID }, count: 20 }),
    ]

    // Assert
    assert.deepEqual(taken, [true, true, true])
    assert.deepEqual(refused, [false, false, false])
  })

  it('should refuse a refusal a method does not answer', () => {
    // Act
    const prepare = WHATSAPP_BRIDGE_METHODS.whatsappSendPrepare.result.safeParse({
      outcome: 'refused',
      refusal: 'unknown-message',
    })

    const commit = WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.result.safeParse({
      outcome: 'refused',
      refusal: 'unknown-message',
    })

    // Assert
    assert.equal(prepare.success, false)
    assert.equal(commit.success, true)
  })

  it("should take an unconfirmed commit only with one of the extension's own codes, and refuse any other string", () => {
    // Arrange
    const codes = ['send-rejected', 'result-rejected', 'result-not-ok', 'result-unreadable']
    const unconfirmed = (code: unknown): boolean =>
      WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.result.safeParse({ outcome: 'unconfirmed', code }).success

    // Act
    const taken = codes.map(unconfirmed)
    const refused = ['ERROR_UNKNOWN', 'OK', '', null].map(unconfirmed)

    // Assert
    assert.deepEqual(taken, [true, true, true, true])
    assert.deepEqual(refused, [false, false, false, false])
  })

  it('should refuse a prepared answer that carries a time, and a sent answer without one', () => {
    // Arrange
    const prepared = { outcome: 'prepared', messageId: MESSAGE_ID, token: TOKEN }

    // Act
    const preparedTaken = WHATSAPP_BRIDGE_METHODS.whatsappSendPrepare.result.safeParse(prepared)
    const preparedWithTime = WHATSAPP_BRIDGE_METHODS.whatsappSendPrepare.result.safeParse({
      ...prepared,
      timestamp: 1_700_000_000,
    })
    const sent = WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.result.safeParse({
      outcome: 'sent',
      timestamp: 1_700_000_000,
    })
    const sentWithoutTime = WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.result.safeParse({ outcome: 'sent' })

    // Assert
    assert.deepEqual(
      [preparedTaken.success, preparedWithTime.success, sent.success, sentWithoutTime.success],
      [true, false, true, false]
    )
  })

  it("should take a commit only with the observer's token, and a prepared answer only with one", () => {
    // Arrange
    const commit = { account: ACCOUNT, chat: EMMA_LEE, messageId: MESSAGE_ID, token: TOKEN }
    const prepared = { outcome: 'prepared', messageId: MESSAGE_ID, token: TOKEN }
    const commits = (params: object): boolean =>
      WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.params.safeParse(params).success

    const prepares = (result: object): boolean =>
      WHATSAPP_BRIDGE_METHODS.whatsappSendPrepare.result.safeParse(result).success

    // Act
    const taken = [commits(commit), prepares(prepared)]
    const refused = [
      commits({ ...commit, token: undefined }),
      commits({ ...commit, token: 'tab-7' }),
      prepares({ ...prepared, token: undefined }),
      prepares({ ...prepared, token: 'tab-7' }),
    ]

    // Assert
    assert.deepEqual(taken, [true, true])
    assert.deepEqual(refused, [false, false, false, false])
  })
})
