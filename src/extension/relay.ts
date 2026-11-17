/// <reference types="chrome" />
import { CAPTURE_QUERY, OBSERVED_FRAME_EVENT, OBSERVED_SOCKET_EVENT, RELAY_READY_EVENT } from './config.js'
import { type ObservedMessage } from './observed-message.js'

// The observer's half in the extension's isolated world: it passes what the observer saw to the service worker, and
// keeps the observer's last socket state, so a service worker that restarted can ask for it. It reads nothing itself;
// the service worker checks everything.

// Null until the observer reported, which it does as soon as it runs, so null means no observer in this page.
let socketState: string | null = null

const send = (message: ObservedMessage): void => {
  void chrome.runtime.sendMessage(message)
}

const detailOf = (event: Event): unknown => (event instanceof CustomEvent ? event.detail : undefined)

document.addEventListener(OBSERVED_FRAME_EVENT, (event) => {
  const detail = detailOf(event)
  if (typeof detail === 'string') {
    send({ kind: 'frame', text: detail })
  }
})

document.addEventListener(OBSERVED_SOCKET_EVENT, (event) => {
  const detail = detailOf(event)
  if (typeof detail === 'string') {
    socketState = detail
    send({ kind: 'capture' })
  }
})

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (message === CAPTURE_QUERY) {
    sendResponse(socketState)
  }
})

document.dispatchEvent(new CustomEvent(RELAY_READY_EVENT))
