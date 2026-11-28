import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type WhatsAppBridgeMethod, type WhatsAppBridgeParams } from '../protocol/whatsapp.js'
import {
  type ICaptureHost,
  type IWhatsAppCapture,
  PREPARED_SEND_WINDOW_MS,
  whatsappCapture,
} from './whatsapp-capture.js'
import {
  type IPageChat,
  type IPageMessage,
  type IPageRow,
  type IPreparedText,
  type IRowKey,
  type IWhatsAppInternals,
  type PageSendResult,
  WhatsAppDriftError,
  type WhatsAppNeed,
} from './whatsapp-internals.js'

// Leo Novak is signed in; Emma Lee and Max Becker are people he writes with. Every wid, id and text is made up.
const LEO_NOVAK = '100000000000001@lid'
const EMMA_LEE = '100000000000002@lid'
const MAX_BECKER = '100000000000003@lid'
const GROUP = '120363000000000001@g.us'
const TOKEN = '5b0d7e3a-9c41-4f2e-8a6b-1d2c3e4f5a6b'
const COMMAND_ID = '0f6d2c1a-3b4e-4d5f-8a9b-0c1d2e3f4a5b'
const SENT_AT = 1_700_000_000
// request-pace.ts GAP_MIN_MS: the shortest gap the pace leaves between two prepares of one account.
const GAP_MIN_MS = 500
const NO_DEADLINE = Number.MAX_SAFE_INTEGER

type InternalsCall =
  | 'signedIn'
  | 'connection'
  | 'onMessage'
  | 'onConnectionChange'
  | 'chat'
  | 'prepareText'
  | 'stamp'
  | 'rowsAround'
  | 'contact'

interface IFakeInternals extends IWhatsAppInternals {
  readonly page: {
    lid: string | null
    hasPnUser: boolean
    isConnected: boolean
    hasSynced: boolean
    stampAt: number
    sendResult: PageSendResult
    newest: IPageRow | null | undefined
    duringBuild: () => void
  }
  readonly failing: Set<WhatsAppNeed>
  readonly throwing: Map<InternalsCall, Error>
  readonly rows: IPageRow[]
  readonly reads: { readonly direction: string; readonly key: IRowKey; readonly count: number }[]
  readonly sends: { readonly chat: IPageChat; readonly prepared: IPreparedText }[]
  readonly chats: Map<string, IPageChat>
  readonly emitMessage: (message: IPageMessage) => void
  readonly emitDrift: (drift: WhatsAppNeed) => void
  readonly changeConnection: () => void
  readonly isListening: () => boolean
}

interface IFakeHost extends ICaptureHost {
  readonly clock: { now: number }
  readonly timers: { readonly run: () => void; readonly ms: number }[]
  readonly cleared: number[]
}

const rowAt = (index: number, type = 'chat'): IPageRow => ({
  id: `ROW${index}`,
  fromMe: index % 2 === 0,
  type,
  timestamp: SENT_AT + index,
  text: `Message ${index}`,
})

// The page's internals as whatsapp-internals.ts answers them, over Emma Lee's chat of ten rows, 1 the oldest.
const fakeInternals = (): IFakeInternals => {
  const failing = new Set<WhatsAppNeed>()
  const throwing = new Map<InternalsCall, Error>()
  const rows = Array.from({ length: 10 }, (_, index) => rowAt(index + 1))
  const reads: IFakeInternals['reads'] = []
  const sends: IFakeInternals['sends'] = []
  const emma = { wid: EMMA_LEE, isDirect: true }
  const chats = new Map<string, IPageChat>([
    [EMMA_LEE, emma],
    [MAX_BECKER, { wid: MAX_BECKER, isDirect: true }],
    [GROUP, { wid: GROUP, isDirect: false }],
  ])

  const listeners: {
    message: ((message: IPageMessage) => void) | null
    drift: ((drift: WhatsAppNeed) => void) | null
    connection: (() => void) | null
  } = { message: null, drift: null, connection: null }

  const page: IFakeInternals['page'] = {
    lid: LEO_NOVAK,
    hasPnUser: true,
    isConnected: true,
    hasSynced: true,
    stampAt: SENT_AT + 120,
    sendResult: 'ok',
    newest: undefined,
    duringBuild: () => undefined,
  }

  let prepares = 0

  const throwIf = (call: InternalsCall): void => {
    const error = throwing.get(call)
    if (error !== undefined) {
      throw error
    }
  }

  return {
    page,
    failing,
    throwing,
    rows,
    reads,
    sends,
    chats,
    check: (need) => (failing.has(need) ? need : null),
    signedIn: () => {
      throwIf('signedIn')

      return { lid: page.lid, hasPnUser: page.hasPnUser }
    },
    connection: () => {
      throwIf('connection')

      return { isConnected: page.isConnected, hasSynced: page.hasSynced }
    },
    onConnectionChange: (listener) => {
      throwIf('onConnectionChange')
      listeners.connection = listener
    },
    onMessage: (listener, onDrift) => {
      throwIf('onMessage')
      listeners.message = listener
      listeners.drift = onDrift

      return () => {
        listeners.message = null
        listeners.drift = null
      }
    },
    chat: (wid) => {
      throwIf('chat')

      return chats.get(wid) ?? null
    },
    newest: (chat) => (chat === emma ? (page.newest === undefined ? (rows.at(-1) ?? null) : page.newest) : null),
    rowsAround: (direction, key, count) => {
      reads.push({ direction, key, count })
      throwIf('rowsAround')
      const at = rows.findIndex(({ id, fromMe }) => id === key.id && fromMe === key.fromMe)
      if (at === -1 || key.chat !== emma) {
        return Promise.resolve(null)
      }

      return Promise.resolve(
        direction === 'before' ? rows.slice(Math.max(0, at - count), at) : rows.slice(at + 1, at + 1 + count)
      )
    },
    contact: (wid) => {
      throwIf('contact')

      return wid === EMMA_LEE ? { name: 'Emma Lee', isMe: false } : null
    },
    prepareText: async () => {
      throwIf('prepareText')
      prepares += 1
      const messageId = `3EB0${String(prepares).padStart(16, '0')}`
      await Promise.resolve()
      page.duringBuild()

      return { messageId }
    },
    stamp: () => {
      throwIf('stamp')

      return page.stampAt
    },
    send: (chat, prepared) => {
      sends.push({ chat, prepared })

      return Promise.resolve(page.sendResult)
    },
    emitMessage: (message) => listeners.message?.(message),
    emitDrift: (drift) => listeners.drift?.(drift),
    changeConnection: () => listeners.connection?.(),
    isListening: () => listeners.message !== null,
  }
}

