// Credentials in what a tab sends, redacted where the extension records it, before anything leaves the browser: a
// request's URL, body and headers in the network log, and every URL a tab command answers (a tab's, a page's, a
// download's). A body field (URL-encoded, JSON or multipart, a truncated body as far as it goes), query parameter or
// header whose name says it holds a credential loses its value, and so does any value shaped like a known token or key;
// the name stays, so the shape of an API stays readable. A URL also loses its userinfo. Pure, so the service worker and
// its specs share it.

export const REDACTED_VALUE = '[redacted]'

// The value of a body field, query parameter or header whose name, lower-cased and stripped of everything but letters
// and digits, contains one of these is redacted, so access_token, refreshToken, client_secret, X-Api-Key and
// user[password] all match.
const CREDENTIAL_NAME_PARTS = [
  'token',
  'password',
  'passwd',
  'secret',
  'apikey',
  'authorization',
  'credential',
  'cookie',
  'privatekey',
  'sessionid',
]

// Values shaped like a known secret, wherever they appear.
const VALUE_SHAPES = [
  // Every Slack xox token type: bot (xoxb), user (xoxp), app configuration (xoxa), refresh (xoxe), and the web
  // client's session token (xoxc) and cookie (xoxd).
  /\bxox[a-z]-[\w-]{10,}/u,
  // Slack app-level token.
  /\bxapp-[\w-]{10,}/u,
  // GitHub classic personal (ghp), OAuth (gho), user-to-server (ghu), server-to-server (ghs) and refresh (ghr) tokens.
  /\bgh[opsur]_[A-Za-z0-9]{36,}/u,
  // GitHub fine-grained personal access token.
  /\bgithub_pat_\w{22,}/u,
  // AWS access key id, long-term (AKIA) or temporary (ASIA).
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  // PEM private key block of any type: RSA, EC, OPENSSH, ENCRYPTED or a bare PKCS #8 key.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u,
  // Anthropic, then OpenAI API keys (legacy sk-, project sk-proj- and service account sk-svcacct- keys).
  /\bsk-ant-[\w-]{20,}/u,
  /\bsk-[\w-]{20,}/u,
  // Google API key and OAuth access token.
  /\bAIza[\w-]{35}/u,
  /\bya29\.[\w-]{20,}/u,
  // JSON Web Token: three base64url segments, the header's {" encoded as eyJ.
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/u,
  // A Bearer value.
  /\bBearer\s+[\w.~+/=-]{8,}/iu,
]

interface IJsonToken {
  readonly start: number
  readonly end: number
  // A string's unescaped content or a bare scalar's text; null for a punctuation mark.
  readonly content: string | null
  readonly isString: boolean
  readonly mark: string | null
}

interface ISpan {
  readonly start: number
  readonly end: number
  readonly replacement: string
}

interface IJsonStep {
  readonly span: ISpan | null
  readonly next: number
}

const JSON_START = /^\s*[{[]/u
// A string, whose closing quote a truncated body may have cut off, a punctuation mark, or a bare scalar.
const JSON_TOKEN = /"(?<literal>(?:[^"\\]|\\[\s\S])*)"?|(?<mark>[{}[\]:,])|[^\s{}[\]:,"]+/gu
const JSON_ESCAPE = /\\(?:u(?<hex>[\dA-Fa-f]{4})|(?<char>[\s\S]))/gu
const JSON_ESCAPED_CHARS = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
])
// How each bracket changes the nesting depth; every other token leaves it.
const JSON_DEPTH_CHANGE = new Map([
  ['{', 1],
  ['[', 1],
  ['}', -1],
  [']', -1],
])
const JSON_REDACTED_VALUE = JSON.stringify(REDACTED_VALUE)

// The extension sends a multipart body the browser did not parse into fields as it went out: a boundary line, then
// each part's headers, a blank line and its value.
const MULTIPART_START = /^--(?<boundary>[^\r\n]+)\r\nContent-Disposition:/iu
const MULTIPART_NAME = /\bname="(?<name>[^"]*)"/iu
const MULTIPART_HEADER_END = '\r\n\r\n'
const MULTIPART_LINE_END = '\r\n'

