import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { whatsappCapture } from './whatsapp-capture.js'
import {
  type IPageMessage,
  type IWhatsAppInternals,
  type PageSendResult,
  WHATSAPP_NEEDS,
  WhatsAppDriftError,
  whatsappInternalsOf,
  type WhatsAppNeed,
} from './whatsapp-internals.js'

// A fake of WhatsApp Web's module system, shaped only as observed in a real tab (design U2, spike facts and probes):
// window.require answers a module by name and throws for one it does not hold. Every wid, name and text is made up:
// Leo Novak is the signed-in user, Emma Lee and Max Becker are people he writes with.
const SERIALIZED = '_serialized'
// The page's name for a message's time on a message, a row, built data and a send result.
const PAGE_TIME = 't'
const LEO_NOVAK = '100000000000001@lid'
const EMMA_LEE = '100000000000002@lid'
const MAX_BECKER = '100000000000003@c.us'
const LEO_NOVAK_PHONE = '100000000000009@c.us'
const GROUP = '120363000000000001@g.us'
const MESSAGE_ID = '3EB0A1B2C3D4E5F60718'
const SENT_AT = 1_700_000_000
const TOKEN = '5b0d7e3a-9c41-4f2e-8a6b-1d2c3e4f5a6b'
const COMMAND_ID = '0f6d2c1a-3b4e-4d5f-8a9b-0c1d2e3f4a5b'

type WidFlag = 'isUser' | 'isGroup' | 'isNewsletter' | 'isBroadcast' | 'isBot' | 'isStatus'

type Listener = (model: unknown) => void

interface IFakeRow {
  readonly id: IFakeKey
  readonly type: string
  readonly [PAGE_TIME]: number
  readonly body?: string
  readonly caption?: string
}

interface IFakeKey {
  readonly fromMe: boolean
  readonly remote: Record<string, unknown>
  readonly id: string
  readonly toString: () => string
}

// What the contact getters answer for a contact. The page's contact object carries none of it, so the internals can
// learn a name or isMe only through the getters, the members observed (U2-R3).
interface IFakeContact {
  readonly name?: string
  readonly pushname?: string
  readonly isMe?: boolean
}

interface IFindCall {
  readonly finder: string
  readonly anchor: unknown
  readonly count: number
}

const widOf = (serialized: string, flags: Partial<Record<WidFlag, boolean>> = {}): Record<string, unknown> => ({
  [SERIALIZED]: serialized,
  isUser: () => flags.isUser ?? true,
  isGroup: () => flags.isGroup ?? false,
  isLid: () => serialized.endsWith('@lid'),
  isNewsletter: () => flags.isNewsletter ?? false,
  isBroadcast: () => flags.isBroadcast ?? false,
  isBot: () => flags.isBot ?? false,
  isStatus: () => flags.isStatus ?? false,
})

// A MsgKey: its toString is <fromMe>_<remote>_<id>, with _out after an outgoing key (spike fact).
const keyOf = (fromMe: boolean, remote: Record<string, unknown>, id: string): IFakeKey => ({
  fromMe,
  remote,
  id,
  toString: () => `${fromMe}_${String(remote[SERIALIZED])}_${id}${fromMe ? '_out' : ''}`,
})

const rowOf = (id: string, fields: Partial<Omit<IFakeRow, 'id'>> & { readonly fromMe?: boolean } = {}): IFakeRow => {
  const { fromMe = false, ...rest } = fields

  return { id: keyOf(fromMe, widOf(EMMA_LEE), id), type: 'chat', [PAGE_TIME]: SENT_AT, body: `Message ${id}`, ...rest }
}

// WAWebMsgKey is the key's constructor itself, with fromString beside it (P3).
class FakeMsgKey {
  public static fromString = (): never => {
    throw new Error('The internals never parse a key from a string')
  }

  public readonly fromMe: boolean
  public readonly remote: unknown
  public readonly id: string

  constructor({ fromMe, remote, id }: { fromMe: boolean; remote: unknown; id: string }) {
    this.fromMe = fromMe
    this.remote = remote
    this.id = id
  }
}

// Ten rows of Emma Lee's chat, 1 the oldest, ids '1' to '10' made id-shaped.
const ROW_IDS = Array.from({ length: 10 }, (_, index) => `ROW${index + 1}`)

interface IFakePage {
  readonly modules: Record<string, unknown>
  readonly messages: unknown[]
  readonly chats: Map<string, unknown>
  readonly contacts: Map<string, IFakeContact>
  readonly me: { lid: unknown; pn: unknown }
  readonly rows: IFakeRow[]
  readonly finds: IFindCall[]
  readonly built: Record<string, unknown>[]
  readonly handedOver: unknown[][]
  readonly clock: { now: number }
  readonly findAnswer: { override: unknown }
  readonly sendAnswer: { handed: () => unknown }
  readonly lastOfEmma: { message: unknown }
  readonly emmaWid: Record<string, unknown>
  readonly listeners: Record<string, Listener[]>
  readonly emit: (event: string, model: unknown) => void
  readonly internals: IWhatsAppInternals
}