// The page's clock as the test sets it, and timers that run only when the test runs them, as a browser that delays a
// hidden tab's timers would.
const fakeHost = (): IFakeHost => {
  const clock = { now: 0 }
  const timers: IFakeHost['timers'] = []
  const cleared: number[] = []

  return {
    clock,
    timers,
    cleared,
    now: () => clock.now,
    setTimer: (run, ms) => timers.push({ run, ms }) - 1,
    clearTimer: (timer) => {
      cleared.push(timer)
    },
    token: TOKEN,
  }
}

interface IHarness {
  readonly capture: IWhatsAppCapture
  readonly internals: IFakeInternals
  readonly host: IFakeHost
  readonly posts: object[]
}

const started = (arrange: (internals: IFakeInternals) => void = () => undefined): IHarness => {
  const internals = fakeInternals()
  const host = fakeHost()
  const posts: object[] = []
  const capture = whatsappCapture((message) => posts.push(message), host)
  arrange(internals)
  capture.start(internals)

  return { capture, internals, host, posts }
}

// A command as the relay passes it on, and the answer the capture posts for it: the method's result, or 'failed'.
const ask = <TMethod extends WhatsAppBridgeMethod>(
  { capture }: IHarness,
  method: TMethod,
  params: WhatsAppBridgeParams<TMethod>,
  deadline = NO_DEADLINE
): Promise<unknown> =>
  new Promise((resolve) => {
    capture.command({ kind: 'command', id: COMMAND_ID, deadline, command: { method, params } }, (message) => {
      resolve(Reflect.get(message, 'kind') === 'failed' ? 'failed' : Reflect.get(message, 'answer'))
    })
  })

const LEO = { wid: LEO_NOVAK }

const prepare = (harness: IHarness, chat = EMMA_LEE, deadline = NO_DEADLINE): Promise<unknown> =>
  ask(harness, 'whatsappSendPrepare', { account: LEO, chat, text: 'See you at ten' }, deadline)

const preparedId = async (harness: IHarness, chat = EMMA_LEE): Promise<string> => {
  const answer = await prepare(harness, chat)
  const messageId: unknown = Reflect.get(answer as object, 'messageId')
  assert.equal(typeof messageId, 'string')

  return String(messageId)
}

const commit = (harness: IHarness, messageId: string, chat = EMMA_LEE, account = LEO): Promise<unknown> =>
  ask(harness, 'whatsappSendCommit', { account, chat, messageId, token: TOKEN })

const read = (
  harness: IHarness,
  anchor: WhatsAppBridgeParams<'whatsappHistory'>['anchor'],
  count: number,
  chat = EMMA_LEE
): Promise<unknown> => ask(harness, 'whatsappHistory', { account: LEO, chat, anchor, count })

const newMessage = (fields: Partial<IPageMessage> = {}): IPageMessage => ({
  chat: EMMA_LEE,
  isDirect: true,
  isNewMsg: true,
  id: '3EB0A1B2C3D4E5F60718',
  fromMe: false,
  type: 'chat',
  timestamp: SENT_AT,
  text: 'Lunch at noon?',
  ...fields,
})

// A history answer as the ids of its messages and its next anchor.
const ids = (answer: unknown): unknown => {
  const messages: unknown = Reflect.get(answer as object, 'messages')
  const next: unknown = Reflect.get(answer as object, 'next')

  return { messages: (messages as { id: string }[]).map(({ id }) => id), next }
}

