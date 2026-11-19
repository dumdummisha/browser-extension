// How a Slack tab's observer, in the page's own world, and the extension's relay, in its isolated world, open their
// private channel (extension/observer.ts, relay.ts), and what each passes back on it. They share only the document. The
// relay dispatches RELAY_READY_EVENT on it, and while that event is dispatched, the observer answers with
// OBSERVER_PORT_EVENT, a MessageEvent carrying one end of a new MessageChannel. The relay takes the ports offered during
// its own dispatch only, and from then on nothing goes through the document. It lives with the extension's modules the
// tests load, since the build replaces the compiled extension folder with its bundles.
//
// The manifest loads the observer first, at document_start, and the relay right after it, before any of the page's
// scripts, so no page script can answer that first handshake. A relay can also come later: Chrome cuts the relay of
// every open tab off from the extension once the extension reloads, updates or is turned off and on, and puts the
// manifest's scripts only into documents that load afterwards, so the service worker injects a relay into each open
// Slack tab whose relay no longer runs (background.ts). The observer came with the document and has kept watching
// Slack's socket, so it answers every ready event with a channel of its own and keeps posting on every channel it
// handed out. A ready event a page script dispatched gets a copy of what the observer passes on, which the page holds
// anyway, and never takes the channel from the relay. A page script can also answer a later relay's ready event with a
// port of its own, or report frames taken on a port it asked for; page scripts are out of scope (observer.ts), and the
// relay checks whatever a port brings, which becomes events and status only.
//
// A relay cut off by a reload passes nothing on, and its replacement asks for a channel only once the new service
// worker injected it, so a new message can reach the observer while no relay passes anything on. The observer holds
// each one, under a sequence number, until a relay reports that the service worker took it (FRAME_TAKEN), and posts
// every frame it still holds to each relay that asks after its greeting. A frame two relays pass on reaches the service
// worker twice under the same event id, which its pending queue and the app's receipts take once.
export const RELAY_READY_EVENT = 'misha-relay-ready'
export const OBSERVER_PORT_EVENT = 'misha-observer-port'

// What a relay posts back on its channel once the service worker took a frame it passed on: { kind, seq }, with the
// frame's sequence number.
export const FRAME_TAKEN = 'taken'

// The frames the observer holds at most. A reload leaves a tab without a relay for a moment, in which a few messages
// come at most; only an extension that stays away (turned off) leaves more untaken, and past this the oldest one held
// is dropped.
export const HELD_FRAMES_MAX = 50

// The observer's side runs in the page's world, where the page's scripts can replace any built-in once they run. A
// later handshake, every post and every report run after them, so the built-ins they use are taken when the module
// loads, at document_start, and what the observer keeps is kept in objects without a prototype, where no setter a page
// script defined can run. The channel's port1 and port2 are read through MessageChannel's prototype, which a page script
// could replace; page scripts are out of scope, so this is not hardened against that.
const { apply, deleteProperty, get: valueAt } = Reflect
const { create, getOwnPropertyDescriptor, hasOwn } = Object
const NativeMessageChannel = MessageChannel
const NativeMessageEvent = MessageEvent
const listen = EventTarget.prototype.addEventListener
const dispatch = EventTarget.prototype.dispatchEvent
const postToPort = MessagePort.prototype.postMessage
const startPort = MessagePort.prototype.start
const messageData = getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get
if (messageData === undefined) {
  throw new Error('The capture handshake found no MessageEvent data to read')
}

const ownValue = (record: object, key: string): unknown => (hasOwn(record, key) ? valueAt(record, key) : undefined)

// The frames the observer holds, oldest first, each under the next sequence number.
export interface IFrameHold {
  // Holds the message as a frame under the next sequence number, dropping the oldest one held when max are, and
  // answers the frame as it goes to the relays: the message with its sequence number as seq.
  readonly hold: (message: object) => object
  // Stops holding the frame numbered seq; a number held under no frame changes nothing.
  readonly release: (seq: number) => void
  // Each frame held, oldest first.
  readonly forEach: (visit: (frame: object) => void) => void
}

