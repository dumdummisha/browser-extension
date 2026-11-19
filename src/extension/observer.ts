import { answerRelays } from '../service-worker/capture-handshake.js'
import { projectedMessageOf } from '../service-worker/message-projection.js'
import { SLACK_CLIENT_PATH, SLACK_CLIENT_STATE_KEY, SLACK_SOCKET_HOSTNAME } from './config.js'

// Runs in the page's own world at document_start, before Slack's scripts, so it wraps WebSocket before Slack opens its
// socket. It only reads: it sends nothing on the socket, and never passes the socket's URL on, since the URL carries a
// token. It hands each relay of the extension one end of a private channel (capture-handshake.ts), and passes on them
// only what it takes from Slack's socket itself: whether a socket is open, and each new message cut down to the fields
// the app reads, with the account the tab showed when it came.
//
// Threat model (README, Security): scripts already running in the page, Slack's own or another extension's in this
// world, are out of scope, since such a script already holds the session and token and can send them anywhere itself.
// The guarantees are that the extension's own code never moves a credential out of the page, and that Slack message
// content, remote data that never runs as script, reaches the relay only as a cut-down message that becomes an event,
// never as a command, an API call or an ack. The built-ins taken at load (here, in message-projection.ts and in
// capture-handshake.ts) and the isTrusted check keep what the observer reads the same when the page's scripts later
// replace a built-in or dispatch events of their own; they are not a boundary against such a script.
const { apply, construct } = Reflect
const { getOwnPropertyDescriptor } = Object
const NativeUrl = URL
const execPattern = RegExp.prototype.exec
const listen = EventTarget.prototype.addEventListener
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

let openSockets = 0

const socketState = (): object => ({ kind: 'socket', isSocketOpen: openSockets > 0 })

// Every relay that asked gets the socket state as it stands, and then each change and each new message. A relay the
// service worker injects after the extension reloaded asks while the socket is already open, and learns so at once.
const toRelays = answerRelays(document, socketState)

const reportSocketState = (): void => {
  toRelays(socketState())
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
      toRelays({ kind: 'frame', account: { teamId, userId }, frame })
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
