// How a Slack tab's observer, in the page's own world, and the extension's relay, in its isolated world, open their
// private channel (extension/observer.ts, relay.ts). They share only the document. The relay dispatches
// RELAY_READY_EVENT on it, and while that event is dispatched, the observer answers with OBSERVER_PORT_EVENT, a
// MessageEvent carrying one end of a new MessageChannel. The relay takes the ports offered during its own dispatch only,
// and from then on nothing goes through the document. It lives with the extension's modules the tests load, since the
// build replaces the compiled extension folder with its bundles.
//
// The manifest loads the observer first, at document_start, and the relay right after it, before any of the page's
// scripts, so no page script can answer that first handshake. A relay can also come later: Chrome cuts the relay of
// every open tab off from the extension once the extension reloads, updates or is turned off and on, and puts the
// manifest's scripts only into documents that load afterwards, so the service worker injects a relay into each open
// Slack tab whose relay no longer answers (background.ts). The observer came with the document and has kept watching
// Slack's socket, so it answers every ready event with a channel of its own and keeps posting on every channel it
// handed out. A ready event a page script dispatched gets a copy of what the observer passes on, which the page holds
// anyway, and never takes the channel from the relay. A page script can also answer a later relay's ready event with a
// port of its own; page scripts are out of scope (observer.ts), and the relay checks whatever a port brings, which
// becomes events and status only.
export const RELAY_READY_EVENT = 'misha-relay-ready'
export const OBSERVER_PORT_EVENT = 'misha-observer-port'

// The observer's side runs in the page's world, where the page's scripts can replace any built-in once they run. A
// later handshake and every post run after them, so the built-ins they use are taken when the module loads, at
// document_start, and the channels are kept in an object without a prototype, where no setter a page script defined
// can run. The channel's port1 and port2 are read through MessageChannel's prototype, which a page script could replace;
// page scripts are out of scope, so this is not hardened against that.
const { apply } = Reflect
const { create } = Object
const NativeMessageChannel = MessageChannel
const NativeMessageEvent = MessageEvent
const listen = EventTarget.prototype.addEventListener
const dispatch = EventTarget.prototype.dispatchEvent
const postToPort = MessagePort.prototype.postMessage

// The observer's side: answers every relay's ready event on document with a channel of its own, and posts greeting()
// to the new relay alone, so a relay that comes later learns what the observer already knows. Returns what posts a
// message to every relay answered so far; before the first one, it posts nothing, so nothing piles up in a port nobody
// reads. A relay whose extension went away closes its port on the next message (relay.ts), and posts to it go nowhere.
export const answerRelays = (document: EventTarget, greeting: () => object): ((message: object) => void) => {
  const relays = create(null) as Record<number, MessagePort>
  let relayCount = 0

  apply(listen, document, [
    RELAY_READY_EVENT,
    () => {
      const channel = new NativeMessageChannel()
      apply(dispatch, document, [new NativeMessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] })])
      relays[relayCount] = channel.port1
      relayCount += 1
      apply(postToPort, channel.port1, [greeting()])
    },
  ])

  return (message) => {
    for (let index = 0; index < relayCount; index += 1) {
      apply(postToPort, relays[index], [message])
    }
  }
}

// The relay's side, in the extension's isolated world, whose built-ins no page script can reach: dispatches the ready
// event on document and gives each port offered during that dispatch onMessage. A port offered at any other time finds
// no listener.
export const takeObserverPorts = (document: EventTarget, onMessage: (event: MessageEvent<unknown>) => void): void => {
  const takePort = (event: Event): void => {
    const [port] = event instanceof MessageEvent ? event.ports : []
    if (port !== undefined) {
      port.onmessage = onMessage
    }
  }

  document.addEventListener(OBSERVER_PORT_EVENT, takePort)
  document.dispatchEvent(new CustomEvent(RELAY_READY_EVENT))
  document.removeEventListener(OBSERVER_PORT_EVENT, takePort)
}