const fakePage = (): IFakePage => {
  const listeners: Record<string, Listener[]> = { 'add': [], 'change:type': [] }
  const messages: unknown[] = []
  const lastOfEmma: { message: unknown } = { message: undefined }
  const emmaWid = widOf(EMMA_LEE)
  const chats = new Map<string, unknown>([
    [EMMA_LEE, { id: emmaWid, msgs: { last: () => lastOfEmma.message } }],
    [MAX_BECKER, { id: widOf(MAX_BECKER), msgs: { last: () => undefined } }],
    [GROUP, { id: widOf(GROUP, { isUser: false, isGroup: true }), msgs: { last: () => undefined } }],
  ])

  const contacts = new Map<string, IFakeContact>()
  // Keyed by the contact object Contact.get answered, which holds only its id.
  const contactAnswers = new Map<object, IFakeContact>()
  const contactOf = (wid: string): object | undefined => {
    const answers = contacts.get(wid)
    if (answers === undefined) {
      return undefined
    }

    const contact = { id: widOf(wid) }
    contactAnswers.set(contact, answers)

    return contact
  }

  const me: { lid: unknown; pn: unknown } = { lid: widOf(LEO_NOVAK), pn: widOf(LEO_NOVAK_PHONE) }
  const rows = ROW_IDS.map((id) => rowOf(id))
  const finds: IFindCall[] = []
  const built: Record<string, unknown>[] = []
  const handedOver: unknown[][] = []
  const clock = { now: SENT_AT + 120 }
  const findAnswer: { override: unknown } = { override: undefined }
  const sendAnswer: { handed: () => unknown } = {
    handed: () =>
      Promise.resolve([
        Promise.resolve(),
        Promise.resolve({ messageSendResult: 'OK', [PAGE_TIME]: SENT_AT, count: 1 }),
      ]),
  }

  const find =
    (finder: string): ((query: { anchor: FakeMsgKey; count: number }) => Promise<unknown>) =>
    ({ anchor, count }: { anchor: FakeMsgKey; count: number }): Promise<unknown> => {
      finds.push({ finder, anchor, count })
      if (findAnswer.override !== undefined) {
        return Promise.resolve(findAnswer.override)
      }

      const at = rows.findIndex(({ id }) => id.id === anchor.id && id.fromMe === anchor.fromMe)
      if (at === -1 || anchor.remote !== emmaWid) {
        return Promise.resolve({ status: 404, messages: [] })
      }

      const found =
        finder === 'msgFindBefore' ? rows.slice(Math.max(0, at - count), at) : rows.slice(at + 1, at + 1 + count)

      return Promise.resolve({ status: 200, messages: found })
    }

  const modules: Record<string, unknown> = {
    WAWebCollections: {
      Msg: {
        on: (event: string, listener: Listener) => listeners[event]?.push(listener),
        off: (event: string, listener: Listener) => {
          listeners[event] = (listeners[event] ?? []).filter((each) => each !== listener)
        },
        get: () => undefined,
        getModelsArray: () => messages,
      },
      Chat: { get: (wid: string) => chats.get(wid), getModelsArray: () => [...chats.values()] },
      Contact: { get: contactOf },
    },
    WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => me.lid, getMaybeMePnUser: () => me.pn },
    WAWebSocketModel: {
      Socket: {
        state: 'CONNECTED',
        stream: 'CONNECTED',
        hasSynced: true,
        on: () => undefined,
        off: () => undefined,
      },
    },
    WAWebDBMessageFindLocal: { msgFindBefore: find('msgFindBefore'), msgFindAfter: find('msgFindAfter') },
    // A class of the page's own, so a test that reshapes it leaves every other page's as it was.
    WAWebMsgKey: class PageMsgKey extends FakeMsgKey {},
    WAWebContactGetters: {
      getName: (contact: object) => contactAnswers.get(contact)?.name,
      getPushname: (contact: object) => contactAnswers.get(contact)?.pushname,
      getIsMe: (contact: object) => contactAnswers.get(contact)?.isMe === true,
    },
    WAWebSendTextMsgChatAction: {
      createTextMsgData: (_chat: unknown, text: string, _options: object) => {
        const data = {
          id: keyOf(true, emmaWid, `3EB0PREPARED${built.length}`),
          [PAGE_TIME]: SENT_AT,
          body: text,
          type: 'chat',
        }

        built.push(data)

        return Promise.resolve(data)
      },
    },
    WAWebSendMsgChatAction: {
      addAndSendMsgToChat: (...args: unknown[]) => {
        handedOver.push(args)

        return sendAnswer.handed()
      },
    },
    WATimeUtils: { unixTime: () => clock.now },
  }

  const require = (name: string): unknown => {
    if (!(name in modules)) {
      throw new Error(`Requiring unknown module "${name}"`)
    }

    return modules[name]
  }

  const emit = (event: string, model: unknown): void => {
    for (const listener of listeners[event] ?? []) {
      listener(model)
    }
  }

  return {
    modules,
    messages,
    chats,
    contacts,
    me,
    rows,
    finds,
    built,
    handedOver,
    clock,
    findAnswer,
    sendAnswer,
    lastOfEmma,
    emmaWid,
    listeners,
    emit,
    internals: whatsappInternalsOf(require),
  }
}

