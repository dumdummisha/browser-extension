/// <reference types="chrome" />
import { z } from 'zod'
import { reportTaken, takeObserverPorts } from '../service-worker/capture-handshake.js'
import {
  CLIENT_QUERY_KINDS,
  type ClientQueries,
  type ObservedMessage,
  type ObserverMessage,
  ObserverMessageSchema,
  type RelayCapture,
  type RelayClientQuery,
} from '../service-worker/observed-message.js'
import { CAPTURE_QUERY, CLIENT_QUERY, RELAY_RUNNING_KEY, SLACK_ORIGIN } from './config.js'

// The observer's half in the extension's isolated world. The manifest runs it at document_start, and the service worker
// injects it into an open Slack tab whose relay it cannot reach, once the extension reloaded (background.ts). It takes a
// channel from the observer through the document during its own handshake (capture-handshake.ts), and nothing reaches
// it any other way. It checks every message on that channel: a new message goes on to the service worker, and once the
// service worker took it, the relay tells the observer so, which then stops holding it. The socket state is kept, as a
// boolean, and the client queries the observer keeps are kept as it sends them, for the document's lifetime, so a
// service worker that restarted can ask for either; a client query is never held as a frame, acknowledged or passed
// on as an event. What does not read is kept as the capture's failure and reported, and nothing of it goes on.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

// What does not read in a message that carries a client query. Worded here, since zod's error would quote the record
// keys it rejected.
const CLIENT_QUERY_UNREADABLE = 'The observer sent a client query that does not read'

// Where the client queries stand, from the handshake and the observer's first message:
// - no-observer: no observer offered this relay a channel (the page loaded before the extension did)
// - awaiting-greeting: a channel was offered, and its first message, already queued on the port, is not read yet
// - greeted: the first message was a greeting, so the observer keeps client queries
// - no-client-queries: the first message was something else, as from an observer from before client queries, whose
//   first message is a socket state, or did not read
type QueryState = 'no-observer' | 'awaiting-greeting' | 'greeted' | 'no-client-queries'

// Null until the observer reported, which it does as soon as it handed over its port, so null means no observer here.
let isObservedSocketOpen: boolean | null = null
// What the observer sent that did not read. The capture stays failed for as long as this relay runs.
let captureError: string | null = null
// Set by the handshake, before any message of the observer can be read.
let queryState: QueryState = 'no-observer'
const clientQueries = new Map<string, ClientQueries[string]>()
// The service worker's CLIENT_QUERY answers held while the greeting is awaited.
const heldAnswers: ((answer: RelayClientQuery) => void)[] = []

const send = (message: ObservedMessage): void => {
  void chrome.runtime.sendMessage(message)
}

// Once the extension reloaded, this relay keeps running in its old world with chrome.runtime gone, or left without its
// id, where its types say it is always there, so it reads them untyped.
const isExtensionGone = (): boolean => {
  const runtime: unknown = Reflect.get(chrome, 'runtime')

  return typeof runtime !== 'object' || runtime === null || Reflect.get(runtime, 'id') === undefined
}

const clientQueryAnswer = (): RelayClientQuery => ({
  queries: queryState === 'greeted' && captureError === null ? Object.fromEntries(clientQueries) : null,
})

// The observer's first message settles whether it keeps client queries, and releases every answer held for it; a
// later message changes neither.
const settleQueryState = (isGreeting: boolean): void => {
  if (queryState !== 'awaiting-greeting') {
    return
  }

  queryState = isGreeting ? 'greeted' : 'no-client-queries'
  for (const answer of heldAnswers.splice(0)) {
    answer(clientQueryAnswer())
  }
}

const unreadableError = (data: unknown, error: z.ZodError): string => {
  const kind: unknown = typeof data === 'object' && data !== null ? Reflect.get(data, 'kind') : undefined

  return CLIENT_QUERY_KINDS.has(kind)
    ? CLIENT_QUERY_UNREADABLE
    : `The observer sent what does not read:\n${z.prettifyError(error)}`
}

// Takes a message that read: a frame goes on to the service worker, and the rest is kept.
const keep = (observed: ObserverMessage, port: MessagePort): void => {
  switch (observed.kind) {
    // The service worker answers a frame once its admission ran (background.ts). A frame it did not answer, because
    // the extension went away meanwhile, stays held by the observer for the relay that replaces this one.
    case 'frame': {
      const { seq, ...frame } = observed
      void chrome.runtime.sendMessage(frame satisfies ObservedMessage).then(
        () => reportTaken(port, seq),
        () => undefined
      )
      return
    }
    case 'greeting':
      for (const [origin, query] of Object.entries(observed.queries)) {
        clientQueries.set(origin, query)
      }

      isObservedSocketOpen = observed.isSocketOpen
      send({ kind: 'capture' })
      return
    case 'socket':
      isObservedSocketOpen = observed.isSocketOpen
      send({ kind: 'capture' })
      return
    case 'client-query':
      clientQueries.set(observed.origin, observed.query)
  }
}

// A relay whose extension went away can pass nothing on, so it closes the channel the message came on, and the
// observer's posts to it go nowhere from then on. The frames it did not pass on stay held by the observer, which posts
// them to the relay that replaces this one. The query state settles once the message is kept, so an answer held for
// the greeting gets the queries the greeting brought.
const onObserverMessage = (data: unknown, port: MessagePort): void => {
  if (isExtensionGone()) {
    port.close()
    return
  }

  const message = ObserverMessageSchema.safeParse(data)
  if (!message.success) {
    captureError = unreadableError(data, message.error)
    settleQueryState(false)
    send({ kind: 'capture' })
    return
  }

  keep(message.data, port)
  settleQueryState(message.data.kind === 'greeting')
}

// One relay per document for each load of the extension: a tab that was still loading when the service worker injected
// a relay runs the manifest's copy too, in this same isolated world, and the copy that runs second leaves. The isolated
// world of an extension that reloaded is a new one, so a relay injected then never finds the mark of the one it
// replaces. The mark is left only once the relay took its channel, which it does only in a Slack page's top frame, and
// the service worker reads it to tell whether a document still needs a relay (relay-attachment.ts).
// A CLIENT_QUERY that comes while the greeting is awaited is answered once it is read: the greeting is queued on the
// port by the time the handshake returns, so the answer waits for one port message, not for a timer.
if (!Reflect.has(globalThis, RELAY_RUNNING_KEY)) {
  const isOffered = takeObserverPorts(
    { document, origin: location.origin, isTopFrame: window === window.top },
    SLACK_ORIGIN,
    onObserverMessage
  )
  queryState = isOffered ? 'awaiting-greeting' : 'no-observer'
  Reflect.set(globalThis, RELAY_RUNNING_KEY, true)
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (message === CAPTURE_QUERY) {
      sendResponse({ isSocketOpen: isObservedSocketOpen, error: captureError } satisfies RelayCapture)
      return false
    }

    if (message !== CLIENT_QUERY) {
      return false
    }

    if (queryState === 'awaiting-greeting') {
      heldAnswers.push(sendResponse)
      return true
    }

    sendResponse(clientQueryAnswer())
    return false
  })
}
