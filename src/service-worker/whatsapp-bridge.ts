import type { z } from 'zod'
import {
  WHATSAPP_BRIDGE_METHODS,
  type WhatsAppAccount,
  whatsappAccountId,
  type WhatsAppBridgeMethod,
  type WhatsAppBridgeResult,
} from '../protocol/whatsapp.js'
import { type IAbandonment, throwIfAbandoned } from './bridge-requests.js'
import type { RequestPace } from './request-pace.js'
import { type RelayCommand, RelayCommandAnswerSchema, type WhatsAppCommand } from './whatsapp-observed.js'
import type { IOpenWhatsAppTabs, IWhatsAppDocument, WhatsAppTabs } from './whatsapp-tabs.js'

// The WhatsApp bridge methods: each command goes to one document, the one the registry recorded for a tab ready as the
// command's account (whatsapp-tabs.ts), pinned to it, and to no other, whatever comes back (U2-R40 point 7). A prepare
// and a commit take a turn of the account's pace (request-pace.ts), so the page builds and sends at a person's pace and
// the prepared messages a window holds stay bounded (whatsapp-capture.ts PREPARED_SEND_WINDOW_MS); the reads take none,
// since they send nothing to WhatsApp and keep nothing. A command that finds no recorded page for its account is refused
// with nothing handed over, and every WhatsApp tab is asked to report, so the next attempt finds a page that is there.
// Nothing here is awaited by Slack's calls, the status or the shared intake (U2-R30).
//
// A commit is the one command that sends: before its hand-off it asks its document, with a request that carries no
// commit, whether it is still there as the page its tab shows, and refuses unknown-message when it is not. From the
// commit's own hand-off on, the answer is the page's own or a reply error that leaves the outcome unknown, never a
// refusal from here (U2-R23, U2-R37).

export type WhatsAppHandlers = {
  [TMethod in WhatsAppBridgeMethod]: (
    params: unknown,
    abandonment: IAbandonment
  ) => Promise<WhatsAppBridgeResult<TMethod>>
}

// What the bridge needs of the service worker (background.ts): the registry, the open WhatsApp tabs, a request to every
// WhatsApp tab to report, the pace, and the hand-off of a command to the relay of one document (chrome.tabs.sendMessage
// pinned with documentId), which resolves with what the relay answered and rejects when Chrome reaches no such relay.
export interface IWhatsAppBridge {
  readonly tabs: Pick<WhatsAppTabs, 'readyDocument' | 'documentOfToken' | 'isRecorded' | 'ask' | 'missed'>
  readonly openTabs: () => Promise<IOpenWhatsAppTabs>
  readonly askTabs: () => Promise<void>
  readonly pace: RequestPace
  readonly handOver: (document: IWhatsAppDocument, command: RelayCommand) => Promise<unknown>
}

// How a hand-off ended: Chrome rejected it, the caller's deadline passed first, or the relay answered.
type HandOff =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'late' }
  | { readonly kind: 'answered'; readonly answer: unknown }

const NO_WHATSAPP_TAB = { outcome: 'refused', refusal: 'no-whatsapp-tab' } as const
const UNKNOWN_MESSAGE = { outcome: 'refused', refusal: 'unknown-message' } as const

// Waits for settled, or less once the caller gives up: its signal aborts or its deadline passes. Answers which came
// first.
const settledOrAbandoned = (
  settled: Promise<void>,
  { deadline, signal }: IAbandonment
): Promise<'settled' | 'abandoned'> =>
  new Promise((resolve) => {
    const finish = (outcome: 'settled' | 'abandoned'): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abandon)
      resolve(outcome)
    }

    const abandon = (): void => {
      finish('abandoned')
    }

    const timer = setTimeout(abandon, Math.max(0, deadline - Date.now()))
    signal.addEventListener('abort', abandon, { once: true })
    void settled.then(() => {
      finish('settled')
    })
  })

// Hands the command to the document's relay at once, before anything asynchronous, and waits for its answer until the
// caller's deadline, after which the observer acts on nothing (whatsapp-capture.ts) and the caller takes no reply.
const handOff = (
  { handOver }: IWhatsAppBridge,
  document: IWhatsAppDocument,
  command: WhatsAppCommand,
  deadline: number
): Promise<HandOff> =>
  new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        resolve({ kind: 'late' })
      },
      Math.max(0, deadline - Date.now())
    )

    handOver(document, { kind: 'whatsapp-command', id: crypto.randomUUID(), deadline, command }).then(
      (answer: unknown) => {
        clearTimeout(timer)
        resolve({ kind: 'answered', answer })
      },
      () => {
        clearTimeout(timer)
        resolve({ kind: 'rejected' })
      }
    )
  })