export const holdFrames = (max: number): IFrameHold => {
  const held = create(null) as Record<number, object>
  let nextSeq = 0
  // No frame below it is held: the oldest held one, or nextSeq when none is.
  let oldestSeq = 0
  let heldCount = 0

  const release = (seq: number): void => {
    if (!hasOwn(held, seq)) {
      return
    }

    deleteProperty(held, seq)
    heldCount -= 1
    while (oldestSeq < nextSeq && !hasOwn(held, oldestSeq)) {
      oldestSeq += 1
    }
  }

  return {
    hold: (message) => {
      if (heldCount === max) {
        release(oldestSeq)
      }

      const frame = { ...message, seq: nextSeq }
      held[nextSeq] = frame
      nextSeq += 1
      heldCount += 1

      return frame
    },
    release,
    forEach: (visit) => {
      for (let seq = oldestSeq; seq < nextSeq; seq += 1) {
        const frame = held[seq]
        if (frame !== undefined) {
          visit(frame)
        }
      }
    },
  }
}

// What the observer posts on: the state as it stands, and new messages, which must reach the service worker.
export interface IRelayLinks {
  // To every relay answered so far. A relay that comes later learns the state from its greeting.
  readonly postState: (message: object) => void
  // Held as a frame until a relay reports it taken, and posted to every relay answered so far. A relay that comes later
  // gets every frame still held, after its greeting.
  readonly postFrame: (message: object) => void
}

// The observer's side: answers every relay's ready event on document with a channel of its own, and posts greeting()
// to the new relay, then each frame hold still holds. Before the first relay asks, nothing is posted, so nothing piles
// up in a port nobody reads. A relay whose extension went away closes its port on the next message (relay.ts), and
// posts to it go nowhere.
export const answerRelays = (document: EventTarget, greeting: () => object, hold: IFrameHold): IRelayLinks => {
  const relays = create(null) as Record<number, MessagePort>
  let relayCount = 0

  const onRelayReport = (event: Event): void => {
    const report: unknown = apply(messageData, event, [])
    if (typeof report !== 'object' || report === null || ownValue(report, 'kind') !== FRAME_TAKEN) {
      return
    }

    const seq = ownValue(report, 'seq')
    if (typeof seq === 'number') {
      hold.release(seq)
    }
  }

  const postToRelays = (message: object): void => {
    for (let index = 0; index < relayCount; index += 1) {
      apply(postToPort, relays[index], [message])
    }
  }

  apply(listen, document, [
    RELAY_READY_EVENT,
    () => {
      const channel = new NativeMessageChannel()
      const port = channel.port1
      apply(dispatch, document, [new NativeMessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] })])
      apply(listen, port, ['message', onRelayReport])
      apply(startPort, port, [])
      relays[relayCount] = port
      relayCount += 1
      apply(postToPort, port, [greeting()])
      hold.forEach((frame) => {
        apply(postToPort, port, [frame])
      })
    },
  ])

  return {
    postState: postToRelays,
    postFrame: (message) => {
      postToRelays(hold.hold(message))
    },
  }
}

// The relay's side, in the extension's isolated world, whose built-ins no page script can reach: dispatches the ready
// event on document, and each message a port offered during that dispatch brings goes to onMessage with that port. A
// port offered at any other time finds no listener.
export const takeObserverPorts = (
  document: EventTarget,
  onMessage: (data: unknown, port: MessagePort) => void
): void => {
  const takePort = (event: Event): void => {
    const [port] = event instanceof MessageEvent ? event.ports : []
    if (port !== undefined) {
      port.onmessage = ({ data }: MessageEvent<unknown>) => {
        onMessage(data, port)
      }
    }
  }

  document.addEventListener(OBSERVER_PORT_EVENT, takePort)
  document.dispatchEvent(new CustomEvent(RELAY_READY_EVENT))
  document.removeEventListener(OBSERVER_PORT_EVENT, takePort)
}

// The relay tells the observer, on the port the frame came on, that the service worker took the frame numbered seq.
export const reportTaken = (port: MessagePort, seq: number): void => {
  port.postMessage({ kind: FRAME_TAKEN, seq })
}
