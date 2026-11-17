// Chrome's minimum alarm period. An open native port keeps the service worker alive, so the alarm only matters while
// the host is not installed yet or has stopped.
export const RECONNECT_ALARM = 'reconnect'
export const RECONNECT_PERIOD_MINUTES = 0.5

export const SLACK_ORIGIN = 'https://app.slack.com'
export const SLACK_TAB_URL = `${SLACK_ORIGIN}/*`

// Slack's real-time socket (wss-primary.slack.com, opened by the page's own scripts on the main thread).
export const SLACK_SOCKET_HOSTNAME = /^wss-[a-z]+\.slack\.com$/u

// The page's observer and the extension's relay in the isolated world talk through events on the document, the one
// thing their worlds share. Page scripts can see and send these too, so they carry only what the page already has, and
// the service worker checks everything that reaches it.
export const OBSERVED_FRAME_EVENT = 'misha-observed-frame'
export const OBSERVED_SOCKET_EVENT = 'misha-observed-socket'
export const RELAY_READY_EVENT = 'misha-relay-ready'

// The message the service worker sends a tab's relay to learn its observer's socket state.
export const CAPTURE_QUERY = 'misha-capture-query'
