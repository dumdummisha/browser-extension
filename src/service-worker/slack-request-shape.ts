import { type ParityDifference, type SlackOperation, SlackOperationSchema } from '../protocol/slack.js'
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

// The transport check compares a request of Misha's with the client's request for the same operation by these rules,
// beside the query fields above:
// - Excluded, neither name nor value: _x_id and _x_reason (the request's own id, and the action behind one call of the
//   client, which Misha does not take), every body field but the client's own _x_ fields (the call's arguments, the
//   token among them), and the query of a file's address (a download and an upload take their address from the call).
// - Compared by name only: every query field, since Misha's take their values from the page's own client, so a value
//   could differ only between pages; every header and _x_ body field outside the value lists below (cookie and
//   content-length among them); and a listed field whose value is not of its form.
// - Compared by value too: the HTTP method, the listed headers and _x_ body fields, and the encoding, which is the
//   media type of content-type.
// - Never named: a field whose name is not of the name form or is shaped like a secret.
const EXCLUDED_FIELDS = new Set([REQUEST_ID_FIELD, '_x_reason'])
const CLIENT_FIELD_PREFIX = '_x_'
const HTTP_METHOD = /^[A-Z]{3,7}$/u
const HEADER_NAME = /^[a-z0-9-]{1,64}$/u
const FIELD_NAME = /^[\w.-]{1,64}$/u
const CONTENT_TYPE_HEADER = 'content-type'
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,64}$/u

// The headers whose values the browser and the page decide, never the call, as the Fetch standard and Chrome set them
// on a fetch or an XHR from Slack's page, each with the form its value must have. A referer is kept only as an origin,
// so no page address it could carry is kept.
const HEADER_VALUE_FORMS: Readonly<Record<string, RegExp>> = {
  'accept': /^[\w.+*/;=, -]{1,256}$/u,
  'accept-encoding': /^[\w.*;=, -]{1,128}$/u,
  'accept-language': /^[\w.*;=, -]{1,128}$/u,
  'origin': /^https:\/\/[a-z0-9.-]{1,128}$/u,
  'priority': /^[a-z0-9=, ]{1,32}$/u,
  'referer': /^https:\/\/[a-z0-9.-]{1,128}\/$/u,
  'sec-ch-ua': /^"[^"\\]{1,64}";v="[\d.]{1,16}"(?:, "[^"\\]{1,64}";v="[\d.]{1,16}"){0,8}$/u,
  'sec-ch-ua-mobile': /^\?[01]$/u,
  'sec-ch-ua-platform': /^"[\w ]{1,32}"$/u,
  'sec-fetch-dest': /^[a-z-]{1,32}$/u,
  'sec-fetch-mode': /^[a-z-]{1,32}$/u,
  'sec-fetch-site': /^[a-z-]{1,32}$/u,
  'user-agent': /^[\w .,;:()/+-]{1,512}$/u,
}

// The client's own body fields of a Web API call whose values the client sets the same for every call, each with its
// form: the ones the page command sends (slack-page.ts).
const BODY_VALUE_FORMS: Readonly<Record<string, RegExp>> = {
  _x_mode: /^[a-z]{1,16}$/u,
  _x_sonic: /^(?:true|false)$/u,
  _x_app_name: /^[a-z_]{1,32}$/u,
}

const METHOD_DIFFERENCE: ParityDifference = { part: 'request', name: 'method', kind: 'value' }

// The client's query as the transport borrows it, in the client's order: each borrowed field with its value, and the
// request's own fields by name only (a null value), filled for each request.
export type BorrowedQuery = readonly (readonly [name: string, value: string | null])[]

// A part of a request as the check keeps it: each field by name, with its value only when its rule keeps one.
type Fields = ReadonlyMap<string, string | null>

// What the check keeps of a request when it starts: its operation, its HTTP method (null when not of its form), and
// the query field names and _x_ body fields of a Web API call. null for a part that is not compared: a file's query and
// body, or a body Chrome did not read as form fields.
export interface IStartedShape {
  readonly operation: SlackOperation
  readonly method: string | null
  readonly query: Fields | null
  readonly body: Fields | null
}

// The same once its headers were sent.
export interface IRequestShape extends IStartedShape {
  readonly headers: Fields
}

// A request body as webRequest reports it, in the fields the check reads.
export interface IRequestBody {
  readonly formData?: Readonly<Record<string, readonly (string | ArrayBuffer)[]>>
}

// A request header as webRequest reports it.
export interface IRequestHeader {
  readonly name: string
  readonly value?: string
}

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

// Whether text holds something shaped like a secret anywhere in it, in any letter case. Each suffix is tested on its
// own, so no character glued before a secret (an underscore, say) hides it from a pattern that starts at a word
// boundary, and the case variants catch a secret whose case a header name's normalization changed.
const hasSecretShape = (text: string): boolean =>
  [...new Set([text, text.toLowerCase(), text.toUpperCase()])].some((variant) =>
    Array.from({ length: variant.length }, (_unused, index) => variant.slice(index)).some((suffix) =>
      isSecretShaped(suffix)
    )
  )

