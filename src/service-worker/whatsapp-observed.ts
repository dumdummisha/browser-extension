import { z } from 'zod'
import {
  ObserverTokenSchema,
  WHATSAPP_BRIDGE_METHODS,
  WhatsAppAccountSchema,
  WhatsAppCaptureSchema,
  WhatsAppMessageSchema,
  type WhatsAppTabStatus,
} from '../protocol/whatsapp.js'

// The messages between a WhatsApp tab's observer, its relay and the service worker (extension/whatsapp-observer.ts,
// whatsapp-relay.ts and background.ts). Unlike Slack's channel, this one carries commands to the page: the service
// worker sends a command to the tab's relay, the relay posts it to the observer on their private channel, and the
// observer posts back exactly one answer under the command's id. What the observer posts unasked is data (its capture
// state and new messages), which becomes status and events, never a command; an answer counts only under the id of a
// command the relay sent and is read with that method's result schema, at the relay and again in the service worker.

// A command as the service worker sends it, by bridge method, with its caller's deadline: the observer acts on nothing
// once the deadline has passed.
export const WhatsAppCommandSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('whatsappSendPrepare'),
    params: WHATSAPP_BRIDGE_METHODS.whatsappSendPrepare.params,
  }),
  z.strictObject({
    method: z.literal('whatsappSendCommit'),
    params: WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.params,
  }),
  z.strictObject({ method: z.literal('whatsappHistory'), params: WHATSAPP_BRIDGE_METHODS.whatsappHistory.params }),
  z.strictObject({ method: z.literal('whatsappContact'), params: WHATSAPP_BRIDGE_METHODS.whatsappContact.params }),
])

export type WhatsAppCommand = z.infer<typeof WhatsAppCommandSchema>

const CommandIdSchema = z.uuid()

// Service worker to relay (chrome.tabs.sendMessage, pinned to the document the worker recorded for the tab).
export const RelayCommandSchema = z.strictObject({
  kind: z.literal('whatsapp-command'),
  id: CommandIdSchema,
  deadline: z.number().int().positive(),
  command: WhatsAppCommandSchema,
})

export type RelayCommand = z.infer<typeof RelayCommandSchema>

// Relay to observer, on the port the relay took: a command, or the existing taken report (capture-handshake.ts).
// The observer is in the page's world and the relay already read the command, so the observer checks only what it
// uses (whatsapp-capture.ts).
export type ObserverCommand = Omit<RelayCommand, 'kind'> & { readonly kind: 'command' }

// What the observer posts the relay:
// - greeting: its first message to each relay: its token and its capture state
// - capture: a change of its capture state
// - message: a new message, under its number in the observer's sequence, held until the relay reports it taken
// - answer: the one answer to the command with that id, read here only as far as the envelope; the relay reads the
//   answer itself with the result schema of the command it sent under that id
// - failed: a prepare's, history read's or contact read's page call threw while every internal it uses still checks
//   out; the page's error stays in the page. A commit never answers failed (whatsapp-capture.ts).
export const WhatsAppObserverMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('greeting'), token: ObserverTokenSchema, capture: WhatsAppCaptureSchema }),
  z.strictObject({ kind: z.literal('capture'), capture: WhatsAppCaptureSchema }),
  z.strictObject({
    kind: z.literal('message'),
    account: WhatsAppAccountSchema,
    message: WhatsAppMessageSchema,
    seq: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal('answer'), id: CommandIdSchema, answer: z.unknown() }),
  z.strictObject({ kind: z.literal('failed'), id: CommandIdSchema }),
])

export type WhatsAppObserverMessage = z.infer<typeof WhatsAppObserverMessageSchema>

// What a relay answers a RelayCommand: the observer's answer, read with the command's result schema; failed when the
// observer reported the command's page call failed; no-observer when no observer offered this relay a channel, or its
// capture failed; unreadable when the observer's answer did not read. An observer that never answers leaves the relay
// holding the reply; the service worker stops waiting at the caller's deadline.
export const RelayCommandAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('answer'), answer: z.unknown() }),
  z.strictObject({ kind: z.literal('failed') }),
  z.strictObject({ kind: z.literal('no-observer') }),
  z.strictObject({ kind: z.literal('unreadable') }),
])

export type RelayCommandAnswer = z.infer<typeof RelayCommandAnswerSchema>

// What a WhatsApp tab's relay holds of its tab:
// - detached: no observer offered this relay a channel (the page loaded before the extension did)
// - failed: what the observer sent did not read; error says what, in the relay's words, and it stays for as long as
//   the relay runs
// - observed: the observer's token and its latest capture state
const DetachedSchema = z.strictObject({ state: z.literal('detached') })
const FailedSchema = z.strictObject({ state: z.literal('failed'), error: z.string().min(1) })
const ObservedSchema = z.strictObject({
  state: z.literal('observed'),
  token: ObserverTokenSchema,
  capture: WhatsAppCaptureSchema,
})

export const WhatsAppRelayStateSchema = z.discriminatedUnion('state', [DetachedSchema, FailedSchema, ObservedSchema])

export type WhatsAppRelayState = z.infer<typeof WhatsAppRelayStateSchema>

// What a relay answers WHATSAPP_STATE_REQUEST: its state, or not-shown while its document is being prerendered, is in
// the back/forward cache or is being unloaded (whatsapp-relay.ts), so such a document is recorded only once it is the
// page its tab shows (U2-R40 point 4).
export const WhatsAppRelayAnswerSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not-shown') }),
  DetachedSchema,
  FailedSchema,
  ObservedSchema,
])

export type WhatsAppRelayAnswer = z.infer<typeof WhatsAppRelayAnswerSchema>

// The relay's answer, read. One that does not read is the failed state, worded here as captureHealthOf words Slack's
// (observed-message.ts), since zod's error would quote the answer: the relay answered, so its document is there, and
// what it holds is shown as broken.
export const whatsappAnswerOf = (tabId: number, answer: unknown): WhatsAppRelayAnswer => {
  const read = WhatsAppRelayAnswerSchema.safeParse(answer)

  return read.success ? read.data : { state: 'failed', error: `The relay in tab ${tabId} answered no state that reads` }
}

// What a WhatsApp tab's relay tells the service worker unasked (chrome.runtime.sendMessage):
// - whatsapp-message: a new message it checked, with the account the observer read when it came
// - whatsapp-report: its state may have changed, or its page became the one its tab shows. It carries nothing: the
//   worker asks the relay's document (WHATSAPP_STATE_REQUEST), and only that answer makes a record (U2-R40 point 1).
export const WhatsAppObservedMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('whatsapp-message'),
    account: WhatsAppAccountSchema,
    message: WhatsAppMessageSchema,
  }),
  z.strictObject({ kind: z.literal('whatsapp-report') }),
])

export type WhatsAppObservedMessage = z.infer<typeof WhatsAppObservedMessageSchema>

// A tab's status entry from its relay's state: detached and failed as held, the observer's capture state with the
// tab's id otherwise.
export const whatsappTabStatusOf = (tabId: number, state: WhatsAppRelayState): WhatsAppTabStatus =>
  state.state === 'observed' ? { tabId, ...state.capture } : { tabId, ...state }
