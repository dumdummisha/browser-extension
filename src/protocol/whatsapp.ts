import { z } from 'zod'
import { EVENT_ID_MAX_LENGTH, EventIdSchema } from './event-id.js'
import {
  DIRECT_CHAT_WID_PATTERN,
  LID_USER_WID_PATTERN,
  MESSAGE_ID_PATTERN,
  WHATSAPP_MESSAGE_TYPES,
} from './whatsapp-fields.js'

// The WhatsApp half of the protocol: who a WhatsApp Web tab is signed in as, what its observer reports, and what the
// app may ask the extension to do there. The scope is a person's one-to-one chats and their text: groups, channels,
// broadcasts, status updates and bots never leave the page. Every call names the account it acts as, and the extension
// acts only in a tab signed in as that account. WhatsApp's internal names never appear here: the page's observer maps
// them to these shapes (service-worker whatsapp-internals.ts), so a WhatsApp update changes that file, not the wire.

const ACCOUNT_ID_PATTERN = /^whatsapp:(?<wid>\d+@lid)$/u

export const DirectChatWidSchema = z.string().regex(DIRECT_CHAT_WID_PATTERN)

// A message id longer than a whole event id can never be part of an event, so the event id's maximum bounds it
// (U2-R15).
export const WhatsAppMessageIdSchema = z.string().regex(MESSAGE_ID_PATTERN).max(EVENT_ID_MAX_LENGTH)

export const WhatsAppAccountSchema = z.strictObject({ wid: z.string().regex(LID_USER_WID_PATTERN) })

export type WhatsAppAccount = z.infer<typeof WhatsAppAccountSchema>

// The account's key everywhere: the signed-in user's lid wid. There is no fallback to the phone-number wid: a page
// that gives no lid user is a broken capture (WhatsAppDriftSchema no-lid-user), never another key for the same person.
export const whatsappAccountId = ({ wid }: WhatsAppAccount): string => `whatsapp:${wid}`

export const parseWhatsAppAccountId = (accountId: string): WhatsAppAccount => {
  const wid = ACCOUNT_ID_PATTERN.exec(accountId)?.groups?.wid
  if (wid === undefined) {
    throw new Error(`${accountId} is not a WhatsApp account id (whatsapp:<digits>@lid)`)
  }

  return { wid }
}

export const WhatsAppMessageTypeSchema = z.enum(WHATSAPP_MESSAGE_TYPES)

// A message as the extension reports it, in an event and in a chat's history. chat is the chat's wid, which is also
// the other person's (or the account's own, in the chat with oneself); the author is the account when fromMe, else the
// chat. timestamp: when the sending client created it, in unix seconds, as the page stores it. text: a text message's
// body, a media message's caption, empty when it has none (whatsapp-fields.ts WHATSAPP_TEXT_TYPE).
export const WhatsAppMessageSchema = z.strictObject({
  chat: DirectChatWidSchema,
  id: WhatsAppMessageIdSchema,
  timestamp: z.number().int().nonnegative(),
  fromMe: z.boolean(),
  type: WhatsAppMessageTypeSchema,
  text: z.string(),
})

export type WhatsAppMessage = z.infer<typeof WhatsAppMessageSchema>

// Two tabs signed in as one account see the same message: its key is the account, the chat and the message's own id,
// which no other message of that chat shares. The key is also the event's id on the wire.
export const whatsappEventKey = (account: WhatsAppAccount, message: Pick<WhatsAppMessage, 'chat' | 'id'>): string =>
  `${whatsappAccountId(account)}/${message.chat}/${message.id}`

// An event the extension holds until the app acknowledges it, which the app does only once it has committed it.
export const WhatsAppEventSchema = z
  .strictObject({
    type: z.literal('event'),
    id: EventIdSchema,
    account: WhatsAppAccountSchema,
    message: WhatsAppMessageSchema,
  })
  .refine((event) => event.id === whatsappEventKey(event.account, event.message), {
    message: "An event's id must be its dedupe key",
    path: ['id'],
  })

export type WhatsAppEvent = z.infer<typeof WhatsAppEventSchema>

