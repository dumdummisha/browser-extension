import {
  LID_USER_WID_PATTERN,
  MESSAGE_ID_PATTERN,
  WHATSAPP_MESSAGE_TYPES,
  WHATSAPP_TEXT_TYPE,
} from '../protocol/whatsapp-fields.js'
import { type WhatsAppDrift } from '../protocol/whatsapp.js'

// The only file that names one of WhatsApp Web's modules, functions or fields. It runs in the page's own world, bundled
// into the WhatsApp observer, and lives with the extension's modules the tests load, as capture-handshake.ts does. Each
// need is one function over the page's internals that answers plain values, with a shape check of its own, so a
// WhatsApp update that renames or reshapes an internal breaks one need here and is reported as that need's drift. The
// names and shapes come from what was observed in a real WhatsApp Web tab (design U2, spike facts and probes P1 to P13,
// U2-R16), never from a guess: a missing or reshaped internal is drift, never a reason to try another.
//
// The built-ins this file uses are taken when the module loads, at document_start, so a page script that replaces one
// later changes nothing here; page scripts are out of scope (observer.ts).
const { apply, construct, set: setValue } = Reflect
const { isArray } = Array
const { isSafeInteger } = Number
const execPattern = RegExp.prototype.exec
const NativePromise = Promise
const NativeWeakMap = WeakMap
const weakGet = WeakMap.prototype.get
const weakSet = WeakMap.prototype.set

// What the observer needs from the page, each checked as a need of its own, in this order (design S.6). Each is the
// drift code of the same name; no-module-system and no-lid-user are drift codes the capture reports itself.
export const WHATSAPP_NEEDS = [
  'collections',
  'signed-in-user',
  'connection',
  'message-shape',
  'chat-shape',
  'history',
  'message-key',
  'contact',
  'send',
  'clock',
] as const satisfies readonly WhatsAppDrift[]

export type WhatsAppNeed = (typeof WHATSAPP_NEEDS)[number]

// A need's internal is missing or reshaped. The message names the need, never the page's own error text, which could
// quote content.
export class WhatsAppDriftError extends Error {
  constructor(public readonly drift: WhatsAppNeed) {
    super(`WhatsApp Web's internals for ${drift} are missing or reshaped`)
    this.name = 'WhatsAppDriftError'
  }
}

// A database row or a message, reduced to what a history read keeps. timestamp: the page's time of the message, in unix
// seconds. text: body for chat, the caption for a media type (empty when it has none), never a media message's body;
// empty for a type that is not reported, whose fields are not read.
export interface IPageRow {
  readonly id: string
  readonly fromMe: boolean
  readonly type: string
  readonly timestamp: number
  readonly text: string
}

// A message as the page adds it: a row of the chat keyed by the key's remote wid. isDirect: that wid is a person's
// one-to-one chat (isUser and none of isGroup, isBroadcast, isNewsletter, isStatus, isBot); the internals project only
// such a message, since nothing past the chat of any other is read (U2-R66). isNewMsg: the message's isNewMsg is true
// (U2-R14; P3 and P5: a loaded or synced message has it undefined).
export interface IPageMessage extends IPageRow {
  readonly chat: string
  readonly isDirect: boolean
  readonly isNewMsg: boolean
}

// A chat the page holds: its own wid and whether it is direct. The page's chat object stays in this file.
export interface IPageChat {
  readonly wid: string
  readonly isDirect: boolean
}

// A message key as the internals read it: the chat it belongs to, whether the owner sent it, and its own id (key.id,
// never the key's toString, which adds _out to an outgoing key).
export interface IRowKey {
  readonly chat: IPageChat
  readonly fromMe: boolean
  readonly id: string
}

// What createTextMsgData built: its key's own id. The data itself stays in this file, where only stamp and send read
// it. The prepare's answer carries no time (U2-R4).
export interface IPreparedText {
  readonly messageId: string
}

// What a send came to, in the extension's own terms: no value the page answered leaves this file (U2-R22).
export type PageSendResult = 'ok' | 'not-ok' | 'send-rejected' | 'result-rejected' | 'result-unreadable'