describe('[service-worker] WhatsApp capture - readiness', () => {
  it('should be loading before it starts', () => {
    // Arrange
    const capture = whatsappCapture(() => undefined, fakeHost())

    // Act
    const state = capture.state()

    // Assert
    assert.deepEqual(state, { state: 'loading' })
  })

  it('should report ready with the account, and listen to messages and connection changes', () => {
    // Act
    const { capture, internals, posts } = started()

    // Assert
    const ready = { state: 'ready', account: { wid: LEO_NOVAK }, isConnected: true, hasSynced: true }
    assert.deepEqual(capture.state(), ready)
    assert.deepEqual(posts, [{ kind: 'capture', capture: ready }])
    assert.equal(internals.isListening(), true)
  })

  it('should report broken with no-module-system when the page has none, and answer a command broken', async () => {
    // Arrange - a capture that never starts
    const host = fakeHost()
    const posts: object[] = []
    const capture = whatsappCapture((message) => posts.push(message), host)
    const harness = { capture, internals: fakeInternals(), host, posts }

    // Act
    capture.noModuleSystem()

    // Assert
    const broken = { state: 'broken', drift: 'no-module-system' }
    assert.deepEqual(posts, [{ kind: 'capture', capture: broken }])
    assert.deepEqual(await prepare(harness), { outcome: 'broken', drift: 'no-module-system' })
  })

  it('should report signed-out when the lid getter answers null and the phone-number getter undefined, whatever the socket state', () => {
    // Act
    const { capture } = started((internals) => {
      internals.page.lid = null
      internals.page.hasPnUser = false
      internals.page.isConnected = false
      internals.page.hasSynced = false
    })

    // Assert
    assert.deepEqual(capture.state(), { state: 'signed-out' })
  })

  it('should report broken with no-lid-user when only the phone-number user exists', () => {
    // Act
    const { capture, internals } = started((page) => {
      page.page.lid = null
    })

    // Assert
    assert.deepEqual(capture.state(), { state: 'broken', drift: 'no-lid-user' })
    assert.equal(internals.isListening(), false)
  })

  it('should check every need at start and report the first one that fails, in need order', () => {
    // Act
    const { capture, internals, posts } = started((page) => {
      page.failing.add('clock')
      page.failing.add('contact')
    })

    // Assert
    assert.deepEqual(capture.state(), { state: 'broken', drift: 'contact' })
    assert.deepEqual(posts, [{ kind: 'capture', capture: { state: 'broken', drift: 'contact' } }])
    assert.equal(internals.isListening(), false)
  })

  it('should run the sample checks on the first message and the first chat when the page held none at start', async () => {
    // Arrange
    const onMessage = started()
    const onChat = started()
    onChat.internals.throwing.set('chat', new WhatsAppDriftError('chat-shape'))

    // Act
    onMessage.internals.emitDrift('message-shape')
    const answer = await prepare(onChat)

    // Assert
    assert.deepEqual(onMessage.capture.state(), { state: 'broken', drift: 'message-shape' })
    assert.equal(onMessage.internals.isListening(), false)
    assert.deepEqual(onChat.capture.state(), { state: 'broken', drift: 'chat-shape' })
    assert.deepEqual(answer, { outcome: 'broken', drift: 'chat-shape' })
  })

  it('should check every need again on a connection change, and follow the connection', () => {
    // Arrange
    const healthy = started()
    const drifted = started()

    // Act
    healthy.internals.page.isConnected = false
    healthy.internals.changeConnection()
    drifted.internals.failing.add('history')
    drifted.internals.changeConnection()

    // Assert
    assert.deepEqual(healthy.capture.state(), {
      state: 'ready',
      account: { wid: LEO_NOVAK },
      isConnected: false,
      hasSynced: true,
    })

    assert.deepEqual(drifted.capture.state(), { state: 'broken', drift: 'history' })
  })
})