// Sets the value at path inside root: undefined removes it as far as the internals can tell.
const setAt = (root: object, path: readonly (string | number)[], value: unknown): void => {
  const owner = path.slice(0, -1).reduce<unknown>((at, key) => Reflect.get(at as object, key), root)
  Reflect.set(owner as object, path.at(-1) ?? '', value)
}

const driftOf = (run: () => unknown): WhatsAppNeed | null => {
  try {
    run()

    return null
  } catch (error) {
    return error instanceof WhatsAppDriftError ? error.drift : null
  }
}

const isDrift =
  (need: WhatsAppNeed) =>
  (error: unknown): boolean =>
    error instanceof WhatsAppDriftError && error.drift === need

// Makes Msg.on throw for one event, as a page whose collection refuses that listener would.
const refusingListener = (page: IFakePage, refused: string): void => {
  setAt(page.modules, ['WAWebCollections', 'Msg', 'on'], (event: string, listener: Listener) => {
    if (event === refused) {
      throw new Error('The page failed')
    }

    page.listeners[event]?.push(listener)
  })
}

// Makes createTextMsgData answer data the test shapes from the data the page would build.
const buildingWith = (page: IFakePage, shape: (data: Record<string, unknown>) => Record<string, unknown>): void => {
  setAt(page.modules, ['WAWebSendTextMsgChatAction', 'createTextMsgData'], (_chat: unknown, text: string) => {
    const data = shape({
      id: keyOf(true, page.emmaWid, '3EB0PREPARED0'),
      [PAGE_TIME]: SENT_AT,
      body: text,
      type: 'chat',
    })
    page.built.push(data)

    return Promise.resolve(data)
  })
}

// A capture over these internals, its posts and a command helper that resolves with the answer it posts.
const capturedOver = (
  page: IFakePage
): {
  readonly posts: object[]
  readonly state: () => unknown
  readonly ask: (method: string, params: object) => Promise<unknown>
} => {
  const posts: object[] = []
  const host = { now: () => 0, setTimer: () => 0, clearTimer: () => undefined, token: TOKEN }
  const capture = whatsappCapture((message) => posts.push(message), host)
  capture.start(page.internals)

  const ask = (method: string, params: object): Promise<unknown> =>
    new Promise((resolve) => {
      capture.command(
        { kind: 'command', id: COMMAND_ID, deadline: Number.MAX_SAFE_INTEGER, command: { method, params } },
        (message) => {
          resolve(Reflect.get(message, 'answer'))
        }
      )
    })

  return { posts, state: capture.state, ask }
}