// What the observer reads and does in the page, each as one function over one of WhatsApp's internals. Every function
// answers plain values; no page object and no page value outside these shapes leaves this file. A function whose
// internal is missing or reshaped throws WhatsAppDriftError with that need's code.
export interface IWhatsAppInternals {
  // Each need's shape check: null when every module, function and field the need uses is there with the type it
  // expects, else the need's own code. The two sample needs (message-shape, chat-shape) check one message and one chat
  // when the page holds one, a message of a chat that is not direct only as far as its chat; the page checks every
  // message and chat it hands on in the same way, so a page that held none at start checks the first one before it is
  // used.
  readonly check: (need: WhatsAppNeed) => WhatsAppNeed | null
  // WAWebUserPrefsMeUser: the signed-in lid wid, null when getMaybeMeLidUser answers null or undefined, and whether
  // getMaybeMePnUser answers a user (neither null nor undefined). U2-R16: a signed-out page answers null and undefined.
  readonly signedIn: () => { readonly lid: string | null; readonly hasPnUser: boolean }
  // WAWebSocketModel.Socket: state === 'CONNECTED' (P10), and hasSynced === true (U2-R16: undefined before any sync).
  readonly connection: () => { readonly isConnected: boolean; readonly hasSynced: boolean }
  // WAWebSocketModel.Socket change:state and change:hasSynced (P10).
  readonly onConnectionChange: (listener: () => void) => void
  // WAWebCollections.Msg add and change:type: each message of a direct chat as the page has it, projected. Its chat is
  // read first; a message of any other chat goes nowhere, and nothing of it but its chat's wid is read (U2-R66). A
  // message that does not read as the message-shape need expects goes to onDrift instead, with that code. Answers the
  // function that removes both listeners (Msg.off).
  readonly onMessage: (listener: (message: IPageMessage) => void, onDrift: (drift: WhatsAppNeed) => void) => () => void
  // WAWebCollections.Chat.get(wid): the chat in the page's chat list, or null. A chat that does not read as the
  // chat-shape need expects throws that drift.
  readonly chat: (wid: string) => IPageChat | null
  // chat.msgs.last(): the chat's newest message, projected, or null when it has none (P3, P7).
  readonly newest: (chat: IPageChat) => IPageRow | null
  // WAWebDBMessageFindLocal.msgFindBefore or msgFindAfter, by direction, around the key built with WAWebMsgKey from
  // key.fromMe, the wid of key.chat as the page holds it, and key.id (P8): at most count rows strictly before or after
  // the key, oldest first, the ones nearest it (P7, P13), projected. null when the database does not hold the key (P8b:
  // status 404). Any status other than 200 or 404, or more rows than count, throws the history drift.
  readonly rowsAround: (
    direction: 'before' | 'after',
    key: IRowKey,
    count: number
  ) => Promise<readonly IPageRow[] | null>
  // WAWebCollections.Contact.get(wid) and WAWebContactGetters getName, getPushname, getIsMe (U2-R3): the saved name,
  // else the push name, else none, and whether the contact is the signed-in user; null when the page knows no contact
  // with that wid.
  readonly contact: (wid: string) => { readonly name: string | null; readonly isMe: boolean } | null
  // WAWebSendTextMsgChatAction.createTextMsgData(chat, text, {}): the message's data, kept here.
  readonly prepareText: (chat: IPageChat, text: string) => Promise<IPreparedText>
  // WATimeUtils.unixTime(): sets the prepared data's t to the page's clock now and answers it (U2-R4). A write that
  // throws, is refused, or does not read back as that time throws the send drift (U2-R55): the sender would send the
  // data with another time than the one answered.
  readonly stamp: (prepared: IPreparedText) => number
  // WAWebSendMsgChatAction.addAndSendMsgToChat(chat, data), called before send returns, with nothing asynchronous
  // before it: what the send came to. It never rejects: a throw or a rejection of the sender is send-rejected, a
  // rejection of the result promise result-rejected, a messageSendResult of exactly 'OK' is ok and any other string
  // not-ok, and anything else (no array, no promise as its second element, a result without a string
  // messageSendResult, a read of the answer or a call of its then that throws) result-unreadable (U2-R58, U2-R60).
  readonly send: (chat: IPageChat, prepared: IPreparedText) => Promise<PageSendResult>
}

// The page's module system: window.require, which answers a module by name and throws for one it does not hold.
export type PageRequire = (name: string) => unknown

type PageObject = Record<string, unknown>