// A URL-encoded body never holds raw whitespace, so a text with an equals sign and none is read as one.
const FORM_BODY = /^\S*=\S*$/u
const FORM_FIELD_SEPARATOR = '&'
// A query string's or fragment's fields, between the marks that start and separate them.
const URL_FIELD = /[^?&#]+/gu
const URL_QUERY_START = /[?#]/u
// The userinfo of an absolute URL's authority, whatever it holds or encodes: up to the authority's last @, as the
// browser parses it.
const URL_USERINFO = /^(?<scheme>[a-z][\d+.a-z-]*:\/\/)[^/]*@/iu
// A run of well-formed percent escapes in a path segment; a malformed escape is left as written.
const PERCENT_ESCAPES = /(?:%[\dA-Fa-f]{2})+/gu
// A whole value that is an absolute URL, such as a Referer header or a redirect field, is redacted as a URL.
const ABSOLUTE_URL = /^[a-z][\d+.a-z-]*:\/\/\S*$/iu

export interface IRequestHeader {
  readonly name: string
  readonly value: string
}

export const redactHeaders = (headers: readonly IRequestHeader[]): IRequestHeader[] =>
  headers.map(({ name, value }) => ({ name, value: redactFieldValue(name, value) }))

// A body is redacted field by field when it is JSON, a URL, multipart or URL-encoded, so its shape stays readable,
// and whole otherwise. A truncated body is redacted as far as it goes.
export const redactBody = (text: string): string => {
  if (JSON_START.test(text)) {
    return redactJson(text)
  }
  if (ABSOLUTE_URL.test(text)) {
    return redactUrl(text)
  }

  const boundary = MULTIPART_START.exec(text)?.groups?.boundary
  if (boundary !== undefined) {
    const delimiter = `--${boundary}`

    return text.split(delimiter).map(redactMultipartPart).join(delimiter)
  }
  if (FORM_BODY.test(text)) {
    return text.split(FORM_FIELD_SEPARATOR).map(redactFormField).join(FORM_FIELD_SEPARATOR)
  }

  return isSecretShaped(text) ? REDACTED_VALUE : text
}

// A URL as a tab command answers it; navigation keeps the URL as it is.
export const redactUrl = (url: string): string => {
  const queryStart = url.search(URL_QUERY_START)
  const address = (queryStart === -1 ? url : url.slice(0, queryStart)).replace(
    URL_USERINFO,
    `$<scheme>${REDACTED_VALUE}@`
  )
  const query = queryStart === -1 ? '' : url.slice(queryStart)
  const redactedAddress = address
    .split('/')
    .map((segment) => (isSecretShaped(segment) || isSecretShaped(percentDecoded(segment)) ? REDACTED_VALUE : segment))
    .join('/')

  return `${redactedAddress}${query.replaceAll(URL_FIELD, (field) => redactFormField(field))}`
}

// A credential-named field loses its whole value. Any other value is redacted as a body of its own, so a JSON payload
// in a form field keeps its other fields, and a token inside a sentence takes the sentence.
const redactFieldValue = (name: string, value: string): string =>
  isCredentialName(name) ? REDACTED_VALUE : redactBody(value)

const isCredentialName = (name: string): boolean => {
  const normalized = name.toLowerCase().replaceAll(/[^a-z\d]/gu, '')

  return CREDENTIAL_NAME_PARTS.some((part) => normalized.includes(part))
}

const isSecretShaped = (text: string): boolean => VALUE_SHAPES.some((pattern) => pattern.test(text))

// Decodes without throwing: bytes that are not valid UTF-8 become replacement characters.
const percentDecoded = (segment: string): string =>
  segment.replaceAll(PERCENT_ESCAPES, (escapes) =>
    new TextDecoder().decode(Uint8Array.from(escapes.slice(1).split('%'), (hex) => Number.parseInt(hex, 16)))
  )

// URLSearchParams decodes the field as the browser encoded it, keeping a malformed escape as written. A value that
// kept a redacted structure is encoded again.
const redactFormField = (field: string): string => {
  const [decoded] = new URLSearchParams(field)
  if (decoded === undefined) {
    return field
  }

  const [name, value] = decoded
  if (isSecretShaped(name)) {
    return REDACTED_VALUE
  }

  const separator = field.indexOf('=')
  const redacted = redactFieldValue(name, value)
  if (separator === -1 || redacted === value) {
    return field
  }

  return `${field.slice(0, separator)}=${redacted === REDACTED_VALUE ? redacted : encodeURIComponent(redacted)}`
}

const redactMultipartPart = (part: string): string => {
  const headerEnd = part.indexOf(MULTIPART_HEADER_END)
  if (headerEnd === -1) {
    return part
  }

  const name = MULTIPART_NAME.exec(part.slice(0, headerEnd))?.groups?.name
  const valueStart = headerEnd + MULTIPART_HEADER_END.length
  const valueEnd = part.endsWith(MULTIPART_LINE_END) ? part.length - MULTIPART_LINE_END.length : part.length
  const value = part.slice(valueStart, valueEnd)
  const redacted = name === undefined ? value : redactFieldValue(name, value)
  if (redacted === value) {
    return part
  }

  return `${part.slice(0, valueStart)}${redacted}${part.slice(valueEnd)}`
}

// Scans the JSON text rather than parsing it, so a truncated body is redacted too and the rest keeps its layout. The
// whole value of a credential-named key is replaced, an object or array included; any other string or scalar, a key
// among them, is redacted as a body of its own, so a nested JSON payload keeps its redacted structure.
const redactJson = (text: string): string => {
  const tokens = [...text.matchAll(JSON_TOKEN)].map(jsonToken)
  const spans: ISpan[] = []
  let index = 0
  while (index < tokens.length) {
    const { span, next } = scanJsonToken(tokens, index)
    if (span !== null) {
      spans.push(span)
    }
    index = next
  }

  return replaceSpans(text, spans)
}

// The span to redact at the token at `index`, if any, and the index the scan goes on from.
const scanJsonToken = (tokens: readonly IJsonToken[], index: number): IJsonStep => {
  const token = tokens[index]
  const content = token?.content ?? null
  if (token === undefined || content === null) {
    return { span: null, next: index + 1 }
  }

  const isKey = token.isString && tokens[index + 1]?.mark === ':'
  if (!isKey || !isCredentialName(content)) {
    const redacted = redactBody(content)
    const span =
      redacted === content ? null : { start: token.start, end: token.end, replacement: JSON.stringify(redacted) }

    return { span, next: index + 1 }
  }

  return jsonValueSpan(tokens, index + 2)
}

const jsonValueSpan = (tokens: readonly IJsonToken[], start: number): IJsonStep => {
  const endIndex = jsonValueEnd(tokens, start)
  const first = tokens[start]
  const last = endIndex === undefined ? undefined : tokens[endIndex]
  if (endIndex === undefined || first === undefined || last === undefined) {
    return { span: null, next: start }
  }

  return { span: { start: first.start, end: last.end, replacement: JSON_REDACTED_VALUE }, next: endIndex + 1 }
}

const jsonToken = (match: RegExpExecArray): IJsonToken => {
  const [text] = match
  const { literal, mark } = match.groups ?? {}
  const start = match.index
  const end = start + text.length
  if (mark !== undefined) {
    return { start, end, content: null, isString: false, mark }
  }

  return {
    start,
    end,
    content: literal === undefined ? text : unescapeJson(literal),
    isString: literal !== undefined,
    mark: null,
  }
}

const unescapeJson = (content: string): string =>
  content.replaceAll(JSON_ESCAPE, (escape: string, hex: string | undefined, char: string | undefined) => {
    if (hex !== undefined) {
      return String.fromCharCode(Number.parseInt(hex, 16))
    }

    return char === undefined ? escape : (JSON_ESCAPED_CHARS.get(char) ?? char)
  })

// The index of the last token of the value starting at `start`: the scalar itself, the bracket closing an object or
// array, or the last token of a truncated one. Undefined when no value is there.
const jsonValueEnd = (tokens: readonly IJsonToken[], start: number): number | undefined => {
  const first = tokens[start]
  if (first === undefined) {
    return undefined
  }
  if (first.mark === null) {
    return start
  }
  if (depthChange(first) <= 0) {
    return undefined
  }

  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    depth += depthChange(tokens[index])
    if (depth === 0) {
      return index
    }
  }

  return tokens.length - 1
}

const depthChange = (token: IJsonToken | undefined): number => JSON_DEPTH_CHANGE.get(token?.mark ?? '') ?? 0

const replaceSpans = (text: string, spans: readonly ISpan[]): string => {
  let result = ''
  let copiedUpTo = 0
  for (const { start, end, replacement } of spans) {
    result += `${text.slice(copiedUpTo, start)}${replacement}`
    copiedUpTo = end
  }

  return `${result}${text.slice(copiedUpTo)}`
}
