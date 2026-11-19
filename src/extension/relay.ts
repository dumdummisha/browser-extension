/// <reference types="chrome" />
import { z } from 'zod'
import { takeObserverPorts } from '../service-worker/capture-handshake.js'
import { type ObservedMessage, ObserverMessageSchema, type RelayCapture } from '../service-worker/observed-message.js'
import { CAPTURE_QUERY, RELAY_RUNNING_KEY } from './config.js'

// The observer's half in the extension's isolated world. The manifest runs it at document_start, and the service worker
// injects it into an open Slack tab whose relay it cannot reach, once the extension reloaded (background.ts). It takes a
// channel from the observer through the document during its own handshake (capture-handshake.ts), and nothing reaches
// it any other way. It checks every message on that channel: a new message goes on to the service worker, and the
// socket state is kept, as a boolean, so a service worker that restarted can ask for it. What does not read is kept as
// the capture's failure and reported, and nothing of it goes on.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

// Null until the observer reported, which it does as soon as it handed over its port, so null means no observer here.
let isObservedSocketOpen: boolean | null = null
// What the observer sent that did not read. The capture stays failed for as long as this relay runs.
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

// One relay per document for each load of the extension: a tab that was still loading when the service worker injected
// a relay runs the manifest's copy too, in this same isolated world, and the copy that runs second leaves. The isolated
// world of an extension that reloaded is a new one, so a relay injected then never finds the mark of the one it
// replaces.
if (!Reflect.has(globalThis, RELAY_RUNNING_KEY)) {
  Reflect.set(globalThis, RELAY_RUNNING_KEY, true)
  takeObserverPorts(document, onObserverMessage)
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (message === CAPTURE_QUERY) {
      sendResponse({ isSocketOpen: isObservedSocketOpen, error: captureError } satisfies RelayCapture)
    }
  })
}
