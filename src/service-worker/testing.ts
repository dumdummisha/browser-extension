import type { TestContext } from 'node:test'
import { PROTOCOL_REVISION } from '../protocol/messages.js'

// Spec helpers: the fake Chrome events a service worker listens on, the host's hello, callers' deadlines, and waits
// for the promises that can move on.

type Listener = (...args: unknown[]) => unknown

// A Chrome event: the listeners the service worker added, which the fake Chrome calls as Chrome would.
export interface IChromeEvent {
  readonly listeners: Listener[]
  readonly addListener: (listener: Listener) => void
}

// The host's end of its hello, and the hello itself.
export const HOST_END = { role: 'host', protocolRevision: PROTOCOL_REVISION, componentVersion: '9.8.7' }
export const HOST_HELLO = { type: 'hello', ...HOST_END, browserApp: null }

// A caller's deadline that has not passed (2100-01-01) and one that has (2000-01-01).
export const LATER = 4_102_444_800_000
export const EARLIER = 946_684_800_000

export const chromeEvent = (): IChromeEvent => {
  const listeners: Listener[] = []

  return {
    listeners,
    addListener: (listener) => {
      listeners.push(listener)
    },
  }
}

export const emit = (event: IChromeEvent, ...args: unknown[]): void => {
  for (const listener of event.listeners) {
    listener(...args)
  }
}

// The chrome.webRequest events the service worker listens on.
export const fakeWebRequest = (): object => ({
  onBeforeRequest: chromeEvent(),
  onBeforeSendHeaders: chromeEvent(),
  onSendHeaders: chromeEvent(),
  onCompleted: chromeEvent(),
  onErrorOccurred: chromeEvent(),
})

// Lets the promises that can move on do so; setImmediate is not one of the mocked timers.
export const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// Moves the mocked clock on by ms, then lets the promises that can move on do so.
export const tick = async (context: TestContext, ms: number): Promise<void> => {
  context.mock.timers.tick(ms)
  await settled()
}
