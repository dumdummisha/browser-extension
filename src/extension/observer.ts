import { projectedMessageOf } from '../service-worker/message-projection.js'
import {
  OBSERVER_PORT_EVENT,
  RELAY_READY_EVENT,
  SLACK_CLIENT_PATH,
  SLACK_CLIENT_STATE_KEY,
  SLACK_SOCKET_HOSTNAME,
} from './config.js'

// Runs in the page's own world at document_start, before Slack's scripts, so it wraps WebSocket before Slack opens its
// socket. It only reads: it sends nothing on the socket, and never passes the socket's URL on, since the URL carries a
// token. It hands the extension's relay one end of a private channel (config.ts), and passes on it only what it takes
// from Slack's socket itself: whether a socket is open, and each new message cut down to the fields the app reads, with
// the account the tab showed when it came.
//
// Slack's scripts, and anything else the page runs later, share this world and can replace any built-in. So every
// built-in that decides what the relay gets is taken here before they run (and in message-projection.ts), and only
// events the browser itself dispatched count (isTrusted), never one a page script dispatched on a socket.
const { apply, construct } = Reflect
const { getOwnPropertyDescriptor } = Object
const NativeUrl = URL
const execPattern = RegExp.prototype.exec
const listen = EventTarget.prototype.addEventListener
const postToPort = MessagePort.prototype.postMessage
const storedItem = Storage.prototype.getItem
const parseJson = JSON.parse

const getterOf = (prototype: object, name: string): (() => unknown) => {
  const getter = getOwnPropertyDescriptor(prototype, name)?.get
  if (getter === undefined) {
    throw new Error(`The observer found no ${name} to read`)
  }

  return getter
}

const messageData = getterOf(MessageEvent.prototype, 'data')
const urlProtocol = getterOf(URL.prototype, 'protocol')
const urlHostname = getterOf(URL.prototype, 'hostname')

const channel = new MessageChannel()
// Set once the relay holds the other end. Nothing is posted before, so nothing piles up in a port nobody reads.
let isHandedOver = false
let openSockets = 0

const toRelay = (message: object): void => {
  if (isHandedOver) {
    apply(postToPort, channel.port1, [message])
  }
}

const reportSocketState = (): void => {
  toRelay({ kind: 'socket', isSocketOpen: openSockets > 0 })
}

const matches = (pattern: RegExp, text: unknown): RegExpExecArray | null =>
  typeof text === 'string' ? apply(execPattern, pattern, [text]) : null

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

// The user this tab is signed in as in workspace teamId, from Slack's saved client state, where the service worker's
// identity read finds it too (slack-page.ts); undefined when the state names none. A JSON parser's error quotes the text
// it failed on, which holds the token, so a state that does not parse fails in words of its own.
const signedInUserOf = (teamId: string): string | undefined => {
  const saved: unknown = apply(storedItem, localStorage, [SLACK_CLIENT_STATE_KEY])
  if (typeof saved !== 'string') {
    return undefined
  }

  let state: unknown
  try {
    state = parseJson(saved)
  } catch {
    throw new Error("Slack's saved client state does not read")
  }

  const team = isRecord(state) && isRecord(state.teams) ? state.teams[teamId] : undefined
  const userId = isRecord(team) ? team.user_id : undefined

  return typeof userId === 'string' ? userId : undefined
}

// Listens for the socket's events the browser dispatched; one a page script dispatched on the socket is not Slack's.
const onTrusted = (socket: WebSocket, type: string, handler: (event: Event) => void): void => {
  apply(listen, socket, [
    type,
    (event: Event) => {
      if (event.isTrusted) {
        handler(event)
      }
    },
  ])
}

const observe = (socket: WebSocket): void => {
  let isOpen = false
  onTrusted(socket, 'open', () => {
    isOpen = true
    openSockets += 1
    reportSocketState()
  })
  // A socket that never opened closes too.
  onTrusted(socket, 'close', () => {
    if (isOpen) {
      openSockets -= 1
      reportSocketState()
    }
  })
  // The account is read as the message comes, so the service worker can drop it if the tab is signed in as another
  // account by the time it is admitted. A tab that shows no workspace, or no user for it, keys nothing.
  onTrusted(socket, 'message', (event) => {
    const data: unknown = apply(messageData, event, [])
    const frame = typeof data === 'string' ? projectedMessageOf(data) : null
    const teamId = matches(SLACK_CLIENT_PATH, location.pathname)?.groups?.teamId
    if (frame === null || teamId === undefined) {
      return
    }

    const userId = signedInUserOf(teamId)
    if (userId !== undefined) {
      toRelay({ kind: 'frame', account: { teamId, userId }, frame })
    }
  })
}

const isSlackSocket = (url: string): boolean => {
  const parsed: unknown = construct(NativeUrl, [url, location.href])

  return (
    apply(urlProtocol, parsed, []) === 'wss:' && matches(SLACK_SOCKET_HOSTNAME, apply(urlHostname, parsed, [])) !== null
  )
}

// A proxy keeps WebSocket's name, prototype and constants, so the page sees the class it expects. The URL is read once,
// so the socket that opens is the one checked.
window.WebSocket = new Proxy(window.WebSocket, {
  construct: (target, args: ConstructorParameters<typeof WebSocket>, newTarget: typeof WebSocket) => {
    const url = `${args[0]}`
    const socket: WebSocket = construct(target, [url, args[1]], newTarget)
    if (isSlackSocket(url)) {
      observe(socket)
    }

    return socket
  },
})

// The relay dispatches RELAY_READY_EVENT right after this script runs, before the page's scripts, and takes the port
// while it does (config.ts). Only the first ready event is answered.
document.addEventListener(
  RELAY_READY_EVENT,
  () => {
    document.dispatchEvent(new MessageEvent(OBSERVER_PORT_EVENT, { ports: [channel.port2] }))
    isHandedOver = true
    reportSocketState()
  },
  { once: true }
)
