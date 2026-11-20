import { isSecretShaped } from './request-redaction.js'

// What the service worker reads from a request a Slack page sends, as Chrome's webRequest reports it: a safe
// projection made inside the listener, before anything keeps it. Only the fields named here keep a value, each only in
// the form it must have; every other value (the token, the cookie, a call's arguments, a file's address) is dropped
// where it is read.

// A workspace's Web API: https://<workspace>.slack.com/api/<method>, or <workspace>.enterprise.slack.com in an
// Enterprise Grid, the address the page command posts to (slack-page.ts).
const SLACK_API_HOSTNAME = /^[a-z0-9][a-z0-9-]*(?:\.enterprise)?\.slack\.com$/u
const SLACK_API_PATH = /^\/api\/(?<method>[a-z][A-Za-z]*(?:\.[A-Za-z]+)+)$/u
// Slack's private files and upload URLs (protocol slack.ts), where a request is known by its whole address.
const SLACK_FILES_ORIGIN = 'https://files.slack.com'

// The query fields of a Slack client's Web API call that belong to the request itself: a request id, and the attempt.
// Misha's request fills them with a fresh id in the client's form and 0, since the extension never retries.
const REQUEST_ID_FIELD = '_x_id'
const RETRIES_FIELD = '_x_num_retries'
const FIRST_ATTEMPT = '0'

// The query fields of the client's page session the transport borrows, each with the form its value must have; a
// field of another form, or any other field, is not borrowed. The repository's recorded client call names _x_id,
// _x_csid, slack_route, _x_version_ts, _x_gantry, fp and _x_num_retries; _x_frontend_build_type and _x_desktop_ia are
// the other fields public reimplementations of Slack's web client send. A field the client sends and this list lacks
// shows in the transport check as one Misha's request is missing. _x_reason, which names the action behind one call
// of the client, is never borrowed.
const BORROWED_QUERY_FORMS: Readonly<Record<string, RegExp>> = {
  _x_csid: /^[\w.-]{1,64}$/u,
  slack_route: /^[A-Z0-9]{2,32}(?::[A-Z0-9]{2,32})*$/u,
  _x_version_ts: /^\d{1,16}$/u,
  _x_frontend_build_type: /^[a-z_]{1,32}$/u,
  _x_desktop_ia: /^\d{1,4}$/u,
  _x_gantry: /^(?:true|false)$/u,
  fp: /^[\da-f]{1,16}$/u,
}

// The client's query as the transport borrows it, in the client's order: each borrowed field with its value, and the
// request's own fields by name only (a null value), filled for each request.
export type BorrowedQuery = readonly (readonly [name: string, value: string | null])[]

// The Web API method a request calls on a workspace's API; null for any other request.
export const apiMethodOf = (url: URL): string | null =>
  url.protocol === 'https:' && url.port === '' && SLACK_API_HOSTNAME.test(url.hostname)
    ? (SLACK_API_PATH.exec(url.pathname)?.groups?.method ?? null)
    : null

// What a request of Misha's is known by while it runs: a Web API call by the _x_id the service worker gave it, a
// private file or an upload by its whole address. null for a request that has neither.
export const requestKeyOf = (url: URL): string | null => {
  if (apiMethodOf(url) !== null) {
    return url.searchParams.get(REQUEST_ID_FIELD)
  }

  return url.origin === SLACK_FILES_ORIGIN ? url.href : null
}

const isBorrowable = (name: string, value: string): boolean => {
  const form = Object.hasOwn(BORROWED_QUERY_FORMS, name) ? BORROWED_QUERY_FORMS[name] : undefined

  return form?.test(value) === true && !isSecretShaped(value)
}

// The query a client's Web API call lends the transport, whatever method it calls; null for a request that is no Web
// API call, or one with no request id or no workspace route, so no call of the client's to borrow from.
export const borrowedQueryOf = (url: URL): BorrowedQuery | null => {
  const route = url.searchParams.get('slack_route')
  const isClientCall = apiMethodOf(url) !== null && url.searchParams.has(REQUEST_ID_FIELD)
  if (!isClientCall || route === null || !isBorrowable('slack_route', route)) {
    return null
  }

  return [...url.searchParams].flatMap(([name, value]): BorrowedQuery => {
    if (name === REQUEST_ID_FIELD || name === RETRIES_FIELD) {
      return [[name, null]]
    }

    return isBorrowable(name, value) ? [[name, value]] : []
  })
}

// A request id in the form Slack's client gives its own: eight hex digits, then the time in seconds to the millisecond.
export const freshRequestId = (): string => `${crypto.randomUUID().slice(0, 8)}-${(Date.now() / 1000).toFixed(3)}`

// The query of Misha's request: the borrowed fields as the client sent them, with requestId and a first attempt in
// the request's own fields.
export const borrowedQueryString = (query: BorrowedQuery, requestId: string): string =>
  new URLSearchParams(
    query.map(([name, value]) => [name, value ?? (name === REQUEST_ID_FIELD ? requestId : FIRST_ATTEMPT)])
  ).toString()