describe('[service-worker] WhatsApp internals - reading the page', () => {
  it('should read the signed-in lid wid, and none when the page has no user', () => {
    // Arrange
    const page = fakePage()

    // Act
    const signedIn = page.internals.signedIn()
    page.me.lid = null
    page.me.pn = undefined
    const signedOut = page.internals.signedIn()
    page.me.pn = widOf(LEO_NOVAK_PHONE)
    const phoneOnly = page.internals.signedIn()

    // Assert
    assert.deepEqual(signedIn, { lid: LEO_NOVAK, hasPnUser: true })
    assert.deepEqual(signedOut, { lid: null, hasPnUser: false })
    assert.deepEqual(phoneOnly, { lid: null, hasPnUser: true })
  })

  it('should pass the connection check with hasSynced undefined and report it not synced', () => {
    // Arrange
    const page = fakePage()
    setAt(page.modules, ['WAWebSocketModel', 'Socket', 'hasSynced'], undefined)
    setAt(page.modules, ['WAWebSocketModel', 'Socket', 'state'], 'UNPAIRED')

    // Act
    const drift = page.internals.check('connection')
    const connection = page.internals.connection()

    // Assert
    assert.equal(drift, null)
    assert.deepEqual(connection, { isConnected: false, hasSynced: false })
  })

  it("should take the key's own id, not its toString() with _out", () => {
    // Arrange
    const page = fakePage()
    page.lastOfEmma.message = rowOf(MESSAGE_ID, { fromMe: true })
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)

    // Act
    const newest = page.internals.newest(chat)

    // Assert
    assert.deepEqual(newest, {
      id: MESSAGE_ID,
      fromMe: true,
      type: 'chat',
      timestamp: SENT_AT,
      text: `Message ${MESSAGE_ID}`,
    })
  })

  it('should take a chat as direct only when its wid is a user and carries no other flag', () => {
    // Arrange
    const page = fakePage()
    page.chats.set('100000000000004@lid', {
      id: widOf('100000000000004@lid', { isBot: true }),
      msgs: { last: () => null },
    })

    // Act
    const chats = [EMMA_LEE, MAX_BECKER, GROUP, '100000000000004@lid', '100000000000005@lid'].map((wid) =>
      page.internals.chat(wid)
    )

    // Assert
    assert.deepEqual(chats, [
      { wid: EMMA_LEE, isDirect: true },
      { wid: MAX_BECKER, isDirect: true },
      { wid: GROUP, isDirect: false },
      { wid: '100000000000004@lid', isDirect: false },
      null,
    ])
  })

  it("should take a text's body and a media message's caption as its text, empty when it has none, and never a media message's body", () => {
    // Arrange
    const page = fakePage()
    const seen: IPageMessage[] = []
    page.internals.onMessage(
      (message) => seen.push(message),
      () => assert.fail('No message here fails its shape')
    )

    // Act
    page.emit('add', { ...rowOf('TEXT1', { body: 'See you at ten' }), isNewMsg: true })
    page.emit('add', {
      ...rowOf('IMAGE1', { type: 'image', body: 'AAAAbase64', caption: 'The new office' }),
      isNewMsg: true,
    })
    page.emit('add', { ...rowOf('VIDEO1', { type: 'video', body: 'AAAAbase64' }), isNewMsg: true })
    page.emit('add', { ...rowOf('CALL1', { type: 'call_log', body: 'AAAAbase64' }) })

    // Assert
    assert.deepEqual(
      seen.map(({ id, type, text, isNewMsg }) => ({ id, type, text, isNewMsg })),
      [
        { id: 'TEXT1', type: 'chat', text: 'See you at ten', isNewMsg: true },
        { id: 'IMAGE1', type: 'image', text: 'The new office', isNewMsg: true },
        { id: 'VIDEO1', type: 'video', text: '', isNewMsg: true },
        { id: 'CALL1', type: 'call_log', text: '', isNewMsg: false },
      ]
    )
  })

  it('should throw the message-shape drift for a text without a string body', () => {
    // Arrange
    const page = fakePage()
    page.lastOfEmma.message = { ...rowOf(MESSAGE_ID), body: undefined }
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)

    // Act
    const drift = driftOf(() => page.internals.newest(chat))

    // Assert
    assert.equal(drift, 'message-shape')
  })

  it('should hand on each message the page adds or retypes, send one that does not read to onDrift, and stop once removed', () => {
    // Arrange
    const page = fakePage()
    const seen: string[] = []
    const drifts: WhatsAppNeed[] = []
    const stop = page.internals.onMessage(
      (message) => seen.push(`${message.id} ${message.chat} ${String(message.isDirect)}`),
      (drift) => drifts.push(drift)
    )

    // Act
    page.emit('add', { ...rowOf('NEW1'), isNewMsg: true })
    page.emit('change:type', { ...rowOf('NEW2'), isNewMsg: true })
    page.emit('add', { ...rowOf('NEW3'), isNewMsg: 'yes' })
    stop()
    page.emit('add', { ...rowOf('NEW4'), isNewMsg: true })

    // Assert
    assert.deepEqual(seen, [`NEW1 ${EMMA_LEE} true`, `NEW2 ${EMMA_LEE} true`])
    assert.deepEqual(drifts, ['message-shape'])
    assert.deepEqual([page.listeners.add?.length, page.listeners['change:type']?.length], [0, 0])
  })

  it('should read nothing of a message outside a one-to-one chat but which chat it belongs to', () => {
    // Arrange
    const page = fakePage()
    const reads: string[] = []
    // Defines each field on target as a getter that records its read, so a spread, which would read them, is not used.
    const recorded = (event: string, target: object, fields: Record<string, unknown>): object =>
      Object.defineProperties(
        target,
        Object.fromEntries(
          Object.entries(fields).map(([name, value]) => [
            name,
            {
              get: () => {
                reads.push(`${event} ${name}`)

                return value
              },
            },
          ])
        )
      )

    const groupMessage = (event: string): object => {
      const key = recorded(
        event,
        { remote: widOf(GROUP, { isUser: false, isGroup: true }) },
        {
          id: MESSAGE_ID,
          fromMe: false,
        }
      )

      return recorded(
        event,
        { id: key },
        { type: 'image', [PAGE_TIME]: SENT_AT, body: 'AAAAbase64', caption: 'The new office', isNewMsg: true }
      )
    }

    const seen: IPageMessage[] = []
    const drifts: WhatsAppNeed[] = []
    page.internals.onMessage(
      (message) => seen.push(message),
      (drift) => drifts.push(drift)
    )

    // Act
    page.emit('add', groupMessage('add'))
    page.emit('change:type', groupMessage('change:type'))

    // Assert
    assert.deepEqual(reads, [])
    assert.deepEqual(seen, [])
    assert.deepEqual(drifts, [])
  })

  it('should throw and leave no message listener when registering the add or the change:type listener throws', () => {
    // Arrange
    const onAdd = fakePage()
    const onTypeChange = fakePage()
    refusingListener(onAdd, 'add')
    refusingListener(onTypeChange, 'change:type')
    const register = (page: IFakePage) => (): unknown =>
      page.internals.onMessage(
        () => undefined,
        () => undefined
      )

    // Act + Assert
    assert.throws(register(onAdd))
    assert.throws(register(onTypeChange))
    assert.deepEqual(
      [onAdd, onTypeChange].map(({ listeners }) => [listeners.add?.length, listeners['change:type']?.length]),
      [
        [0, 0],
        [0, 0],
      ]
    )
  })

  it('should name a contact by its saved name, then its push name, then none', () => {
    // Arrange
    const page = fakePage()
    page.contacts.set(EMMA_LEE, { name: 'Emma Lee', pushname: 'Em' })
    page.contacts.set(MAX_BECKER, { pushname: 'Max' })
    page.contacts.set('100000000000005@lid', { name: '' })
    page.contacts.set(LEO_NOVAK, { name: 'Leo Novak', isMe: true })

    // Act
    const contacts = [EMMA_LEE, MAX_BECKER, '100000000000005@lid', LEO_NOVAK, '100000000000006@lid'].map((wid) =>
      page.internals.contact(wid)
    )

    // Assert
    assert.deepEqual(contacts, [
      { name: 'Emma Lee', isMe: false },
      { name: 'Max', isMe: false },
      { name: null, isMe: false },
      { name: 'Leo Novak', isMe: true },
      null,
    ])
  })
})