describe('[service-worker] WhatsApp capture - events', () => {
  it('should report a new text of a direct chat under the account read when it came', () => {
    // Arrange
    const harness = started()
    harness.posts.length = 0

    // Act
    harness.internals.emitMessage(newMessage())
    harness.internals.page.lid = MAX_BECKER
    harness.internals.emitMessage(newMessage({ id: '3EB0A1B2C3D4E5F60719' }))

    // Assert
    const message = {
      chat: EMMA_LEE,
      id: '3EB0A1B2C3D4E5F60718',
      timestamp: SENT_AT,
      fromMe: false,
      type: 'chat',
      text: 'Lunch at noon?',
    }
    assert.deepEqual(harness.posts, [
      { kind: 'message', account: { wid: LEO_NOVAK }, message },
      {
        kind: 'capture',
        capture: { state: 'ready', account: { wid: MAX_BECKER }, isConnected: true, hasSynced: true },
      },
      { kind: 'message', account: { wid: MAX_BECKER }, message: { ...message, id: '3EB0A1B2C3D4E5F60719' } },
    ])
  })

  it("should report the owner's own new message", () => {
    // Arrange
    const harness = started()
    harness.posts.length = 0

    // Act
    harness.internals.emitMessage(newMessage({ fromMe: true, text: 'On my way' }))

    // Assert
    assert.deepEqual(harness.posts, [
      {
        kind: 'message',
        account: { wid: LEO_NOVAK },
        message: {
          chat: EMMA_LEE,
          id: '3EB0A1B2C3D4E5F60718',
          timestamp: SENT_AT,
          fromMe: true,
          type: 'chat',
          text: 'On my way',
        },
      },
    ])
  })

  it('should drop a message that is not new, one of a non-direct chat, and each unreported type', () => {
    // Arrange
    const harness = started()
    harness.posts.length = 0
    const unreported = ['album', 'interactive', 'call_log', 'e2e_notification', 'protocol', 'ciphertext']

    // Act
    harness.internals.emitMessage(newMessage({ isNewMsg: false }))
    harness.internals.emitMessage(newMessage({ chat: GROUP, isDirect: false }))
    for (const type of unreported) {
      harness.internals.emitMessage(newMessage({ type, text: '' }))
    }

    // Assert
    assert.deepEqual(harness.posts, [])
  })

  it('should report a ciphertext message once it changes to a reported type', () => {
    // Arrange
    const harness = started()
    harness.posts.length = 0

    // Act
    harness.internals.emitMessage(newMessage({ type: 'ciphertext', text: '' }))
    harness.internals.emitMessage(newMessage({ type: 'chat' }))

    // Assert
    assert.equal(harness.posts.length, 1)
    assert.deepEqual(Reflect.get(harness.posts[0] ?? {}, 'kind'), 'message')
  })

  it('should turn broken with the need of a page read that throws while a message is handled, and report nothing for it', () => {
    // Arrange - the page switched to Max Becker's account before each message
    const identity = started()
    const connection = started()
    identity.posts.length = 0
    connection.posts.length = 0
    identity.internals.page.lid = MAX_BECKER
    connection.internals.page.lid = MAX_BECKER
    identity.internals.throwing.set('signedIn', new Error('The page failed'))
    connection.internals.throwing.set('connection', new Error('The page failed'))

    // Act
    identity.internals.emitMessage(newMessage())
    connection.internals.emitMessage(newMessage())

    // Assert
    assert.deepEqual(identity.posts, [{ kind: 'capture', capture: { state: 'broken', drift: 'signed-in-user' } }])
    assert.deepEqual(connection.posts, [{ kind: 'capture', capture: { state: 'broken', drift: 'connection' } }])
    assert.deepEqual([identity.internals.isListening(), connection.internals.isListening()], [false, false])
  })

  it('should turn broken with the need of a listener whose registration throws at start, and report no message', () => {
    // Arrange
    const ready = { state: 'ready', account: { wid: LEO_NOVAK }, isConnected: true, hasSynced: true }
    const messages = started((internals) => {
      internals.throwing.set('onMessage', new Error('The page failed'))
    })

    const connection = started((internals) => {
      internals.throwing.set('onConnectionChange', new Error('The page failed'))
    })

    // Act
    messages.internals.emitMessage(newMessage())
    connection.internals.emitMessage(newMessage())

    // Assert
    assert.deepEqual(messages.posts, [
      { kind: 'capture', capture: ready },
      { kind: 'capture', capture: { state: 'broken', drift: 'collections' } },
    ])

    assert.deepEqual(connection.posts, [
      { kind: 'capture', capture: ready },
      { kind: 'capture', capture: { state: 'broken', drift: 'connection' } },
    ])

    assert.deepEqual([messages.internals.isListening(), connection.internals.isListening()], [false, false])
  })

  it('should report nothing once broken', () => {
    // Arrange
    const harness = started()
    harness.internals.failing.add('send')
    harness.internals.changeConnection()
    harness.posts.length = 0

    // Act
    harness.internals.emitMessage(newMessage())

    // Assert
    assert.deepEqual(harness.posts, [])
  })
})