// What the page's socket model reads as connected; it exports no enum of its state names (P10).
const CONNECTED_STATE = 'CONNECTED'
// The send result the page's sender answers for a message the server took (spike fact).
const SEND_OK = 'OK'
// What the page's database read answers for a key it holds and for one it does not (P8b).
const FOUND_STATUS = 200
const NOT_FOUND_STATUS = 404
// The page's name for a wid's serialised form, <user>@<server> (spike fact).
const SERIALIZED = '_serialized'
// The page's name for a message's time, in unix seconds, on a message, a database row and built data (P11, spike fact).
const PAGE_TIME = 't'

const drifted = (need: WhatsAppNeed): never => {
  throw new WhatsAppDriftError(need)
}

const isNullish = (value: unknown): value is null | undefined => value === null || value === undefined

const isPageObject = (value: unknown): value is PageObject =>
  (typeof value === 'object' && value !== null) || typeof value === 'function'

const objectAt = (value: unknown, need: WhatsAppNeed): PageObject => (isPageObject(value) ? value : drifted(need))

const stringAt = (value: unknown, need: WhatsAppNeed): string => (typeof value === 'string' ? value : drifted(need))

const booleanAt = (value: unknown, need: WhatsAppNeed): boolean => (typeof value === 'boolean' ? value : drifted(need))

const matching = (pattern: RegExp, value: unknown, need: WhatsAppNeed): string => {
  const text = stringAt(value, need)
  if (apply(execPattern, pattern, [text]) === null) {
    return drifted(need)
  }

  return text
}

const functionAt = (owner: PageObject, name: string, need: WhatsAppNeed): CallableFunction => {
  const value = owner[name]
  if (typeof value !== 'function') {
    return drifted(need)
  }

  return value
}

// Calls owner's method name with owner as this, as the page itself calls it.
const callAt = (owner: PageObject, name: string, args: readonly unknown[], need: WhatsAppNeed): unknown =>
  apply(functionAt(owner, name, need), owner, args)

const hasFunctions = (owner: PageObject, names: readonly string[], need: WhatsAppNeed): void => {
  for (const name of names) {
    functionAt(owner, name, need)
  }
}

// Whether a wid is a person's one-to-one chat: isUser and none of the other kinds (spike fact; P1).
const isDirectWid = (wid: PageObject, need: WhatsAppNeed): boolean => {
  const is = (name: string): boolean => booleanAt(callAt(wid, name, [], need), need)

  return is('isUser') && !is('isGroup') && !is('isBroadcast') && !is('isNewsletter') && !is('isStatus') && !is('isBot')
}

const isReportedType = (type: string): boolean => WHATSAPP_MESSAGE_TYPES.some((reported) => reported === type)

// A message's text (U2-R12): a text's body, a reported media message's caption or '' when it has none, and never a
// media message's body, which holds encoded data (P4). A type that is not reported has its fields left unread.
const textOf = (model: PageObject, type: string, need: WhatsAppNeed): string => {
  if (type === WHATSAPP_TEXT_TYPE) {
    return stringAt(model.body, need)
  }

  if (!isReportedType(type)) {
    return ''
  }

  return model.caption === undefined ? '' : stringAt(model.caption, need)
}

// A message model or a database row, by its key (a MsgKey: fromMe, id, remote; P2, P7), type and time (P11).
const rowOf = (model: PageObject, need: WhatsAppNeed): IPageRow => {
  const key = objectAt(model.id, need)
  const type = stringAt(model.type, need)
  const timestamp = model[PAGE_TIME]
  if (typeof timestamp !== 'number') {
    return drifted(need)
  }

  return {
    id: matching(MESSAGE_ID_PATTERN, key.id, need),
    fromMe: booleanAt(key.fromMe, need),
    type,
    timestamp,
    text: textOf(model, type, need),
  }
}

// A message as the page adds it, or null for a message of a chat that is not direct (U2-R66). Its chat is read first,
// through the key's remote wid and that wid's own predicates; nothing else of a message of another chat is read, not
// even its own id, so a group's or a channel's message never reaches the row's reads below.
const pageMessageOf = (value: unknown): IPageMessage | null => {
  const model = objectAt(value, 'message-shape')
  const remote = objectAt(objectAt(model.id, 'message-shape').remote, 'message-shape')
  const chat = stringAt(remote[SERIALIZED], 'message-shape')
  if (!isDirectWid(remote, 'message-shape')) {
    return null
  }

  const row = rowOf(model, 'message-shape')
  if (model.isNewMsg !== undefined) {
    booleanAt(model.isNewMsg, 'message-shape')
  }

  return { ...row, chat, isDirect: true, isNewMsg: model.isNewMsg === true }
}