describe('[service-worker] WhatsApp internals - history', () => {
  it("should read rows around a key built from fromMe, the chat's wid and the id, asking the count it is given, and answer none for status 404", async () => {
    // Arrange
    const page = fakePage()
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)

    // Act
    const before = await page.internals.rowsAround('before', { chat, fromMe: false, id: 'ROW8' }, 4)
    const after = await page.internals.rowsAround('after', { chat, fromMe: false, id: 'ROW3' }, 2)
    const unknown = await page.internals.rowsAround('before', { chat, fromMe: true, id: 'ROW8' }, 4)

    // Assert
    assert.deepEqual(
      before?.map(({ id }) => id),
      ['ROW4', 'ROW5', 'ROW6', 'ROW7']
    )

    assert.deepEqual(
      after?.map(({ id }) => id),
      ['ROW4', 'ROW5']
    )

    assert.equal(unknown, null)
    assert.deepEqual(
      page.finds.map(({ finder, count }) => [finder, count]),
      [
        ['msgFindBefore', 4],
        ['msgFindAfter', 2],
        ['msgFindBefore', 4],
      ]
    )

    const [first] = page.finds
    assert.ok(first?.anchor instanceof FakeMsgKey)
    assert.deepEqual({ ...first.anchor }, { fromMe: false, remote: page.emmaWid, id: 'ROW8' })
    assert.equal(first.anchor.remote, page.emmaWid)
  })

  it('should throw the history drift for another status or more rows than asked', async () => {
    // Arrange
    const page = fakePage()
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)
    const read = (): Promise<unknown> => page.internals.rowsAround('before', { chat, fromMe: false, id: 'ROW8' }, 2)

    // Act + Assert
    page.findAnswer.override = { status: 500, messages: [] }
    await assert.rejects(read(), (error) => error instanceof WhatsAppDriftError && error.drift === 'history')
    page.findAnswer.override = { status: 200, messages: page.rows.slice(0, 3) }
    await assert.rejects(read(), (error) => error instanceof WhatsAppDriftError && error.drift === 'history')
  })
})