// The random id an observer makes when it starts (U2-R26). The prepare's answer carries it, the commit names it, and
// the service worker hands the commit only to the document whose observer reported it, the one page that holds the
// prepared message.
export const ObserverTokenSchema = z.uuid()

// Which of the page's internals the observer found missing or reshaped, one code per need it uses
// (service-worker whatsapp-internals.ts). A code names the need, never the page's own error text, which could quote
// content.
export const WhatsAppDriftSchema = z.enum([
  'no-module-system',
  'collections',
  'signed-in-user',
  'no-lid-user',
  'connection',
  'message-shape',
  'chat-shape',
  'history',
  'message-key',
  'contact',
  'send',
  'clock',
])

export type WhatsAppDrift = z.infer<typeof WhatsAppDriftSchema>

// How the observer in a tab stands, as it reports itself:
// - loading: the page's module system or its stores are not there yet; nothing is captured
// - signed-out: the stores are there and no user is signed in (the page shows its link-a-device code)
// - ready: signed in as account, and every internal the observer uses passed its check. isConnected: the page's own
//   connection to WhatsApp is up; while it is not, nothing the app sends would leave. hasSynced: the page finished its
//   sync after load.
// - broken: an internal the observer uses is missing or reshaped (drift); nothing is captured or sent until the page
//   loads again with an observer that reads it: after WhatsApp Web changes back, or after the extension was updated
//   and the tab was reloaded (an open page keeps the observer it loaded with)
export const WhatsAppCaptureSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('loading') }),
  z.strictObject({ state: z.literal('signed-out') }),
  z.strictObject({
    state: z.literal('ready'),
    account: WhatsAppAccountSchema,
    isConnected: z.boolean(),
    hasSynced: z.boolean(),
  }),
  z.strictObject({ state: z.literal('broken'), drift: WhatsAppDriftSchema }),
])

export type WhatsAppCapture = z.infer<typeof WhatsAppCaptureSchema>

const TabIdSchema = z.number().int()

// One open WhatsApp Web tab in the status: its observer's report, or detached when no observer reports there (a tab
// opened before the extension loaded), or failed when what its observer sent did not read at the relay (error says
// what, in the relay's words). The app derives its adapter's state from these: ready and connected is connected;
// signed-out needs sign-in; broken and failed are a broken capture; ready but not connected, loading, detached or no
// tab is disconnected; a ready account other than the one the app set up is an identity change.
export const WhatsAppTabStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ tabId: TabIdSchema, state: z.literal('detached') }),
  z.strictObject({ tabId: TabIdSchema, state: z.literal('failed'), error: z.string().min(1) }),
  z.strictObject({ tabId: TabIdSchema, state: z.literal('loading') }),
  z.strictObject({ tabId: TabIdSchema, state: z.literal('signed-out') }),
  z.strictObject({
    tabId: TabIdSchema,
    state: z.literal('ready'),
    account: WhatsAppAccountSchema,
    isConnected: z.boolean(),
    hasSynced: z.boolean(),
  }),
  z.strictObject({ tabId: TabIdSchema, state: z.literal('broken'), drift: WhatsAppDriftSchema }),
])

export type WhatsAppTabStatus = z.infer<typeof WhatsAppTabStatusSchema>

