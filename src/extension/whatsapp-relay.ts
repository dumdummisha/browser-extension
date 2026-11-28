/// <reference types="chrome" />
import { z } from 'zod'
import { WHATSAPP_BRIDGE_METHODS, type WhatsAppBridgeMethod } from '../protocol/whatsapp.js'
import { reportTaken, takeObserverPorts } from '../service-worker/capture-handshake.js'
import {
  type ObserverCommand,
  type RelayCommandAnswer,
  RelayCommandSchema,
  type WhatsAppObservedMessage,
  type WhatsAppObserverMessage,
  WhatsAppObserverMessageSchema,
  type WhatsAppRelayAnswer,
  type WhatsAppRelayState,
} from '../service-worker/whatsapp-observed.js'
import { RELAY_RUNNING_KEY, WHATSAPP_ORIGIN, WHATSAPP_REPORT_REQUEST, WHATSAPP_STATE_REQUEST } from './config.js'

// The WhatsApp observer's half in the extension's isolated world, as relay.ts is for Slack. It takes a channel from the
// observer through the document during its own handshake (capture-handshake.ts), only in the top frame of a page on
// web.whatsapp.com, and nothing reaches it any other way. It checks every message on that channel: a new message goes
// on to the service worker, and once the service worker took it, the relay tells the observer so, which then stops
// holding it. It holds the observer's token and latest capture state for the document's lifetime, and answers the
// service worker's state request with it at once, so the worker records the tab from an answer of this document alone
// (whatsapp-observed.ts WhatsAppRelayAnswerSchema). It tells the worker to ask again, with a report that carries
// nothing, whenever that state changes or its page becomes the one its tab shows. A command from the service worker
// goes to the observer on the port the observer greeted on, and its one answer comes back read with the command's
// result schema. A message from the observer whose envelope does not read (a greeting, a capture state, a new message
// or an answer's envelope) is kept as the failed state and reported, and a command waiting for that answer is left to
// the service worker's deadline. An answer whose envelope reads, under the id of a pending command, but whose result
// does not read with that command's result schema is answered as unreadable. Nothing of either goes on.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

// The relay's own words for what did not read, since zod's error could quote what the page sent.
const UNREADABLE_MESSAGE = 'The observer sent a message that does not read'
const CAPTURE_BEFORE_GREETING = 'The observer sent its capture state before its greeting'

const NOT_SHOWN: WhatsAppRelayAnswer = { state: 'not-shown' }

// A command posted to the observer and not answered yet: its method, whose result schema reads the answer, and the
// service worker's sendResponse.
interface IPendingCommand {
  readonly method: WhatsAppBridgeMethod
  readonly respond: (answer: RelayCommandAnswer) => void
}

// The relay's state: null until the observer's first message was read, set at once to detached when no observer
// offered a channel.
let state: WhatsAppRelayState | null = null
// Set by pagehide, cleared by pageshow: the document is in the back/forward cache or is being unloaded.
let isHidden = false
// The service worker's WHATSAPP_STATE_REQUEST answers held while the observer's first message, already queued on its
// port, is read, as relay.ts holds CLIENT_QUERY answers.
const heldAnswers: ((answer: WhatsAppRelayAnswer) => void)[] = []
// The port the observer's greeting came on, which every command goes to.
let observerPort: MessagePort | null = null
const pendingCommands = new Map<string, IPendingCommand>()

// Once the extension reloaded, this relay keeps running in its old world with chrome.runtime gone, or left without its
// id, where its types say it is always there, so it reads them untyped.
const isExtensionGone = (): boolean => {
  const runtime: unknown = Reflect.get(chrome, 'runtime')

  return typeof runtime !== 'object' || runtime === null || Reflect.get(runtime, 'id') === undefined
}

// Whether the document is the page its tab shows: not being prerendered, and not past pagehide without a pageshow
// since. TypeScript's DOM library has no document.prerendering, so it is read untyped, as isExtensionGone reads
// chrome.runtime.
const isShown = (): boolean => Reflect.get(document, 'prerendering') !== true && !isHidden

// The relay tells the service worker to ask it, only while its page is shown and its state is known; the report a
// page that is not shown would post is posted when it becomes shown.
const reportIfShown = (): void => {
  if (isShown() && state !== null) {
    void chrome.runtime.sendMessage({ kind: 'whatsapp-report' } satisfies WhatsAppObservedMessage)
  }
}

// Every change of the relay's state: answers held for the first message get the state, and the worker is told. A
// failed state stays for as long as the relay runs, so nothing changes it.
const setState = (next: WhatsAppRelayState): void => {
  if (state?.state === 'failed') {
    return
  }

  state = next

  for (const respond of heldAnswers.splice(0)) {
    respond(isShown() ? next : NOT_SHOWN)
  }

  reportIfShown()
}

