/// <reference types="chrome" />
import { z } from 'zod'
import { type ObservedMessage, ObserverMessageSchema, type RelayCapture } from '../service-worker/observed-message.js'
import { CAPTURE_QUERY, OBSERVER_PORT_EVENT, RELAY_READY_EVENT } from './config.js'

// The observer's half in the extension's isolated world. It takes the observer's end of their private channel once, at
// document_start (config.ts), and nothing reaches it any other way. It checks every message on that channel: a new
// message goes on to the service worker, and the socket state is kept, as a boolean, so a service worker that restarted
// can ask for it. What does not read is kept as the capture's failure and reported, and nothing of it goes on.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

// Null until the observer reported, which it does as soon as it handed over its port, so null means no observer here.
let isObservedSocketOpen: boolean | null = null
// What the observer sent that did not read. The capture stays failed until the page reloads.
let captureError: string | null = null

const send = (message: ObservedMessage): void => {
  void chrome.runtime.sendMessage(message)
}

const onObserverMessage = ({ data }: MessageEvent<unknown>): void => {
  const message = ObserverMessageSchema.safeParse(data)
  if (!message.success) {
    captureError = `The observer sent what does not read:\n${z.prettifyError(message.error)}`
    send({ kind: 'capture' })
    return
  }

  if (message.data.kind === 'frame') {
    send(message.data)
    return
  }

  isObservedSocketOpen = message.data.isSocketOpen
  send({ kind: 'capture' })
}

// Only the observer, listening since it ran just before this script, can answer during this dispatch. A port offered
// at any later time, when the page's scripts may run, finds no listener.
const takePort = (event: Event): void => {
  const [port] = event instanceof MessageEvent ? event.ports : []
  if (port !== undefined) {
    port.onmessage = onObserverMessage
  }
}

document.addEventListener(OBSERVER_PORT_EVENT, takePort)
document.dispatchEvent(new CustomEvent(RELAY_READY_EVENT))
document.removeEventListener(OBSERVER_PORT_EVENT, takePort)

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (message === CAPTURE_QUERY) {
    sendResponse({ isSocketOpen: isObservedSocketOpen, error: captureError } satisfies RelayCapture)
  }
})