// The value when forms lists the field and the value is of its form, and holds nothing shaped like a secret; null
// otherwise.
const formedValue = (forms: Readonly<Record<string, RegExp>>, name: string, value: string): string | null => {
  const form = Object.hasOwn(forms, name) ? forms[name] : undefined

  return form?.test(value) === true && !hasSecretShape(value) ? value : null
}

const isBorrowable = (name: string, value: string): boolean => formedValue(BORROWED_QUERY_FORMS, name, value) !== null

const isNameable = (name: string, form: RegExp): boolean => form.test(name) && !hasSecretShape(name)

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

// The operation of the transport a request performs: a Web API method the transport calls, a GET of a private file
// (download) or a POST of an upload's bytes (upload). null for any other request.
export const operationOf = (method: string, url: URL): SlackOperation | null => {
  const apiMethod = apiMethodOf(url)
  if (apiMethod !== null) {
    const operation = SlackOperationSchema.safeParse(apiMethod)

    return operation.success ? operation.data : null
  }

  if (url.origin !== SLACK_FILES_ORIGIN) {
    return null
  }

  const isUploadUrl = url.pathname.startsWith('/upload/')
  if (isUploadUrl && method === 'POST') {
    return 'upload'
  }

  return !isUploadUrl && method === 'GET' ? 'download' : null
}

const queryFieldsOf = (url: URL): Fields =>
  new Map(
    [...url.searchParams.keys()]
      .filter((name) => !EXCLUDED_FIELDS.has(name) && isNameable(name, FIELD_NAME))
      .map((name): [string, null] => [name, null])
  )

// No body (a GET) has no fields; a body Chrome did not read as form fields is not compared.
const bodyFieldsOf = (body: IRequestBody | undefined): Fields | null => {
  if (body === undefined) {
    return new Map()
  }

  if (body.formData === undefined) {
    return null
  }

  return new Map(
    Object.entries(body.formData)
      .filter(
        ([name]) => name.startsWith(CLIENT_FIELD_PREFIX) && !EXCLUDED_FIELDS.has(name) && isNameable(name, FIELD_NAME)
      )
      .map(([name, [value]]): [string, string | null] => [
        name,
        typeof value === 'string' ? formedValue(BODY_VALUE_FORMS, name, value) : null,
      ])
  )
}

// What the check keeps of a request as it starts; null for a request of no operation of the transport.
export const startedShapeOf = (method: string, url: URL, body: IRequestBody | undefined): IStartedShape | null => {
  const operation = operationOf(method, url)
  if (operation === null) {
    return null
  }

  const isApiCall = operation !== 'download' && operation !== 'upload'

  return {
    operation,
    method: HTTP_METHOD.test(method) ? method : null,
    query: isApiCall ? queryFieldsOf(url) : null,
    body: isApiCall ? bodyFieldsOf(body) : null,
  }
}

const headerValueOf = (name: string, value: string | undefined): string | null => {
  if (value === undefined) {
    return null
  }

  if (name !== CONTENT_TYPE_HEADER) {
    return formedValue(HEADER_VALUE_FORMS, name, value)
  }

  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? ''

  return MEDIA_TYPE.test(mediaType) && !hasSecretShape(mediaType) ? mediaType : null
}

// The headers a request was sent with, as the check keeps them, by lower-case name. A name is tested for a secret's
// shape as Chrome reported it, before lower-casing could change what a pattern sees.
export const headerFieldsOf = (headers: readonly IRequestHeader[]): Fields =>
  new Map(
    headers
      .filter(({ name }) => isNameable(name.toLowerCase(), HEADER_NAME) && !hasSecretShape(name))
      .map(({ name, value }): [string, string | null] => [name.toLowerCase(), headerValueOf(name.toLowerCase(), value)])
  )

const fieldDifferences = (part: ParityDifference['part'], client: Fields, misha: Fields): ParityDifference[] =>
  [...new Set([...client.keys(), ...misha.keys()])]
    .toSorted((first, second) => (first < second ? -1 : 1))
    .flatMap((name): ParityDifference[] => {
      if (!misha.has(name)) {
        return [{ part, name, kind: 'missing' }]
      }

      if (!client.has(name)) {
        return [{ part, name, kind: 'extra' }]
      }

      return client.get(name) === misha.get(name) ? [] : [{ part, name, kind: 'value' }]
    })

// How a request of Misha's differs from the client's request for the same operation, by name only. A value that is
// not of its form (null) differs from one that is.
export const differencesOf = (client: IRequestShape, misha: IRequestShape): ParityDifference[] => [
  ...(client.method === misha.method ? [] : [METHOD_DIFFERENCE]),
  ...fieldDifferences('header', client.headers, misha.headers),
  ...(client.query === null || misha.query === null ? [] : fieldDifferences('query', client.query, misha.query)),
  ...(client.body === null || misha.body === null ? [] : fieldDifferences('body', client.body, misha.body)),
]