describe('[service-worker] WhatsApp internals - sending', () => {
  it("should set the prepared data's t to the page's clock when stamped, and leave its id and text", async () => {
    // Arrange
    const page = fakePage()
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)
    const prepared = await page.internals.prepareText(chat, 'On my way')

    // Act
    const timestamp = page.internals.stamp(prepared)

    // Assert
    assert.deepEqual(prepared, { messageId: '3EB0PREPARED0' })
    assert.equal(timestamp, SENT_AT + 120)
    assert.deepEqual(
      [page.built[0]?.[PAGE_TIME], (page.built[0]?.id as IFakeKey | undefined)?.id, page.built[0]?.body],
      [SENT_AT + 120, '3EB0PREPARED0', 'On my way']
    )
  })

  it("should map the sender's outcomes to the extension's own results, never passing a page value on", async () => {
    // Arrange
    const page = fakePage()
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)

    const answers: (() => unknown)[] = [
      () =>
        Promise.resolve([
          Promise.resolve(),
          Promise.resolve({ messageSendResult: 'OK', [PAGE_TIME]: SENT_AT, count: 1 }),
        ]),
      () =>
        Promise.resolve([
          Promise.resolve(),
          Promise.resolve({ messageSendResult: 'ERROR_RATE_LIMIT', [PAGE_TIME]: SENT_AT }),
        ]),
      () => {
        throw new Error('Emma Lee cannot receive messages')
      },
      () => Promise.reject(new Error('Emma Lee cannot receive messages')),
      () => Promise.resolve([Promise.resolve(), Promise.reject(new Error('Emma Lee cannot receive messages'))]),
      () => Promise.resolve({ messageSendResult: 'OK' }),
      () => Promise.resolve([Promise.resolve(), 'OK']),
      () => Promise.resolve([Promise.resolve(), Promise.resolve({ messageSendResult: 0 })]),
    ]

    // Act
    const results: PageSendResult[] = []
    const handedBeforeReturn: number[] = []

    for (const answer of answers) {
      page.sendAnswer.handed = answer
      const prepared = await page.internals.prepareText(chat, 'On my way')
      const handed = page.handedOver.length
      const result = page.internals.send(chat, prepared)
      handedBeforeReturn.push(page.handedOver.length - handed)
      results.push(await result)
    }

    // Assert
    assert.deepEqual(results, [
      'ok',
      'not-ok',
      'send-rejected',
      'send-rejected',
      'result-rejected',
      'result-unreadable',
      'result-unreadable',
      'result-unreadable',
    ])

    assert.deepEqual(handedBeforeReturn, [1, 1, 1, 1, 1, 1, 1, 1])
    assert.equal(page.handedOver[0]?.[0], page.chats.get(EMMA_LEE))
    assert.equal(page.handedOver[0]?.[1], page.built[0])
  })

  it("should answer result-unreadable, never a rejection, when reading the sender's result throws", async () => {
    // Arrange
    const page = fakePage()
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)

    const answers: (() => unknown)[] = [
      () =>
        Promise.resolve([
          Promise.resolve(),
          Promise.resolve({
            get messageSendResult(): never {
              throw new Error('The page failed')
            },
          }),
        ]),
      () =>
        Promise.resolve([
          Promise.resolve(),
          {
            // A page promise whose then cannot be read is what this case sends, so the object is a thenable on purpose.
            // oxlint-disable-next-line unicorn/no-thenable
            get then(): never {
              throw new Error('The page failed')
            },
          },
        ]),
    ]

    // Act
    const results: PageSendResult[] = []

    for (const answer of answers) {
      page.sendAnswer.handed = answer
      results.push(await page.internals.send(chat, await page.internals.prepareText(chat, 'On my way')))
    }

    // Assert
    assert.deepEqual(results, ['result-unreadable', 'result-unreadable'])
    assert.equal(page.handedOver.length, 2)
  })

  it("should read the result promise's then once, answering result-unreadable when calling it throws", async () => {
    // Arrange
    const page = fakePage()
    const chat = page.internals.chat(EMMA_LEE)
    assert.ok(chat !== null)

    let thenReads = 0
    const result = {
      // A page promise whose then answers a function once and throws on a second read is what this case sends, so the
      // object is a thenable on purpose.
      // oxlint-disable-next-line unicorn/no-thenable
      get then(): () => never {
        thenReads += 1
        if (thenReads > 1) {
          throw new Error('The page failed')
        }

        return () => {
          throw new Error('The page failed')
        }
      },
    }

    page.sendAnswer.handed = () => Promise.resolve([Promise.resolve(), result])

    // Act
    const sent = await page.internals.send(chat, await page.internals.prepareText(chat, 'On my way'))

    // Assert
    assert.equal(sent, 'result-unreadable')
    assert.equal(thenReads, 1)
  })

  it('should throw the send drift for built data whose id does not read as a message id or whose time is no number', async () => {
    // Arrange
    const lowerCaseId = fakePage()
    const textTime = fakePage()
    buildingWith(lowerCaseId, (data) => ({ ...data, id: keyOf(true, lowerCaseId.emmaWid, '3eb0prepared0') }))
    buildingWith(textTime, (data) => ({ ...data, [PAGE_TIME]: String(SENT_AT) }))
    const prepare = async (page: IFakePage): Promise<unknown> => {
      const chat = page.internals.chat(EMMA_LEE)
      assert.ok(chat !== null)

      return page.internals.prepareText(chat, 'On my way')
    }

    // Act + Assert
    await assert.rejects(prepare(lowerCaseId), isDrift('send'))
    await assert.rejects(prepare(textTime), isDrift('send'))
  })

  it('should throw the send drift when the time cannot be written into the built data or does not read back', async () => {
    // Arrange
    const frozen = fakePage()
    const ignoring = fakePage()
    buildingWith(frozen, (data) => Object.freeze(data))
    buildingWith(ignoring, (data) =>
      Object.defineProperty(data, PAGE_TIME, {
        get: () => SENT_AT,
        set: () => undefined,
      })
    )

    const stampOf = async (page: IFakePage): Promise<unknown> => {
      const chat = page.internals.chat(EMMA_LEE)
      assert.ok(chat !== null)
      const prepared = await page.internals.prepareText(chat, 'On my way')

      return page.internals.stamp(prepared)
    }

    // Act + Assert
    await assert.rejects(stampOf(frozen), isDrift('send'))
    await assert.rejects(stampOf(ignoring), isDrift('send'))
  })
})