describe('[service-worker] WhatsApp capture - send', () => {
  it("should answer the prepare with the observer's token and no time", async () => {
    // Arrange
    const harness = started()

    // Act
    const answer = await prepare(harness)

    // Assert
    assert.deepEqual(answer, { outcome: 'prepared', messageId: '3EB00000000000000001', token: TOKEN })
  })

  it('should keep two prepared messages for one chat and send each by its own id', async () => {
    // Arrange
    const harness = started()
    const first = await preparedId(harness)
    const second = await preparedId(harness)

    // Act
    const answers = [await commit(harness, second), await commit(harness, first)]

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'sent', timestamp: SENT_AT + 120 },
      { outcome: 'sent', timestamp: SENT_AT + 120 },
    ])

    assert.deepEqual(
      harness.internals.sends.map(({ prepared }) => prepared.messageId),
      [second, first]
    )
  })

  it('should send exactly the prepared message once, and answer unknown-message to a second commit', async () => {
    // Arrange
    const harness = started()
    const messageId = await preparedId(harness)

    // Act
    const first = await commit(harness, messageId)
    const second = await commit(harness, messageId)

    // Assert
    assert.deepEqual(first, { outcome: 'sent', timestamp: SENT_AT + 120 })
    assert.deepEqual(second, { outcome: 'refused', refusal: 'unknown-message' })
    assert.equal(harness.internals.sends.length, 1)
    assert.deepEqual(harness.internals.sends[0]?.chat, { wid: EMMA_LEE, isDirect: true })
  })

  it('should answer sent with the time stamped at the commit, not the prepare or the send result', async () => {
    // Arrange
    const harness = started()
    harness.internals.page.stampAt = SENT_AT + 1
    const messageId = await preparedId(harness)
    harness.internals.page.stampAt = SENT_AT + 90

    // Act
    const answer = await commit(harness, messageId)

    // Assert
    assert.deepEqual(answer, { outcome: 'sent', timestamp: SENT_AT + 90 })
  })

  it('should remove an entry when its window ends and its timer runs, before any command, and answer unknown-message to its commit', async () => {
    // Arrange
    const harness = started()
    const messageId = await preparedId(harness)
    const [timer] = harness.host.timers

    // Act
    harness.host.clock.now = PREPARED_SEND_WINDOW_MS
    timer?.run()
    const clearedByTimer = [...harness.host.cleared]
    const answer = await commit(harness, messageId)

    // Assert - only removing the entry clears its timer, and no prepare ran to sweep it, so the timer removed it; the
    // commit then found no entry to remove
    assert.equal(timer?.ms, PREPARED_SEND_WINDOW_MS)
    assert.deepEqual(clearedByTimer, [0])
    assert.deepEqual(harness.host.cleared, [0])
    assert.deepEqual(answer, { outcome: 'refused', refusal: 'unknown-message' })
    assert.equal(harness.internals.sends.length, 0)
  })

  it('should answer unknown-message to an entry whose timer fired late, by the time it was kept', async () => {
    // Arrange
    const harness = started()
    const messageId = await preparedId(harness)

    // Act
    harness.host.clock.now = PREPARED_SEND_WINDOW_MS
    const answer = await commit(harness, messageId)

    // Assert
    assert.deepEqual(answer, { outcome: 'refused', refusal: 'unknown-message' })
    assert.equal(harness.internals.sends.length, 0)
  })

  it('should remove an entry kept the whole window ago when the next prepare keeps a message, though its timer has not run, and change nothing when that timer runs later', async () => {
    // Arrange
    const harness = started()
    await preparedId(harness, EMMA_LEE)
    harness.host.clock.now = PREPARED_SEND_WINDOW_MS

    // Act
    const second = await preparedId(harness, MAX_BECKER)
    const clearedBySweep = [...harness.host.cleared]
    harness.host.timers[0]?.run()
    const answer = await commit(harness, second, MAX_BECKER)

    // Assert
    assert.deepEqual(clearedBySweep, [0])
    assert.deepEqual(answer, { outcome: 'sent', timestamp: SENT_AT + 120 })
  })

  it('should keep an entry kept less than the window ago when the next prepare keeps a message', async () => {
    // Arrange
    const harness = started()
    const first = await preparedId(harness, EMMA_LEE)
    harness.host.clock.now = PREPARED_SEND_WINDOW_MS - 1

    // Act
    await preparedId(harness, MAX_BECKER)
    const clearedBySweep = [...harness.host.cleared]
    const answer = await commit(harness, first)

    // Assert
    assert.deepEqual(clearedBySweep, [])
    assert.deepEqual(answer, { outcome: 'sent', timestamp: SENT_AT + 120 })
  })

  it('should hold no more than PREPARED_SEND_WINDOW_MS / 500 entries when prepares come 500 ms apart and no timer runs', async () => {
    // Arrange - 500 is request-pace.ts GAP_MIN_MS, the pace's shortest gap between two prepares of one account
    const harness = started()
    const kept: string[] = []
    const clearedAfter: number[][] = []

    // Act
    for (let at = 0; at <= PREPARED_SEND_WINDOW_MS; at += GAP_MIN_MS) {
      harness.host.clock.now = at
      kept.push(await preparedId(harness))
      clearedAfter.push([...harness.host.cleared])
    }

    const answer = await commit(harness, kept[1] ?? '')

    // Assert
    assert.equal(kept.length, PREPARED_SEND_WINDOW_MS / GAP_MIN_MS + 1)
    assert.deepEqual(clearedAfter.at(-2), [])
    assert.deepEqual(clearedAfter.at(-1), [0])
    assert.deepEqual(answer, { outcome: 'sent', timestamp: SENT_AT + 120 })
  })

  it('should refuse a commit naming another chat, another account, or an id prepared for another account, sending nothing', async () => {
    // Arrange
    const harness = started()
    const messageId = await preparedId(harness)

    // Act
    const otherChat = await commit(harness, messageId, MAX_BECKER)
    const otherAccount = await commit(harness, messageId, EMMA_LEE, { wid: MAX_BECKER })
    harness.internals.page.lid = MAX_BECKER
    const preparedForAnother = await commit(harness, messageId, EMMA_LEE, { wid: MAX_BECKER })

    // Assert
    assert.deepEqual(
      [otherChat, otherAccount, preparedForAnother],
      [
        { outcome: 'refused', refusal: 'chat-mismatch' },
        { outcome: 'refused', refusal: 'other-account' },
        { outcome: 'refused', refusal: 'unknown-message' },
      ]
    )

    assert.equal(harness.internals.sends.length, 0)
  })

  it("should clear the store when the page's account changes or the page signs out, before the next command", async () => {
    // Arrange
    const changed = started()
    const signedOut = started()
    const changedId = await preparedId(changed)
    const signedOutId = await preparedId(signedOut)

    // Act
    changed.internals.page.lid = MAX_BECKER
    changed.internals.changeConnection()
    signedOut.internals.page.lid = null
    signedOut.internals.page.hasPnUser = false
    signedOut.internals.changeConnection()
    const clearedBeforeCommand = [[...changed.host.cleared], [...signedOut.host.cleared]]
    changed.internals.page.lid = LEO_NOVAK
    signedOut.internals.page.lid = LEO_NOVAK
    const answers = [await commit(changed, changedId), await commit(signedOut, signedOutId)]

    // Assert
    assert.deepEqual(clearedBeforeCommand, [[0], [0]])
    assert.deepEqual(answers, [
      { outcome: 'refused', refusal: 'unknown-message' },
      { outcome: 'refused', refusal: 'unknown-message' },
    ])
  })

  it('should keep nothing when the account, the connection or the deadline changed while the message was built', async () => {
    // Arrange
    const account = started()
    const connection = started()
    const deadline = started()
    account.internals.page.duringBuild = () => {
      account.internals.page.lid = MAX_BECKER
    }

    connection.internals.page.duringBuild = () => {
      connection.internals.page.isConnected = false
    }

    deadline.internals.page.duringBuild = () => {
      deadline.host.clock.now = 1_000
    }

    // Act
    const answers = [await prepare(account), await prepare(connection), await prepare(deadline, EMMA_LEE, 1_000)]

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'refused', refusal: 'other-account' },
      { outcome: 'refused', refusal: 'not-connected' },
      { outcome: 'refused', refusal: 'deadline-passed' },
    ])

    assert.deepEqual(
      [account.host.timers.length, connection.host.timers.length, deadline.host.timers.length],
      [0, 0, 0]
    )
  })

  it('should refuse prepare and commit while not connected, and once the deadline passed, sending nothing', async () => {
    // Arrange
    const harness = started()
    const messageId = await preparedId(harness)
    harness.host.clock.now = 10

    // Act
    const late = [
      await prepare(harness, EMMA_LEE, 10),
      await ask(harness, 'whatsappSendCommit', { account: LEO, chat: EMMA_LEE, messageId, token: TOKEN }, 10),
    ]
    harness.internals.page.isConnected = false
    const offline = [await prepare(harness), await commit(harness, messageId)]

    // Assert
    assert.deepEqual(late, [
      { outcome: 'refused', refusal: 'deadline-passed' },
      { outcome: 'refused', refusal: 'deadline-passed' },
    ])

    assert.deepEqual(offline, [
      { outcome: 'refused', refusal: 'not-connected' },
      { outcome: 'refused', refusal: 'not-connected' },
    ])

    assert.equal(harness.internals.sends.length, 0)
  })

  it('should answer page-failed and send nothing when stamping throws while the clock still checks out, and broken when it does not', async () => {
    // Arrange
    const passing = started()
    const failing = started()
    const passingId = await preparedId(passing)
    const failingId = await preparedId(failing)
    passing.internals.throwing.set('stamp', new Error('The page failed'))
    failing.internals.throwing.set('stamp', new Error('The page failed'))
    failing.internals.failing.add('clock')

    // Act
    const answers = [await commit(passing, passingId), await commit(failing, failingId)]

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'refused', refusal: 'page-failed' },
      { outcome: 'broken', drift: 'clock' },
    ])

    assert.deepEqual([passing.internals.sends.length, failing.internals.sends.length], [0, 0])
    assert.deepEqual(failing.capture.state(), { state: 'broken', drift: 'clock' })
  })

  it('should answer broken with send and hand nothing to the sender when the stamp finds the time not written', async () => {
    // Arrange
    const harness = started()
    const messageId = await preparedId(harness)
    harness.internals.throwing.set('stamp', new WhatsAppDriftError('send'))

    // Act
    const answer = await commit(harness, messageId)

    // Assert
    assert.deepEqual(answer, { outcome: 'broken', drift: 'send' })
    assert.equal(harness.internals.sends.length, 0)
    assert.deepEqual(harness.capture.state(), { state: 'broken', drift: 'send' })
  })

  it("should answer sent for the page's OK, and unconfirmed with result-not-ok, send-rejected, result-rejected or result-unreadable otherwise, never broken or refused", async () => {
    // Arrange
    const results: PageSendResult[] = ['ok', 'not-ok', 'send-rejected', 'result-rejected', 'result-unreadable']
    const answers: unknown[] = []

    // Act
    for (const result of results) {
      const harness = started()
      harness.internals.page.sendResult = result
      answers.push(await commit(harness, await preparedId(harness)))
    }

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'sent', timestamp: SENT_AT + 120 },
      { outcome: 'unconfirmed', code: 'result-not-ok' },
      { outcome: 'unconfirmed', code: 'send-rejected' },
      { outcome: 'unconfirmed', code: 'result-rejected' },
      { outcome: 'unconfirmed', code: 'result-unreadable' },
    ])
  })

  it('should turn the capture broken with send, apart from the commit unconfirmed answer, when the send result does not read', async () => {
    // Arrange
    const unreadable = started()
    const rejected = started()
    unreadable.internals.page.sendResult = 'result-unreadable'
    rejected.internals.page.sendResult = 'send-rejected'
    const unreadableId = await preparedId(unreadable)
    const rejectedId = await preparedId(rejected)
    rejected.internals.failing.add('send')
    unreadable.posts.length = 0

    // Act
    const answers = [await commit(unreadable, unreadableId), await commit(rejected, rejectedId)]

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'unconfirmed', code: 'result-unreadable' },
      { outcome: 'unconfirmed', code: 'send-rejected' },
    ])

    assert.deepEqual(unreadable.posts, [{ kind: 'capture', capture: { state: 'broken', drift: 'send' } }])
    assert.deepEqual(rejected.capture.state(), { state: 'broken', drift: 'send' })
  })
})