const CHAT_WID_PREDICATES = ['isUser', 'isGroup', 'isLid', 'isNewsletter', 'isBroadcast', 'isBot', 'isStatus']

// Reads the internals of the page whose module system require is. Nothing is read until a function is called, and each
// call reads its modules again, so a module the page replaced is the one checked.
export const whatsappInternalsOf = (require: PageRequire): IWhatsAppInternals => {
  const pageChats = new NativeWeakMap<IPageChat, PageObject>()
  const pageData = new NativeWeakMap<IPreparedText, PageObject>()

  const moduleAt = (name: string, need: WhatsAppNeed): PageObject => {
    let page: unknown

    try {
      page = require(name)
    } catch {
      return drifted(need)
    }

    return objectAt(page, need)
  }

  const collections = (): {
    readonly messages: PageObject
    readonly chats: PageObject
    readonly contacts: PageObject
  } => {
    const page = moduleAt('WAWebCollections', 'collections')
    const messages = objectAt(page.Msg, 'collections')
    const chats = objectAt(page.Chat, 'collections')
    const contacts = objectAt(page.Contact, 'collections')
    hasFunctions(messages, ['on', 'off', 'get', 'getModelsArray'], 'collections')
    hasFunctions(chats, ['get', 'getModelsArray'], 'collections')
    hasFunctions(contacts, ['get'], 'collections')

    return { messages, chats, contacts }
  }

  const socket = (): PageObject => {
    const page = objectAt(moduleAt('WAWebSocketModel', 'connection').Socket, 'connection')
    stringAt(page.state, 'connection')
    if (page.hasSynced !== undefined) {
      booleanAt(page.hasSynced, 'connection')
    }

    hasFunctions(page, ['on', 'off'], 'connection')

    return page
  }

  const firstOf = (collection: PageObject): unknown => {
    const models = callAt(collection, 'getModelsArray', [], 'collections')
    if (!isArray(models)) {
      return drifted('collections')
    }

    const first: unknown = models[0]

    return first
  }

  // A chat the page holds, as a handle that carries the page's chat object here only.
  const chatOf = (value: unknown): IPageChat => {
    const page = objectAt(value, 'chat-shape')
    const wid = objectAt(page.id, 'chat-shape')
    hasFunctions(wid, CHAT_WID_PREDICATES, 'chat-shape')
    hasFunctions(objectAt(page.msgs, 'chat-shape'), ['last'], 'chat-shape')
    const chat = { wid: stringAt(wid[SERIALIZED], 'chat-shape'), isDirect: isDirectWid(wid, 'chat-shape') }
    apply(weakSet, pageChats, [chat, page])

    return chat
  }

  const pageChatOf = (chat: IPageChat): PageObject => {
    const page: unknown = apply(weakGet, pageChats, [chat])
    if (!isPageObject(page)) {
      throw new Error('A WhatsApp chat handle was not made by these internals')
    }

    return page
  }

  const pageDataOf = (prepared: IPreparedText): PageObject => {
    const data: unknown = apply(weakGet, pageData, [prepared])
    if (!isPageObject(data)) {
      throw new Error('A prepared WhatsApp message was not made by these internals')
    }

    return data
  }

  // WAWebMsgKey is the key's constructor itself, with fromString beside it (P3).
  const messageKey = (): CallableFunction => {
    const page = moduleAt('WAWebMsgKey', 'message-key')
    if (typeof page !== 'function') {
      return drifted('message-key')
    }

    functionAt(page, 'fromString', 'message-key')

    return page
  }

  const messageFinder = (): PageObject => {
    const page = moduleAt('WAWebDBMessageFindLocal', 'history')
    hasFunctions(page, ['msgFindBefore', 'msgFindAfter'], 'history')

    return page
  }

  const contactGetters = (): PageObject => {
    const page = moduleAt('WAWebContactGetters', 'contact')
    hasFunctions(page, ['getName', 'getPushname', 'getIsMe'], 'contact')

    return page
  }

  const textBuilder = (): PageObject => {
    const page = moduleAt('WAWebSendTextMsgChatAction', 'send')
    hasFunctions(page, ['createTextMsgData'], 'send')

    return page
  }

  const sender = (): PageObject => {
    const page = moduleAt('WAWebSendMsgChatAction', 'send')
    hasFunctions(page, ['addAndSendMsgToChat'], 'send')

    return page
  }

  const clockNow = (): number => {
    const now = callAt(moduleAt('WATimeUtils', 'clock'), 'unixTime', [], 'clock')
    if (typeof now !== 'number' || !isSafeInteger(now)) {
      return drifted('clock')
    }

    return now
  }

  const signedIn = (): { readonly lid: string | null; readonly hasPnUser: boolean } => {
    const page = moduleAt('WAWebUserPrefsMeUser', 'signed-in-user')
    const lidUser = callAt(page, 'getMaybeMeLidUser', [], 'signed-in-user')
    const pnUser = callAt(page, 'getMaybeMePnUser', [], 'signed-in-user')
    if (!isNullish(pnUser)) {
      objectAt(pnUser, 'signed-in-user')
    }

    return {
      lid: isNullish(lidUser)
        ? null
        : matching(LID_USER_WID_PATTERN, objectAt(lidUser, 'signed-in-user')[SERIALIZED], 'signed-in-user'),
      hasPnUser: !isNullish(pnUser),
    }
  }

  const checks: Readonly<Record<WhatsAppNeed, () => void>> = {
    collections,
    'signed-in-user': signedIn,
    'connection': socket,
    'message-shape': () => {
      const sample = firstOf(collections().messages)
      if (sample !== undefined) {
        pageMessageOf(sample)
      }
    },
    'chat-shape': () => {
      const sample = firstOf(collections().chats)
      if (sample !== undefined) {
        chatOf(sample)
      }
    },
    'history': messageFinder,
    'message-key': messageKey,
    'contact': contactGetters,
    'send': () => {
      textBuilder()
      sender()
    },
    'clock': clockNow,
  }

  // The page's answer to a database read, row by row (P7, P8b): status 200 with at most count rows, or 404.
  const rowsOf = (answer: unknown, count: number): readonly IPageRow[] | null => {
    const read = objectAt(answer, 'history')
    if (read.status === NOT_FOUND_STATUS) {
      return null
    }

    const rows = read.messages
    if (read.status !== FOUND_STATUS || !isArray(rows) || rows.length > count) {
      return drifted('history')
    }

    return rows.map((row: unknown) => rowOf(objectAt(row, 'history'), 'history'))
  }

  // The page's send result read once, as ok or not-ok, or null when it is no string.
  const sentOf = (outcome: unknown): PageSendResult | null => {
    const sent = isPageObject(outcome) ? outcome.messageSendResult : undefined
    if (typeof sent !== 'string') {
      return null
    }

    return sent === SEND_OK ? 'ok' : 'not-ok'
  }

  // What the sender's answer came to, once it handed the message over (spike fact: [Promise, Promise], the second
  // resolving { messageSendResult, t, count }). Every read of the answer is a read of a page value whose getter may
  // throw, so each one is inside the mapping: the message is already handed over, and its answer is unconfirmed,
  // never a rejection. The second promise's then is read once and called here, since await would read it again and
  // take a throw from that second read for the promise's own rejection (U2-R60).
  const sendResultOf = (handed: unknown): Promise<PageSendResult> =>
    new NativePromise((settle) => {
      let result: unknown
      let then: unknown

      try {
        result = isArray(handed) ? handed[1] : undefined
        then = isPageObject(result) ? result.then : undefined
      } catch {
        settle('result-unreadable')
        return
      }

      if (typeof then !== 'function') {
        settle('result-unreadable')
        return
      }

      const fulfilled = (outcome: unknown): void => {
        try {
          settle(sentOf(outcome) ?? 'result-unreadable')
        } catch {
          settle('result-unreadable')
        }
      }

      const rejected = (): void => {
        settle('result-rejected')
      }

      try {
        apply(then, result, [fulfilled, rejected])
      } catch {
        settle('result-unreadable')
      }
    })

  // Whether the commit's time is in the data the sender is handed: the write's own answer and the value read back.
  const isTimeWritten = (data: PageObject, timestamp: number): boolean => {
    try {
      return setValue(data, PAGE_TIME, timestamp) && data[PAGE_TIME] === timestamp
    } catch {
      return false
    }
  }

  return {
    check: (need) => {
      try {
        checks[need]()

        return null
      } catch {
        return need
      }
    },
    signedIn,
    connection: () => {
      const page = socket()

      return { isConnected: page.state === CONNECTED_STATE, hasSynced: page.hasSynced === true }
    },
    onConnectionChange: (listener) => {
      const page = socket()
      callAt(page, 'on', ['change:state', listener], 'connection')
      callAt(page, 'on', ['change:hasSynced', listener], 'connection')
    },
    onMessage: (listener, onDrift) => {
      const { messages } = collections()

      // The page calls a collection's listener with the model first (P5).
      const onPageMessage = (model: unknown): void => {
        let message: IPageMessage | null

        try {
          message = pageMessageOf(model)
        } catch (error) {
          onDrift(error instanceof WhatsAppDriftError ? error.drift : 'message-shape')

          return
        }

        if (message !== null) {
          listener(message)
        }
      }

      callAt(messages, 'on', ['add', onPageMessage], 'collections')

      try {
        callAt(messages, 'on', ['change:type', onPageMessage], 'collections')
      } catch (error) {
        // The capture gets no function to remove a listener when registering throws, so the one already registered is
        // removed here.
        callAt(messages, 'off', ['add', onPageMessage], 'collections')

        throw error
      }

      return () => {
        callAt(messages, 'off', ['add', onPageMessage], 'collections')
        callAt(messages, 'off', ['change:type', onPageMessage], 'collections')
      }
    },
    chat: (wid) => {
      const page = callAt(collections().chats, 'get', [wid], 'collections')

      return isNullish(page) ? null : chatOf(page)
    },
    newest: (chat) => {
      const last = callAt(objectAt(pageChatOf(chat).msgs, 'chat-shape'), 'last', [], 'chat-shape')

      return isNullish(last) ? null : rowOf(objectAt(last, 'message-shape'), 'message-shape')
    },
    rowsAround: async (direction, key, count) => {
      const anchor: unknown = construct(messageKey(), [
        { fromMe: key.fromMe, remote: pageChatOf(key.chat).id, id: key.id },
      ])

      const find = direction === 'before' ? 'msgFindBefore' : 'msgFindAfter'
      const answer: unknown = await callAt(messageFinder(), find, [{ anchor, count }], 'history')

      return rowsOf(answer, count)
    },
    contact: (wid) => {
      const page = callAt(collections().contacts, 'get', [wid], 'collections')
      if (isNullish(page)) {
        return null
      }

      const getters = contactGetters()
      const nameOf = (getter: string): string | null => {
        const name = callAt(getters, getter, [page], 'contact')
        if (isNullish(name) || name === '') {
          return null
        }

        return stringAt(name, 'contact')
      }

      return {
        name: nameOf('getName') ?? nameOf('getPushname'),
        isMe: booleanAt(callAt(getters, 'getIsMe', [page], 'contact'), 'contact'),
      }
    },
    prepareText: async (chat, text) => {
      const built: unknown = await callAt(textBuilder(), 'createTextMsgData', [pageChatOf(chat), text, {}], 'send')
      const data = objectAt(built, 'send')
      const messageId = matching(MESSAGE_ID_PATTERN, objectAt(data.id, 'send').id, 'send')
      if (typeof data[PAGE_TIME] !== 'number') {
        return drifted('send')
      }

      const prepared = { messageId }
      apply(weakSet, pageData, [prepared, data])

      return prepared
    },
    stamp: (prepared) => {
      const data = pageDataOf(prepared)
      const timestamp = clockNow()
      if (!isTimeWritten(data, timestamp)) {
        return drifted('send')
      }

      return timestamp
    },
    send: async (chat, prepared) => {
      let handed: unknown

      try {
        handed = await callAt(sender(), 'addAndSendMsgToChat', [pageChatOf(chat), pageDataOf(prepared)], 'send')
      } catch {
        return 'send-rejected'
      }

      return sendResultOf(handed)
    },
  }
}
