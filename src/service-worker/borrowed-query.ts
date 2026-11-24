import { VALUE_SHAPES } from './request-redaction.js'

// The query of Slack's client the transport borrows for its Web API calls, and the rules every value it keeps follows.
// A projection made where a URL is read, before anything keeps it: only the fields named here keep a value, each only in
// the form it must have; every other value (the token, a call's arguments) is dropped where it is read. It imports no
// schema library, so the page's observer can bundle it (client-query-keeper.ts), and lives with the extension's modules
// the tests load, since the build replaces the compiled extension folder with its bundles.

// A workspace's Web API: https://<workspace>.slack.com/api/<method>, or <workspace>.enterprise.slack.com in an
// Enterprise Grid, the address the page command posts to (slack-page.ts).
export const SLACK_API_HOSTNAME = /^[a-z0-9][a-z0-9-]*(?:\.enterprise)?\.slack\.com$/u
const SLACK_API_PATH = /^\/api\/(?<method>[a-z][A-Za-z]*(?:\.[A-Za-z]+)+)$/u

// The query fields of a Slack client's Web API call that belong to the request itself: a request id, and the attempt.
// Misha's request fills them with a fresh id in the client's form and 0, since the extension never retries.
export const REQUEST_ID_FIELD = '_x_id'
const RETRIES_FIELD = '_x_num_retries'
const FIRST_ATTEMPT = '0'
const ROUTE_FIELD = 'slack_route'

// The query fields of the client's page session the transport borrows, each with the form its value must have; a
// field of another form, or any other field, is not borrowed. Slack's web client builds its default Web API query
// (generateQueryString in its client bundle) from the page, the session and the team, never from the method called,
// though a call may replace it with a query of its own: _x_gantry and _x_desktop_ia, then _x_csid, slack_route,
// _x_version_ts, the focus field and _x_frontend_build_type, then fp and _x_num_retries as each attempt is sent.
// - _x_csid is borrowed with the rest, and the page command sends the id of the activity session it records in its
//   place (slack-page.ts).
// - The focus field is _x_foreground=true or _x_background=true, which the client works out from its window's focus
//   as it dispatches each call, or neither while the window was never focused. The transport carries the one the
//   client's latest call carried, so its value is the client's as of that call, not as of Misha's.
// - _x_frontend_build_type is the page's build: current, or next with an optional number from 2 to 999, a hyphen and
//   4 to 40 lower-case hex digits, the forms the client itself accepts.
// The client also writes fields this list lacks, so the transport check shows each as missing from Misha's request
// whenever the client's request carries it: force_agentic_ia and force_agentic_ia_experimental under a local
// override, feature_*, force_*, country* and _x_fail_apis copied from the page's address, and _x_b3_traceid,
// _x_b3_spanid and _x_b3_sampled on a traced call. _x_reason, which names the action behind one call of the client,
// is never borrowed.
const BORROWED_QUERY_FORMS: Readonly<Record<string, RegExp>> = {
  _x_csid: /^[\w.-]{1,64}$/u,
  slack_route: /^[A-Z0-9]{2,32}(?::[A-Z0-9]{2,32})*$/u,
  _x_version_ts: /^\d{1,16}$/u,
  _x_foreground: /^true$/u,
  _x_background: /^true$/u,
  _x_frontend_build_type: /^(?:current|next(?:[2-9]|[1-9]\d{1,2})?-[\da-f]{4,40})$/u,
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

// The shapes of known secrets the redaction finds (request-redaction.ts), found anywhere in a text and in any letter
// case: without the word boundaries the redaction matches them at, since a name or value may glue a secret to what
// comes before or after it (_x_<token>_suffix), and case-insensitive, since a header name and the content type are kept
// lower-cased, which changes a mixed-case prefix (AIza, eyJ). The catalog holds \b only as a word boundary.
const WORD_BOUNDARY = String.raw`\b`
const EMBEDDED_SECRET_SHAPES = VALUE_SHAPES.map((shape) => new RegExp(shape.source.replaceAll(WORD_BOUNDARY, ''), 'iu'))

export const holdsSecret = (text: string): boolean => EMBEDDED_SECRET_SHAPES.some((shape) => shape.test(text))

// The value when forms lists the field and the value is of its form, and holds nothing shaped like a secret; null
// otherwise.
export const formedValue = (forms: Readonly<Record<string, RegExp>>, name: string, value: string): string | null => {
  const form = Object.hasOwn(forms, name) ? forms[name] : undefined

  return form?.test(value) === true && !holdsSecret(value) ? value : null
}

const isBorrowable = (name: string, value: string): boolean => formedValue(BORROWED_QUERY_FORMS, name, value) !== null

// The query a client's Web API call lends the transport, whatever method it calls; null for a request that is no Web
// API call, or one with no request id or no workspace route, so no call of the client's to borrow from.
export const borrowedQueryOf = (url: URL): BorrowedQuery | null => {
  const route = url.searchParams.get(ROUTE_FIELD)
  const isClientCall = apiMethodOf(url) !== null && url.searchParams.has(REQUEST_ID_FIELD)
  if (!isClientCall || route === null || !isBorrowable(ROUTE_FIELD, route)) {
    return null
  }

  return [...url.searchParams].flatMap(([name, value]): BorrowedQuery => {
    if (name === REQUEST_ID_FIELD || name === RETRIES_FIELD) {
      return [[name, null]]
    }

    return isBorrowable(name, value) ? [[name, value]] : []
  })
}

// Whether a query is one borrowedQueryOf can give, the check of a query that crossed a boundary: each field a borrowed
// one with a value of its form, or one of the request's own fields by name only, with a request id and a workspace
// route among them.
export const isBorrowedQuery = (query: BorrowedQuery): boolean => {
  const names = query.map(([name]) => name)
  const isEachKept = query.every(([name, value]) =>
    value === null ? name === REQUEST_ID_FIELD || name === RETRIES_FIELD : isBorrowable(name, value)
  )

  return isEachKept && names.includes(REQUEST_ID_FIELD) && names.includes(ROUTE_FIELD)
}

// Whether text is a workspace API's origin as URL writes one: https, no port, and a workspace host on Slack's domain.
export const isApiOrigin = (text: string): boolean => {
  const url = URL.parse(text)

  return url?.origin === text && url.protocol === 'https:' && url.port === '' && SLACK_API_HOSTNAME.test(url.hostname)
}

// A request id in the form Slack's client gives its own: eight hex digits, then the time in seconds to the millisecond.
export const freshRequestId = (): string => `${crypto.randomUUID().slice(0, 8)}-${(Date.now() / 1000).toFixed(3)}`

// The query of Misha's request: the borrowed fields as the client sent them, with requestId and a first attempt in
// the request's own fields.
export const borrowedQueryString = (query: BorrowedQuery, requestId: string): string =>
  new URLSearchParams(
    query.map(([name, value]) => [name, value ?? (name === REQUEST_ID_FIELD ? requestId : FIRST_ATTEMPT)])
  ).toString()