describe('[service-worker] WhatsApp internals - under the capture', () => {
  it('should turn the capture broken with collections and report no message when registering the add or the change:type listener throws at start', () => {
    // Arrange
    const onAdd = fakePage()
    const onTypeChange = fakePage()
    refusingListener(onAdd, 'add')
    refusingListener(onTypeChange, 'change:type')

    // Act
    const captures = [onAdd, onTypeChange].map((page) => {
      const captured = capturedOver(page)
      page.emit('add', { ...rowOf('NEW1'), isNewMsg: true })
      page.emit('change:type', { ...rowOf('NEW2'), isNewMsg: true })

      return captured
    })

    // Assert
    const ready = { state: 'ready', account: { wid: LEO_NOVAK }, isConnected: true, hasSynced: true }
    for (const { posts } of captures) {
      assert.deepEqual(posts, [
        { kind: 'capture', capture: ready },
        { kind: 'capture', capture: { state: 'broken', drift: 'collections' } },
      ])
    }

    assert.deepEqual(
      [onAdd, onTypeChange].map(({ listeners }) => [listeners.add?.length, listeners['change:type']?.length]),
      [
        [0, 0],
        [0, 0],
      ]
    )
  })

  it('should answer a commit broken with send and never call the sender when the built data is frozen', async () => {
    // Arrange
    const page = fakePage()
    buildingWith(page, (data) => Object.freeze(data))
    const { ask, state } = capturedOver(page)
    const account = { wid: LEO_NOVAK }
    const prepared = await ask('whatsappSendPrepare', { account, chat: EMMA_LEE, text: 'On my way' })
    const messageId: unknown = Reflect.get(prepared as object, 'messageId')

    // Act
    const answer = await ask('whatsappSendCommit', { account, chat: EMMA_LEE, messageId, token: TOKEN })

    // Assert
    assert.deepEqual(answer, { outcome: 'broken', drift: 'send' })
    assert.equal(page.handedOver.length, 0)
    assert.deepEqual(state(), { state: 'broken', drift: 'send' })
  })
})