// An error after a command's hand-off. Once a commit is handed over, the page may have sent the message whatever came
// back, so every such error says the outcome is unknown; an error before the hand-off never does.
const handedError = (method: WhatsAppBridgeMethod, error: string): Error =>
  new Error(method === 'whatsappSendCommit' ? `${error}, so whether the message was sent is unknown` : error)

// The deadline passed before the page answered: the page may still act on a command it took before the deadline.
const lateError = ({ tabId }: IWhatsAppDocument, method: WhatsAppBridgeMethod): Error =>
  handedError(method, `The WhatsApp page in tab ${tabId} did not answer ${method} by the caller's deadline`)

// What the relay answered, read: the observer's answer, read again with the method's result schema, or an error worded
// here for the relay's failed, no-observer and unreadable and for anything that does not read, so no error quotes the
// page. A reload is suggested for a missing observer only where it settles everything: a commit's message may be on its
// way all the same.
const readAnswer = <TResult>(
  { tabId }: IWhatsAppDocument,
  method: WhatsAppBridgeMethod,
  answer: unknown,
  result: z.ZodType<TResult>
): TResult => {
  const relayed = RelayCommandAnswerSchema.safeParse(answer)
  if (!relayed.success) {
    throw handedError(method, `The WhatsApp relay in tab ${tabId} answered ${method} with what does not read`)
  }

  switch (relayed.data.kind) {
    case 'failed':
      throw handedError(method, `The WhatsApp page in tab ${tabId} failed ${method}`)
    case 'no-observer':
      throw method === 'whatsappSendCommit'
        ? handedError(method, `The WhatsApp page in tab ${tabId} has no observer to run ${method}`)
        : new Error(`The WhatsApp page in tab ${tabId} has no observer to run ${method}. Reload the tab.`)
    case 'unreadable':
      throw handedError(method, `The WhatsApp page in tab ${tabId} answered ${method} with what does not read`)
    case 'answer':
  }

  const read = result.safeParse(relayed.data.answer)
  if (!read.success) {
    throw handedError(method, `The WhatsApp page in tab ${tabId} answered ${method} with what does not read`)
  }

  return read.data
}

// The document of the open tab ready as the account, or null, in which case every WhatsApp tab is asked to report.
const readyDocumentOf = async (
  bridge: IWhatsAppBridge,
  account: WhatsAppAccount
): Promise<IWhatsAppDocument | null> => {
  const document = bridge.tabs.readyDocument(account, await bridge.openTabs())
  if (document === null) {
    void bridge.askTabs()
  }

  return document
}

// A read, in the one recorded document ready as the account, answered as result reads it. A hand-off Chrome rejects
// sent nothing to WhatsApp, so it is no-whatsapp-tab whatever the page took, and the tab is asked again.
const readIn = async <TResult>(
  bridge: IWhatsAppBridge,
  account: WhatsAppAccount,
  command: Extract<WhatsAppCommand, { method: 'whatsappHistory' | 'whatsappContact' }>,
  result: z.ZodType<TResult>,
  { deadline }: IAbandonment
): Promise<TResult | typeof NO_WHATSAPP_TAB> => {
  const document = await readyDocumentOf(bridge, account)
  if (document === null) {
    return NO_WHATSAPP_TAB
  }

  const handed = await handOff(bridge, document, command, deadline)

  switch (handed.kind) {
    case 'rejected':
      bridge.tabs.missed(document)
      return NO_WHATSAPP_TAB
    case 'late':
      throw lateError(document, command.method)
    case 'answered':
  }

  return readAnswer(document, command.method, handed.answer, result)
}

// The first send step, in a turn of the account's pace, in one document. Every outcome counts but a refusal before the
// hand-off and the observer's refused or broken, which promise nothing was kept: a hand-off Chrome rejects may have left
// a built message in a page that went away, and the store's bound needs every prepare that may have kept one to count
// (whatsapp-capture.ts PREPARED_SEND_WINDOW_MS). Such a message is never sent.
const prepare = (
  bridge: IWhatsAppBridge,
  command: Extract<WhatsAppCommand, { method: 'whatsappSendPrepare' }>,
  abandonment: IAbandonment
): Promise<WhatsAppBridgeResult<'whatsappSendPrepare'>> =>
  bridge.pace.turn(whatsappAccountId(command.params.account), abandonment, async (send) => {
    const document = await readyDocumentOf(bridge, command.params.account)
    if (document === null) {
      return NO_WHATSAPP_TAB
    }

    return send(async (unsent) => {
      if (!bridge.tabs.isRecorded(document)) {
        unsent()
        void bridge.askTabs()
        return NO_WHATSAPP_TAB
      }

      const handed = await handOff(bridge, document, command, abandonment.deadline)

      switch (handed.kind) {
        case 'rejected':
          bridge.tabs.missed(document)
          return NO_WHATSAPP_TAB
        case 'late':
          throw lateError(document, command.method)
        case 'answered':
      }

      const answer = readAnswer(document, command.method, handed.answer, WHATSAPP_BRIDGE_METHODS[command.method].result)
      if (answer.outcome === 'prepared' && answer.token !== document.token) {
        throw new Error(`The WhatsApp page in tab ${document.tabId} answered a preparation under another page's token`)
      }

      if (answer.outcome !== 'prepared') {
        unsent()
      }

      return answer
    })
  })

