/// <reference types="chrome" />
import { z } from 'zod'
import { reportTaken, takeObserverPorts } from '../service-worker/capture-handshake.js'
import { type ObservedMessage, ObserverMessageSchema, type RelayCapture } from '../service-worker/observed-message.js'
import { CAPTURE_QUERY, RELAY_RUNNING_KEY } from './config.js'

// The observer's half in the extension's isolated world. The manifest runs it at document_start, and the service worker
// injects it into an open Slack tab whose relay it cannot reach, once the extension reloaded (background.ts). It takes a
// channel from the observer through the document during its own handshake (capture-handshake.ts), and nothing reaches
// it any other way. It checks every message on that channel: a new message goes on to the service worker, and once the
// service worker took it, the relay tells the observer so, which then stops holding it. The socket state is kept, as a
// boolean, so a service worker that restarted can ask for it. What does not read is kept as the capture's failure and
// reported, and nothing of it goes on.

// zod compiles its parsers with new Function unless told not to, and an extension's CSP refuses that.
z.config({ jitless: true })

// Null until the observer reported, which it does as soon as it handed over its port, so null means no observer here.
let isObservedSocketOpen: boolean | null = null
// What the observer sent that did not read. The capture stays failed for as long as this relay runs.
let captureError: string | null = null

const send = (message: ObservedMessage): void => {
  void chrome.runtime.sendMessage(message)
}

// Once the extension reloaded, this relay keeps running in its old world with chrome.runtime gone, or left without its
// id, where its types say it is always there, so it reads them untyped.
const isExtensionGone = (): boolean => {
  const runtime: unknown = Reflect.get(chrome, 'runtime')

  return typeof runtime !== 'object' || runtime === null || Reflect.get(runtime, 'id') === undefined
}

// A relay whose extension went away can pass nothing on, so it closes the channel the message came on, and the
// observer's posts to it go nowhere from then on. The frames it did not pass on stay held by the observer, which posts
// them to the relay that replaces this one.
const onObserverMessage = (data: unknown, port: MessagePort): void => {
  if (isExtensionGone()) {
    port.close()
    return
  }

  const message = ObserverMessageSchema.safeParse(data)
  if (!message.success) {
    captureError = `The observer sent what does not read:\n${z.prettifyError(message.error)}`
    send({ kind: 'capture' })
    return
  }

  // The service worker answers a frame once its admission ran (background.ts). A frame it did not answer, because the
  // extension went away meanwhile, stays held by the observer for the relay that replaces this one.
  if (message.data.kind === 'frame') {
    const { seq, ...observed } = message.data
    void chrome.runtime.sendMessage(observed satisfies ObservedMessage).then(
      () => reportTaken(port, seq),
      () => undefined
    )
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