// Every cell of the checks table (design amendment 1, S.6): what is removed or reshaped, and the need it breaks.
const CHECK_CELLS: readonly (readonly [WhatsAppNeed, string, readonly (string | number)[], unknown])[] = [
  ['collections', 'no module', ['modules', 'WAWebCollections'], undefined],
  ['collections', 'Msg', ['modules', 'WAWebCollections', 'Msg'], 'Msg'],
  ['collections', 'Chat', ['modules', 'WAWebCollections', 'Chat'], undefined],
  ['collections', 'Contact', ['modules', 'WAWebCollections', 'Contact'], undefined],
  ['collections', 'Msg.on', ['modules', 'WAWebCollections', 'Msg', 'on'], undefined],
  ['collections', 'Msg.off', ['modules', 'WAWebCollections', 'Msg', 'off'], undefined],
  ['collections', 'Msg.get', ['modules', 'WAWebCollections', 'Msg', 'get'], undefined],
  ['collections', 'Msg.getModelsArray', ['modules', 'WAWebCollections', 'Msg', 'getModelsArray'], undefined],
  ['collections', 'Chat.get', ['modules', 'WAWebCollections', 'Chat', 'get'], undefined],
  ['collections', 'Chat.getModelsArray', ['modules', 'WAWebCollections', 'Chat', 'getModelsArray'], {}],
  ['collections', 'Contact.get', ['modules', 'WAWebCollections', 'Contact', 'get'], undefined],
  ['signed-in-user', 'no module', ['modules', 'WAWebUserPrefsMeUser'], undefined],
  ['signed-in-user', 'getMaybeMeLidUser', ['modules', 'WAWebUserPrefsMeUser', 'getMaybeMeLidUser'], undefined],
  ['signed-in-user', 'getMaybeMePnUser', ['modules', 'WAWebUserPrefsMeUser', 'getMaybeMePnUser'], undefined],
  ['signed-in-user', 'a lid user that is no lid wid', ['me', 'lid'], widOf(LEO_NOVAK_PHONE)],
  ['signed-in-user', 'a lid user without its wid', ['me', 'lid', SERIALIZED], undefined],
  ['signed-in-user', 'a phone-number user that is no object', ['me', 'pn'], LEO_NOVAK_PHONE],
  ['connection', 'no Socket', ['modules', 'WAWebSocketModel', 'Socket'], undefined],
  ['connection', 'state', ['modules', 'WAWebSocketModel', 'Socket', 'state'], 2],
  ['connection', 'hasSynced', ['modules', 'WAWebSocketModel', 'Socket', 'hasSynced'], 'true'],
  ['connection', 'on', ['modules', 'WAWebSocketModel', 'Socket', 'on'], undefined],
  ['connection', 'off', ['modules', 'WAWebSocketModel', 'Socket', 'off'], undefined],
  ['message-shape', 'id.fromMe', ['messages', 0, 'id', 'fromMe'], 'false'],
  ['message-shape', 'id.id', ['messages', 0, 'id', 'id'], '3eb0a1b2c3d4e5f60718'],
  ['message-shape', 'id.remote', ['messages', 0, 'id', 'remote', SERIALIZED], undefined],
  ['message-shape', 'id.remote.isUser', ['messages', 0, 'id', 'remote', 'isUser'], undefined],
  ['message-shape', 'type', ['messages', 0, 'type'], undefined],
  ['message-shape', 't', ['messages', 0, PAGE_TIME], String(SENT_AT)],
  ['message-shape', 'isNewMsg', ['messages', 0, 'isNewMsg'], 1],
  ['message-shape', 'body of a text', ['messages', 0, 'body'], undefined],
  [
    'message-shape',
    'caption of a media message',
    ['messages', 0],
    { ...rowOf(MESSAGE_ID, { type: 'image' }), caption: 7 },
  ],
  ['chat-shape', 'id', ['firstChat', 'id', SERIALIZED], undefined],
  ['chat-shape', 'id.isUser', ['firstChat', 'id', 'isUser'], undefined],
  ['chat-shape', 'id.isGroup', ['firstChat', 'id', 'isGroup'], undefined],
  ['chat-shape', 'id.isLid', ['firstChat', 'id', 'isLid'], undefined],
  ['chat-shape', 'id.isNewsletter', ['firstChat', 'id', 'isNewsletter'], undefined],
  ['chat-shape', 'id.isBroadcast', ['firstChat', 'id', 'isBroadcast'], undefined],
  ['chat-shape', 'id.isBot', ['firstChat', 'id', 'isBot'], undefined],
  ['chat-shape', 'id.isStatus', ['firstChat', 'id', 'isStatus'], undefined],
  ['chat-shape', 'msgs.last', ['firstChat', 'msgs', 'last'], undefined],
  ['history', 'no module', ['modules', 'WAWebDBMessageFindLocal'], undefined],
  ['history', 'msgFindBefore', ['modules', 'WAWebDBMessageFindLocal', 'msgFindBefore'], undefined],
  ['history', 'msgFindAfter', ['modules', 'WAWebDBMessageFindLocal', 'msgFindAfter'], undefined],
  ['message-key', 'no constructor', ['modules', 'WAWebMsgKey'], { fromString: () => undefined }],
  ['message-key', 'fromString', ['modules', 'WAWebMsgKey', 'fromString'], undefined],
  ['contact', 'no module', ['modules', 'WAWebContactGetters'], undefined],
  ['contact', 'getName', ['modules', 'WAWebContactGetters', 'getName'], undefined],
  ['contact', 'getPushname', ['modules', 'WAWebContactGetters', 'getPushname'], undefined],
  ['contact', 'getIsMe', ['modules', 'WAWebContactGetters', 'getIsMe'], undefined],
  ['send', 'createTextMsgData', ['modules', 'WAWebSendTextMsgChatAction', 'createTextMsgData'], undefined],
  ['send', 'addAndSendMsgToChat', ['modules', 'WAWebSendMsgChatAction', 'addAndSendMsgToChat'], undefined],
  ['clock', 'no module', ['modules', 'WATimeUtils'], undefined],
  ['clock', 'unixTime', ['modules', 'WATimeUtils', 'unixTime'], undefined],
  ['clock', 'a clock that is no whole number', ['clock', 'now'], SENT_AT + 0.5],
]

describe('[service-worker] WhatsApp internals - checks', () => {
  it("should answer each need's drift code when one of its modules, functions or fields is missing or of another type", () => {
    // Arrange
    const pageWithSamples = (): IFakePage & { readonly firstChat: unknown } => {
      const page = fakePage()
      page.messages.push({ ...rowOf(MESSAGE_ID), isNewMsg: undefined })

      return { ...page, firstChat: page.chats.get(EMMA_LEE) }
    }

    const healthy = pageWithSamples()

    // Act
    const healthyChecks = WHATSAPP_NEEDS.map((need) => healthy.internals.check(need))
    const cells = CHECK_CELLS.map(([need, cell, path, value]) => {
      const page = pageWithSamples()
      setAt(page, path, value)

      return [need, cell, page.internals.check(need)]
    })

    // Assert
    assert.deepEqual(
      healthyChecks,
      WHATSAPP_NEEDS.map(() => null)
    )

    assert.deepEqual(
      cells,
      CHECK_CELLS.map(([need, cell]) => [need, cell, need])
    )
  })

  it('should pass the sample checks of a page that holds no message and no chat', () => {
    // Arrange
    const page = fakePage()
    page.chats.clear()

    // Act
    const checks = WHATSAPP_NEEDS.map((need) => page.internals.check(need))

    // Assert
    assert.deepEqual(
      checks,
      WHATSAPP_NEEDS.map(() => null)
    )
  })
})