// The observer's answer to a command the relay sent, read with that command's result schema; an answer under an id
// the relay sent no command under is not read.
const answerCommand = (id: string, answerOf: (method: WhatsAppBridgeMethod) => RelayCommandAnswer): void => {
  const pending = pendingCommands.get(id)
  if (pending === undefined) {
    return
  }

  pendingCommands.delete(id)
  pending.respond(answerOf(pending.method))
}

// Takes a message that read: a new message goes on to the service worker, an answer to the command it answers, and the
// greeting and every capture change become the state.
const keep = (observed: WhatsAppObserverMessage, port: MessagePort): void => {
  switch (observed.kind) {
    // The service worker answers a message once its admission ran (background.ts). A message it did not answer, because
    // the extension went away meanwhile, stays held by the observer for the relay that replaces this one.
    case 'message': {
      const { account, message, seq } = observed

      void chrome.runtime
        .sendMessage({ kind: 'whatsapp-message', account, message } satisfies WhatsAppObservedMessage)
        .then(
          () => reportTaken(port, seq),
          () => undefined
        )

      return
    }
    case 'greeting':
      observerPort = port
      setState({ state: 'observed', token: observed.token, capture: observed.capture })
      return
    case 'capture':
      setState(
        state?.state === 'observed'
          ? { ...state, capture: observed.capture }
          : { state: 'failed', error: CAPTURE_BEFORE_GREETING }
      )

      return
    case 'answer':
      answerCommand(observed.id, (method) => {
        const result = WHATSAPP_BRIDGE_METHODS[method].result.safeParse(observed.answer)

        return result.success ? { kind: 'answer', answer: result.data } : { kind: 'unreadable' }
      })

      return
    case 'failed':
      answerCommand(observed.id, () => ({ kind: 'failed' }))
  }
}

// A relay whose extension went away can pass nothing on, so it closes the channel the message came on, and the
// observer's posts to it go nowhere from then on. The messages it did not pass on stay held by the observer, which posts
// them to the relay that replaces this one.
const onObserverMessage = (data: unknown, port: MessagePort): void => {
  if (isExtensionGone()) {
    port.close()
    return
  }

  const message = WhatsAppObserverMessageSchema.safeParse(data)
  if (!message.success) {
    setState({ state: 'failed', error: UNREADABLE_MESSAGE })
    return
  }

  keep(message.data, port)
}

// A command from the service worker goes to the observer while the relay holds its state, and is answered once the
// observer answers it; with no observer, or a failed capture, it is answered no-observer at once. One that does not read
// is not answered.
const onCommand = (message: unknown, sendResponse: (answer: RelayCommandAnswer) => void): boolean => {
  const read = RelayCommandSchema.safeParse(message)
  if (!read.success) {
    return false
  }

  if (state?.state !== 'observed' || observerPort === null) {
    sendResponse({ kind: 'no-observer' })
    return false
  }

  const { id, deadline, command } = read.data
  pendingCommands.set(id, { method: command.method, respond: sendResponse })
  observerPort.postMessage({ kind: 'command', id, deadline, command } satisfies ObserverCommand)

  return true
}

// One relay per document for each load of the extension, as relay.ts has it, with the same mark: a document is on one
// origin, so it holds either relay, never both. takeObserverPorts throws outside the top frame of web.whatsapp.com, so
// such a relay adds no listener and leaves no mark.
if (!Reflect.has(globalThis, RELAY_RUNNING_KEY)) {
  const isOffered = takeObserverPorts(
    { document, origin: location.origin, isTopFrame: window === window.top },
    WHATSAPP_ORIGIN,
    onObserverMessage
  )

  Reflect.set(globalThis, RELAY_RUNNING_KEY, true)

  document.addEventListener('prerenderingchange', () => {
    reportIfShown()
  })

  window.addEventListener('pagehide', () => {
    isHidden = true
  })

  window.addEventListener('pageshow', ({ persisted }) => {
    isHidden = false

    if (persisted) {
      reportIfShown()
    }
  })

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (message === WHATSAPP_REPORT_REQUEST) {
      reportIfShown()
      return false
    }

    if (message !== WHATSAPP_STATE_REQUEST) {
      return onCommand(message, sendResponse)
    }

    if (!isShown()) {
      sendResponse(NOT_SHOWN)
      return false
    }

    if (state === null) {
      heldAnswers.push(sendResponse)
      return true
    }

    sendResponse(state)

    return false
  })

  if (!isOffered) {
    setState({ state: 'detached' })
  }
}
