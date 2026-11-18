// Chrome's minimum alarm period. An open native port keeps the service worker alive, so the alarm only matters while
// the host is not installed yet or has stopped.
export const RECONNECT_ALARM = 'reconnect'
export const RECONNECT_PERIOD_MINUTES = 0.5

export const SLACK_ORIGIN = 'https://app.slack.com'
export const SLACK_TAB_URL = `${SLACK_ORIGIN}/*`

// Slack's real-time socket (wss-primary.slack.com, opened by the page's own scripts on the main thread).
export const SLACK_SOCKET_HOSTNAME = /^wss-[a-z]+\.slack\.com$/u

// The workspace a Slack tab shows: the team in its /client/<team> path.
export const SLACK_CLIENT_PATH = /^\/client\/(?<teamId>[TE][A-Z0-9]+)/u

// Slack's saved client state in the page's localStorage: each workspace under teams, with its signed-in user_id.
export const SLACK_CLIENT_STATE_KEY = 'localConfig_v2'

// The page's observer and the extension's relay in the isolated world share only the document, and use it once, at
// document_start before any of the page's scripts run. The manifest loads the observer first, and it listens for
// RELAY_READY_EVENT; the relay dispatches that event, and while it does, the observer answers with OBSERVER_PORT_EVENT,
// a MessageEvent carrying one end of a MessageChannel. The relay listens for the port only during its own dispatch, so
// no page script can ever hand it one, and from then on nothing goes through the document.
export const RELAY_READY_EVENT = 'misha-relay-ready'
export const OBSERVER_PORT_EVENT = 'misha-observer-port'

// The message the service worker sends a tab's relay to learn its observer's socket state.
export const CAPTURE_QUERY = 'misha-capture-query'

// The tab commands. A tab that is still loading after LOAD_TIMEOUT_MS is answered as it is; a slow page is no error.
export const LOAD_POLL_INTERVAL_MS = 100
export const LOAD_TIMEOUT_MS = 10_000

// After an action, a page has settled once the requests the action started have finished and the page has gone this
// long without a change. One that keeps changing (a ticking clock) or keeps a request open (a streamed reply) is taken
// as settled at the timeout.
export const QUIET_PAGE_MS = 150
export const SETTLE_TIMEOUT_MS = 3_000
export const REQUEST_POLL_INTERVAL_MS = 50

export const SCREENSHOT_JPEG_QUALITY = 80

export const DOWNLOAD_POLL_INTERVAL_MS = 100