// Why a command did nothing. Every refusal means nothing left the page for WhatsApp. Every refusal but one also
// means nothing was kept there: a prepare answered no-whatsapp-tab because its page went away after it was handed the
// preparation may have left the built message in that page. Such a message is never sent and goes as U2-R47 says.
// - no-whatsapp-tab: no open tab on web.whatsapp.com holds a page the extension recorded as ready as the account, or
//   Chrome refused the command pinned to the recorded page (service worker whatsapp-tabs.ts). The extension then asks
//   the open WhatsApp tabs again, so a page that is there is recorded for the next attempt.
// - other-account: the page is not signed in as the account by the time the command ran
// - not-connected: the page's connection is down, so a message would wait in the page instead of going out
// - no-chat: the page's chat list has no chat with that wid; the extension never creates one
// - not-direct-chat: the wid is not a person's one-to-one chat
// - chat-mismatch: the chat the page found under the wid is keyed by another wid, or a commit names another chat than
//   its prepare did
// - unknown-message: no message prepared for the account is held under that id in the page the token names: never
//   prepared there, older than the commit window, already committed, or cleared when the page's account changed; or
//   no open tab holds a recorded page with that token, or that page did not answer as the page its tab shows right
//   before the hand-off (service worker whatsapp-tabs.ts). The commit was not handed to any page.
// - unknown-anchor: the history anchor is not in the page's local database, or, for the newest read, the chat's newest
//   message is not in it yet (it arrived a moment ago)
// - unknown-contact: the page knows no contact with that wid
// - deadline-passed: the caller's deadline passed before the page acted
// - page-failed: a commit's page call failed before the hand-off while every internal it uses still checks out
export const WHATSAPP_REFUSALS = [
  'no-whatsapp-tab',
  'other-account',
  'not-connected',
  'no-chat',
  'not-direct-chat',
  'chat-mismatch',
  'unknown-message',
  'unknown-anchor',
  'unknown-contact',
  'deadline-passed',
  'page-failed',
] as const

export const WhatsAppRefusalSchema = z.enum(WHATSAPP_REFUSALS)

export type WhatsAppRefusal = z.infer<typeof WhatsAppRefusalSchema>

// Why a commit that handed its message to the page's sender cannot say it was sent (U2-R22). The extension's own
// codes: no value the page answered leaves it.
// - send-rejected: the sender threw or its promise rejected
// - result-rejected: the send's result promise rejected
// - result-not-ok: the send's result was not the page's OK
// - result-unreadable: the sender answered a shape the observer does not read (also reported as the send drift)
export const WHATSAPP_UNCONFIRMED = ['send-rejected', 'result-rejected', 'result-not-ok', 'result-unreadable'] as const

export const WhatsAppUnconfirmedSchema = z.enum(WHATSAPP_UNCONFIRMED)

export type WhatsAppUnconfirmed = z.infer<typeof WhatsAppUnconfirmedSchema>

// The answers every method shares besides its own success, each given only before anything was handed to WhatsApp:
// refused (refusal says why) or broken (an internal the method needs failed its check; the capture is broken with that
// drift).
const refused = <TRefusal extends WhatsAppRefusal>(
  refusals: readonly [TRefusal, ...TRefusal[]]
): z.ZodObject<
  {
    outcome: z.ZodLiteral<'refused'>
    refusal: ReturnType<typeof WhatsAppRefusalSchema.extract<readonly [TRefusal, ...TRefusal[]]>>
  },
  z.core.$strict
> => z.strictObject({ outcome: z.literal('refused'), refusal: WhatsAppRefusalSchema.extract(refusals) })

const BrokenSchema = z.strictObject({ outcome: z.literal('broken'), drift: WhatsAppDriftSchema })

// Where a history read starts: the message with that id, as the page's database finds it by its key (fromMe, the
// chat's wid and the id), and which way from it the read goes.
const HistoryAnchorSchema = z.strictObject({
  direction: z.enum(['before', 'after']),
  messageId: WhatsAppMessageIdSchema,
  fromMe: z.boolean(),
})

// The most messages one history read answers: the most the app keeps of a conversation as the clone's context
// (desktop src/runtime/clone-conversation.ts MESSAGES_MAX, 60), so a larger page would be read and dropped.
export const WHATSAPP_HISTORY_COUNT_MAX = 60

