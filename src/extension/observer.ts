import { OBSERVED_FRAME_EVENT, OBSERVED_SOCKET_EVENT, RELAY_READY_EVENT, SLACK_SOCKET_HOSTNAME } from './config.js'

// Runs in the page's own world at document_start, before Slack's scripts, so it wraps WebSocket before Slack opens its
// socket. It only reads: frames that are messages go to the extension's relay as their raw text, and so does whether a
// socket is open. It sends nothing on the socket, and never passes the socket's URL on, since the URL carries a token.

const openSockets = new Set<WebSocket>()

const announce = (name: string, detail: string): void => {
  document.dispatchEvent(new CustomEvent(name, { detail }))
}

const announceSocketState = (): void => {
  announce(OBSERVED_SOCKET_EVENT, JSON.stringify({ isSocketOpen: openSockets.size > 0 }))
}

// Slack's socket also carries presence, typing and pings; only messages go on.
const isMessageFrame = (text: string): boolean => {
  const frame: unknown = JSON.parse(text)

  return typeof frame === 'object' && frame !== null && 'type' in frame && frame.type === 'message'
}

const observe = (socket: WebSocket): void => {
  socket.addEventListener('open', () => {
    openSockets.add(socket)
    announceSocketState()
  })
  socket.addEventListener('close', () => {
    openSockets.delete(socket)
    announceSocketState()
  })
  socket.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
    if (typeof data === 'string' && isMessageFrame(data)) {
      announce(OBSERVED_FRAME_EVENT, data)
    }
  })
}

const isSlackSocket = (url: string | URL): boolean => {
  const { protocol, hostname } = new URL(url, location.href)

  return protocol === 'wss:' && SLACK_SOCKET_HOSTNAME.test(hostname)
}

// A proxy keeps WebSocket's name, prototype and constants, so the page sees the class it expects.
window.WebSocket = new Proxy(window.WebSocket, {
  construct: (target, args: ConstructorParameters<typeof WebSocket>, newTarget: typeof WebSocket) => {
    const socket = Reflect.construct(target, args, newTarget)
    if (isSlackSocket(args[0])) {
      observe(socket)
    }

    return socket
  },
})

// The relay may load after this script; it asks for the state once it listens.
document.addEventListener(RELAY_READY_EVENT, announceSocketState)
announceSocketState()