describe('[service-worker] WhatsApp capture - failures', () => {
  it('should answer failed when a prepare or a read throws while its needs check out', async () => {
    // Arrange
    const harness = started()
    for (const call of ['prepareText', 'rowsAround', 'contact'] as const) {
      harness.internals.throwing.set(call, new Error('The page failed'))
    }

    // Act
    const answers = [
      await prepare(harness),
      await read(harness, null, 3),
      await ask(harness, 'whatsappContact', { account: LEO, wid: EMMA_LEE }),
    ]

    // Assert
    assert.deepEqual(answers, ['failed', 'failed', 'failed'])
    assert.equal(harness.capture.state().state, 'ready')
  })

  it('should turn the capture broken, post it and answer broken when a call throws and its need fails', async () => {
    // Arrange
    const harness = started()
    harness.internals.throwing.set('prepareText', new Error('The page failed'))
    harness.internals.failing.add('send')
    harness.posts.length = 0

    // Act
    const answer = await prepare(harness)
    const later = await read(harness, null, 3)

    // Assert
    assert.deepEqual(answer, { outcome: 'broken', drift: 'send' })
    assert.deepEqual(later, { outcome: 'broken', drift: 'send' })
    assert.deepEqual(harness.posts, [{ kind: 'capture', capture: { state: 'broken', drift: 'send' } }])
  })
})