// The bridge methods of a WhatsApp tab. A send takes two steps, so the app can record the message's id in its ledger
// before anything leaves: whatsappSendPrepare builds the message in one page and keeps it there under its id, changing
// nothing anyone sees, and answers the id with the token of the observer that keeps it; whatsappSendCommit sends
// exactly that message from that page, its time set at the commit from the page's clock. A commit answers refused or
// broken only when nothing was handed to WhatsApp, sent when the page's sender reported its OK, and unconfirmed when
// the message was handed over but the sender did not confirm it; a commit whose answer never came (a reply error)
// leaves the outcome unknown too. The sent message's own event, which the observer reports like any other, shows only
// that the message is in the account's message store, handed to WhatsApp as a message the owner typed would be; it
// does not show that WhatsApp's server took it. History is read from the page's local database around an anchor (the
// newest messages when anchor is null), oldest first, without loading anything into the page or marking anything
// read. A contact's name is the one the owner sees: the saved name, else the contact's own push name, else none.
export const WHATSAPP_BRIDGE_METHODS = {
  whatsappSendPrepare: {
    params: z.strictObject({ account: WhatsAppAccountSchema, chat: DirectChatWidSchema, text: z.string().min(1) }),
    result: z.discriminatedUnion('outcome', [
      z.strictObject({
        outcome: z.literal('prepared'),
        messageId: WhatsAppMessageIdSchema,
        token: ObserverTokenSchema,
      }),
      refused([
        'no-whatsapp-tab',
        'other-account',
        'not-connected',
        'no-chat',
        'not-direct-chat',
        'chat-mismatch',
        'deadline-passed',
      ]),
      BrokenSchema,
    ]),
  },
  whatsappSendCommit: {
    params: z.strictObject({
      account: WhatsAppAccountSchema,
      chat: DirectChatWidSchema,
      messageId: WhatsAppMessageIdSchema,
      token: ObserverTokenSchema,
    }),
    result: z.discriminatedUnion('outcome', [
      // timestamp: the time the message was stored with, in unix seconds, set at the commit from the page's clock
      // (U2-R4).
      z.strictObject({ outcome: z.literal('sent'), timestamp: z.number().int().nonnegative() }),
      z.strictObject({ outcome: z.literal('unconfirmed'), code: WhatsAppUnconfirmedSchema }),
      refused([
        'other-account',
        'not-connected',
        'no-chat',
        'chat-mismatch',
        'unknown-message',
        'deadline-passed',
        'page-failed',
      ]),
      BrokenSchema,
    ]),
  },
  whatsappHistory: {
    params: z.strictObject({
      account: WhatsAppAccountSchema,
      chat: DirectChatWidSchema,
      anchor: HistoryAnchorSchema.nullable(),
      count: z.number().int().min(1).max(WHATSAPP_HISTORY_COUNT_MAX),
    }),
    result: z.discriminatedUnion('outcome', [
      z.strictObject({
        outcome: z.literal('read'),
        messages: z.array(WhatsAppMessageSchema).max(WHATSAPP_HISTORY_COUNT_MAX),
        // The anchor the next read in the same direction takes, null when the database holds no more that way.
        next: HistoryAnchorSchema.nullable(),
      }),
      refused([
        'no-whatsapp-tab',
        'other-account',
        'no-chat',
        'not-direct-chat',
        'chat-mismatch',
        'unknown-anchor',
        'deadline-passed',
      ]),
      BrokenSchema,
    ]),
  },
  whatsappContact: {
    params: z.strictObject({ account: WhatsAppAccountSchema, wid: DirectChatWidSchema }),
    result: z.discriminatedUnion('outcome', [
      z.strictObject({ outcome: z.literal('read'), name: z.string().min(1).nullable(), isMe: z.boolean() }),
      refused(['no-whatsapp-tab', 'other-account', 'not-direct-chat', 'unknown-contact', 'deadline-passed']),
      BrokenSchema,
    ]),
  },
} as const

export type WhatsAppBridgeMethod = keyof typeof WHATSAPP_BRIDGE_METHODS

export type WhatsAppBridgeParams<TMethod extends WhatsAppBridgeMethod> = z.infer<
  (typeof WHATSAPP_BRIDGE_METHODS)[TMethod]['params']
>

export type WhatsAppBridgeResult<TMethod extends WhatsAppBridgeMethod> = z.infer<
  (typeof WHATSAPP_BRIDGE_METHODS)[TMethod]['result']
>

export type WhatsAppHistoryAnchor = z.infer<typeof HistoryAnchorSchema>

// What the app keeps of a preparation to commit it.
export type WhatsAppPreparedSend = Pick<
  Extract<WhatsAppBridgeResult<'whatsappSendPrepare'>, { outcome: 'prepared' }>,
  'messageId' | 'token'
>