// The second send step, in a turn of the account's pace, handed only to the document whose record holds the commit's
// token. After the gap the document is asked, with a request that carries no commit, and the commit goes only while the
// record still names that document with the token: a document that was rejected, answered not-shown or was outranked
// by another document's answer gets nothing, and the answer is unknown-message (U2-R40 point 7). The caller is checked
// once more after that ask, the commit's last asynchronous step before its hand-off. From the hand-off on, the answer is
// the observer's or a reply error: a hand-off Chrome rejects may have reached the page before it went (U2-R37).
const commit = (
  bridge: IWhatsAppBridge,
  command: Extract<WhatsAppCommand, { method: 'whatsappSendCommit' }>,
  abandonment: IAbandonment
): Promise<WhatsAppBridgeResult<'whatsappSendCommit'>> =>
  bridge.pace.turn(whatsappAccountId(command.params.account), abandonment, async (send) => {
    const document = bridge.tabs.documentOfToken(command.params.token, await bridge.openTabs())
    if (document === null) {
      void bridge.askTabs()
      return UNKNOWN_MESSAGE
    }

    return send(async (unsent) => {
      if (!bridge.tabs.isRecorded(document)) {
        unsent()
        void bridge.askTabs()
        return UNKNOWN_MESSAGE
      }

      const checked = await settledOrAbandoned(bridge.tabs.ask(document.tabId, document.documentId), abandonment)
      if (checked === 'abandoned') {
        unsent()
        // The caller cancelled, or its deadline passed: at the deadline at the latest, so this throws.
        throwIfAbandoned(abandonment, abandonment.deadline)
      }

      if (!bridge.tabs.isRecorded(document)) {
        unsent()
        void bridge.askTabs()
        return UNKNOWN_MESSAGE
      }

      try {
        throwIfAbandoned(abandonment)
      } catch (error) {
        unsent()
        throw error
      }

      const handed = await handOff(bridge, document, command, abandonment.deadline)

      switch (handed.kind) {
        case 'rejected':
          bridge.tabs.missed(document)
          throw handedError(
            command.method,
            `The WhatsApp page in tab ${document.tabId} went away after the commit was handed to it`
          )
        case 'late':
          throw lateError(document, command.method)
        case 'answered':
      }

      const answer = readAnswer(document, command.method, handed.answer, WHATSAPP_BRIDGE_METHODS[command.method].result)
      if (answer.outcome === 'refused' || answer.outcome === 'broken') {
        unsent()
      }

      return answer
    })
  })

export const whatsappHandlers = (bridge: IWhatsAppBridge): WhatsAppHandlers => ({
  whatsappSendPrepare: (raw, abandonment) => {
    const params = WHATSAPP_BRIDGE_METHODS.whatsappSendPrepare.params.parse(raw)

    return prepare(bridge, { method: 'whatsappSendPrepare', params }, abandonment)
  },
  whatsappSendCommit: (raw, abandonment) => {
    const params = WHATSAPP_BRIDGE_METHODS.whatsappSendCommit.params.parse(raw)

    return commit(bridge, { method: 'whatsappSendCommit', params }, abandonment)
  },
  whatsappHistory: (raw, abandonment) => {
    const { params, result } = WHATSAPP_BRIDGE_METHODS.whatsappHistory
    const parsed = params.parse(raw)

    return readIn(bridge, parsed.account, { method: 'whatsappHistory', params: parsed }, result, abandonment)
  },
  whatsappContact: (raw, abandonment) => {
    const { params, result } = WHATSAPP_BRIDGE_METHODS.whatsappContact
    const parsed = params.parse(raw)

    return readIn(bridge, parsed.account, { method: 'whatsappContact', params: parsed }, result, abandonment)
  },
})