describe('[service-worker] WhatsApp capture - history', () => {
  it('should refuse no-chat, not-direct-chat and chat-mismatch', async () => {
    // Arrange
    const harness = started()
    harness.internals.chats.set('100000000000005@lid', { wid: '100000000000006@lid', isDirect: true })

    // Act
    const answers = [
      await read(harness, null, 3, '100000000000007@lid'),
      await read(harness, null, 3, GROUP),
      await read(harness, null, 3, '100000000000005@lid'),
    ]

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'refused', refusal: 'no-chat' },
      { outcome: 'refused', refusal: 'not-direct-chat' },
      { outcome: 'refused', refusal: 'chat-mismatch' },
    ])
  })

  it('should keep the rows nearest the anchor of a full before-page, and anchor next on the oldest kept', async () => {
    // Arrange
    const harness = started()

    // Act
    const answer = await read(harness, { direction: 'before', messageId: 'ROW8', fromMe: true }, 3)

    // Assert
    assert.deepEqual(ids(answer), {
      messages: ['ROW5', 'ROW6', 'ROW7'],
      next: { direction: 'before', messageId: 'ROW5', fromMe: false },
    })

    assert.deepEqual(
      harness.internals.reads.map(({ count }) => count),
      [4]
    )
  })

  it('should keep the rows nearest the anchor of a full after-page, and anchor next on the newest kept', async () => {
    // Arrange
    const harness = started()

    // Act
    const answer = await read(harness, { direction: 'after', messageId: 'ROW3', fromMe: false }, 3)

    // Assert
    assert.deepEqual(ids(answer), {
      messages: ['ROW4', 'ROW5', 'ROW6'],
      next: { direction: 'after', messageId: 'ROW6', fromMe: true },
    })
  })

  it('should answer null next at the oldest end and at the newest end, and when exactly count rows remain', async () => {
    // Arrange
    const harness = started()

    // Act
    const oldest = await read(harness, { direction: 'before', messageId: 'ROW3', fromMe: false }, 3)
    const newest = await read(harness, { direction: 'after', messageId: 'ROW8', fromMe: true }, 3)
    const exact = await read(harness, { direction: 'before', messageId: 'ROW4', fromMe: true }, 3)

    // Assert
    assert.deepEqual(
      [ids(oldest), ids(newest), ids(exact)],
      [
        { messages: ['ROW1', 'ROW2'], next: null },
        { messages: ['ROW9', 'ROW10'], next: null },
        { messages: ['ROW1', 'ROW2', 'ROW3'], next: null },
      ]
    )
  })

  it('should move on past a page whose rows are all unreported, answering no messages and a next anchor', async () => {
    // Arrange
    const harness = started()
    for (const index of [4, 5, 6, 7]) {
      harness.internals.rows[index - 1] = rowAt(index, 'call_log')
    }

    // Act
    const answer = await read(harness, { direction: 'before', messageId: 'ROW8', fromMe: true }, 3)

    // Assert
    assert.deepEqual(ids(answer), { messages: [], next: { direction: 'before', messageId: 'ROW5', fromMe: false } })
  })

  it("should read the newest messages with the chat's last one included and count rows before it, for count 1 and 3", async () => {
    // Arrange
    const harness = started()

    // Act
    const three = await read(harness, null, 3)
    const one = await read(harness, null, 1)

    // Assert
    assert.deepEqual(
      [ids(three), ids(one)],
      [
        { messages: ['ROW8', 'ROW9', 'ROW10'], next: { direction: 'before', messageId: 'ROW8', fromMe: true } },
        { messages: ['ROW10'], next: { direction: 'before', messageId: 'ROW10', fromMe: true } },
      ]
    )

    assert.deepEqual(
      harness.internals.reads.map(({ direction, count }) => [direction, count]),
      [
        ['before', 3],
        ['before', 1],
      ]
    )
  })

  it("should read the newest page around the key of the chat's last message", async () => {
    // Arrange
    const harness = started()

    // Act
    await read(harness, null, 3)

    // Assert
    const [{ key } = assert.fail('No read')] = harness.internals.reads
    assert.equal(key.chat, harness.internals.chats.get(EMMA_LEE))
    assert.deepEqual({ id: key.id, fromMe: key.fromMe }, { id: 'ROW10', fromMe: true })
  })

  it("should read an anchored page around the key of the anchor's messageId and fromMe in the chat the read was checked against", async () => {
    // Arrange
    const harness = started()

    // Act
    await read(harness, { direction: 'after', messageId: 'ROW3', fromMe: false }, 2)

    // Assert
    const [{ direction, key, count } = assert.fail('No read')] = harness.internals.reads
    assert.equal(key.chat, harness.internals.chats.get(EMMA_LEE))
    assert.deepEqual(
      { direction, id: key.id, fromMe: key.fromMe, count },
      { direction: 'after', id: 'ROW3', fromMe: false, count: 3 }
    )
  })

  it('should answer no messages and no next for a chat with no message', async () => {
    // Arrange
    const harness = started()
    harness.internals.page.newest = null

    // Act
    const answer = await read(harness, null, 3)

    // Assert
    assert.deepEqual(answer, { outcome: 'read', messages: [], next: null })
    assert.equal(harness.internals.reads.length, 0)
  })

  it("should refuse unknown-anchor when the database does not hold the anchor, or not yet the chat's newest message", async () => {
    // Arrange
    const harness = started()

    // Act
    const unknown = await read(harness, { direction: 'before', messageId: 'ROW8', fromMe: false }, 3)
    harness.internals.page.newest = rowAt(11)
    const notYet = await read(harness, null, 3)

    // Assert
    assert.deepEqual(
      [unknown, notYet],
      [
        { outcome: 'refused', refusal: 'unknown-anchor' },
        { outcome: 'refused', refusal: 'unknown-anchor' },
      ]
    )
  })

  it('should answer each kept message of a reported type with the chat and its fields', async () => {
    // Arrange
    const harness = started()

    // Act
    const answer = await read(harness, { direction: 'after', messageId: 'ROW8', fromMe: true }, 3)

    // Assert
    assert.deepEqual(answer, {
      outcome: 'read',
      messages: [
        { chat: EMMA_LEE, id: 'ROW9', timestamp: SENT_AT + 9, fromMe: false, type: 'chat', text: 'Message 9' },
        { chat: EMMA_LEE, id: 'ROW10', timestamp: SENT_AT + 10, fromMe: true, type: 'chat', text: 'Message 10' },
      ],
      next: null,
    })
  })
})

describe('[service-worker] WhatsApp capture - contact', () => {
  it('should answer the name and whether the contact is the owner, unknown-contact for a wid the page does not know, and not-direct-chat for a group', async () => {
    // Arrange
    const harness = started()

    // Act
    const answers = [
      await ask(harness, 'whatsappContact', { account: LEO, wid: EMMA_LEE }),
      await ask(harness, 'whatsappContact', { account: LEO, wid: MAX_BECKER }),
      await ask(harness, 'whatsappContact', { account: LEO, wid: GROUP }),
    ]

    // Assert
    assert.deepEqual(answers, [
      { outcome: 'read', name: 'Emma Lee', isMe: false },
      { outcome: 'refused', refusal: 'unknown-contact' },
      { outcome: 'refused', refusal: 'not-direct-chat' },
    ])
  })
})
