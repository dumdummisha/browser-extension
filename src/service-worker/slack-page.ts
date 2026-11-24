import { z } from 'zod'
import { type SlackAccount, SlackAnswerSchema } from '../protocol/slack.js'

// What the service worker asks of a Slack tab. Each command runs in the page's own world (MAIN), where Slack's client
// keeps its state, through chrome.scripting. Every command but identity names the account it acts as, and acts only
// when the tab is signed in as that account at that moment, and makes one request to Slack, which it sends only before
// its deadline: when the caller stops waiting, in milliseconds since the epoch.
export type SlackPageCommand =
  | { readonly kind: 'identity' }
  | {
      readonly kind: 'call'
      readonly account: SlackAccount
      readonly method: string
      readonly params: Readonly<Record<string, string>>
      // The query the call goes out with, by the origin of the workspace API it belongs to: the query of the page
      // client's own latest call to that API, as the service worker borrowed it (slack-client-observer.ts). The page
      // sends it with the activity session it records in _x_csid (callSlack).
      readonly queries: Readonly<Record<string, string>>
      readonly deadline: number
    }
  | { readonly kind: 'download'; readonly account: SlackAccount; readonly url: string; readonly deadline: number }
  | {
      readonly kind: 'upload'
      readonly account: SlackAccount
      readonly uploadUrl: string
      readonly filename: string
      readonly chunks: readonly string[]
      readonly deadline: number
    }

// Why a command did not complete, as a fixed code. The page words no error itself, so no text the page or a response
// holds becomes one: the service worker words each code (background.ts).
// - client-state-unreadable: Slack's saved client state is not JSON
// - no-api-session, no-api-address: the saved state keeps no token, or no https address on a workspace's Slack host
// - no-client-query: the service worker has seen no Web API call of the page's client to the workspace's API, so it
//   holds no query to send the call with, or the query it holds has no workspace route (slack_route), which the
//   service worker never lends (slack-request-shape.ts borrowedQueryOf)
// - activity-session-unreadable: Slack's activity sessions for the workspace are stored in a form on which Slack's
//   client itself would throw, or lose the session it records
// - activity-session-unsaved: the page's localStorage refused the activity session the command recorded
// - deadline-passed: the caller's deadline passed before the request went out, so nothing was sent
// - api-unreachable, api-refused, api-no-answer: a Web API call got no response, an HTTP status other than 2xx, or no
//   JSON object with a boolean ok
// - file-unreachable, file-refused, file-bytes-lost: a private file got no response, a status other than 2xx, or its
//   bytes did not arrive
// - upload-unreachable: the upload URL got no response, or answered a redirect, which is refused
// - uncaught: any other error
export const SLACK_PAGE_FAILURES = [
  'client-state-unreadable',
  'no-api-session',
  'no-api-address',
  'no-client-query',
  'activity-session-unreadable',
  'activity-session-unsaved',
  'deadline-passed',
  'api-unreachable',
  'api-refused',
  'api-no-answer',
  'file-unreachable',
  'file-refused',
  'file-bytes-lost',
  'upload-unreachable',
  'uncaught',
] as const

export type SlackPageFailure = (typeof SLACK_PAGE_FAILURES)[number]

// The HTTP status of a response that was not 2xx: a number, never text.
const HttpStatusSchema = z.number().int().min(100).max(599)

// What a command answers, checked when it comes back, since the page's own scripts run in the same world. A command
// that did not complete answers failed with its code, and with the HTTP status of the refusal for api-refused and
// file-refused. uploaded: the upload URL took the bytes; upload-refused: it answered a status other than 2xx, so Slack
// holds no bytes.
export const SlackPageResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('identity'),
    identity: z.strictObject({ teamId: z.string(), userId: z.string(), teamName: z.string() }).nullable(),
  }),
  z.strictObject({ kind: z.literal('other-account') }),
  z.strictObject({ kind: z.literal('answer'), answer: SlackAnswerSchema }),
  z.strictObject({ kind: z.literal('file'), data: z.string() }),
  z.strictObject({ kind: z.literal('uploaded') }),
  z.strictObject({ kind: z.literal('upload-refused'), status: HttpStatusSchema }),
  z.strictObject({
    kind: z.literal('failed'),
    failure: z.enum(SLACK_PAGE_FAILURES),
    status: HttpStatusSchema.nullable(),
  }),
])

export type SlackPageResult = z.infer<typeof SlackPageResultSchema>

const isSlackAnswer = ({ kind }: SlackPageResult): boolean =>
  kind === 'answer' || kind === 'file' || kind === 'uploaded' || kind === 'upload-refused'

// The failures that come before the command's fetch call, so nothing went out to Slack, and those that come after
// Slack answered it, with a status or a body that did not read.
const UNSENT_FAILURES: ReadonlySet<SlackPageFailure> = new Set([
  'client-state-unreadable',
  'no-api-session',
  'no-api-address',
  'no-client-query',
  'activity-session-unreadable',
  'activity-session-unsaved',
  'deadline-passed',
])
const ANSWERED_FAILURES: ReadonlySet<SlackPageFailure> = new Set([
  'api-refused',
  'api-no-answer',
  'file-refused',
  'file-bytes-lost',
])

// Whether a command's result shows that nothing went out to Slack: the page was signed in as another account, or the
// command failed before its fetch call. Any other result, a failure the page could not name (uncaught) included, may
// follow a request that reached Slack.
export const isNothingSent = (result: SlackPageResult): boolean =>
  result.kind === 'other-account' || (result.kind === 'failed' && UNSENT_FAILURES.has(result.failure))

// Whether a command's result proves Slack answered its request: with its answer, a file's bytes, the upload URL's
// status, or a status or body that did not read.
export const isAnsweredBySlack = (result: SlackPageResult): boolean =>
  result.kind === 'failed' ? ANSWERED_FAILURES.has(result.failure) : isSlackAnswer(result)

// chrome.scripting serializes this function into the page, so it uses nothing from the module's scope. The signed-in
// account is the workspace the tab shows (/client/<team>) and that workspace's user in the client's saved state. The
// token is read here for the request the command makes and never leaves: the function answers only ids, Slack's
// answers, file bytes and whether an upload took. It posts the token, with the browser's cookies, only to the
// workspace's https address on Slack's own domain, and follows no redirect with it, since the saved state is the page's
// to change. The one thing it writes in the page is Slack's own activity session for the workspace, in the page's
// localStorage, right before each Web API call (callSlack). An error could quote what the page holds (a JSON parser
// quotes the text it failed on), so none leaves the function: a command that fails answers failed with a fixed code
// (SLACK_PAGE_FAILURES).
export const runSlackPageCommand = async (command: SlackPageCommand): Promise<SlackPageResult> => {
  // A failure the function names itself; any other error becomes uncaught.
  class PageFailure extends Error {
    constructor(
      public readonly failure: SlackPageFailure,
      public readonly status: number | null = null
    ) {
      super(failure)
    }
  }

  // A workspace's own host on Slack's domain: example.slack.com, or example.enterprise.slack.com in an Enterprise Grid.
  const SLACK_API_HOSTNAME = /^[a-z0-9][a-z0-9-]*(?:\.enterprise)?\.slack\.com$/u

  // Slack's activity sessions, as its client bundle keeps them (module "837d"): each the page's own constant there.
  // - ENTERPRISE_ID: an Enterprise Grid's id (looksLikeEnterpriseTeamId).
  // - ACTIVITY_SESSION_PREFIX: the localStorage key of a workspace's sessions, before its session key (getSessions).
  // - SESSION_ACTIVE_MS: a session is active while not ended and less than this since its last activity
  //   (isSessionActive, 6e4).
  // - SESSION_STALE_MS: a session whose last activity is more than this ago is pruned (pruneStaleSessionsObject, 864e5).
  // - SESSION_DEFINITION_VERSION: the definitionVersion a new session records. The client records 2 only inside
  //   Slack's desktop app, known by its user agent (isSessionDefinitionV2, isDesktopApp), and the page this runs in is a
  //   browser tab.
  // - SESSION_ID_ALPHABET and SESSION_ID_RANDOM_LENGTH: a session id is that many random characters of the alphabet,
  //   then one more (makeSessionId).
  const ENTERPRISE_ID = /^E[A-Z0-9]{8,}$/u
  const ACTIVITY_SESSION_PREFIX = 'activitySession_'
  const SESSION_ACTIVE_MS = 60_000
  const SESSION_STALE_MS = 86_400_000
  const SESSION_DEFINITION_VERSION = 1
  const SESSION_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const SESSION_ID_RANDOM_LENGTH = 10
  // The query field generateQueryString writes the active session's id in, and the field it writes it right before.
  const SESSION_FIELD = '_x_csid'
  const ROUTE_FIELD = 'slack_route'

  // A stored entry the command reads as a session, in the fields it reads; the rest stay as stored. Slack's client
  // writes every session with a string id, and a start and a last activity in milliseconds.
  interface IReadableSession {
    readonly id?: unknown
    readonly startTime: number
    lastActivity: number
    readonly ended?: unknown
  }

  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

  // Runs step, and fails with failure in place of whatever error it threw.
  const guarded = async <TResult>(
    failure: SlackPageFailure,
    step: () => TResult | Promise<TResult>
  ): Promise<TResult> => {
    try {
      return await step()
    } catch {
      throw new PageFailure(failure)
    }
  }

  // An entry the command can select (getActiveSessionFromSessionObject): an object whose start and last activity are
  // numbers, the values the client's selection compares. Any other entry is never selected, and stays as stored unless
  // pruning removes it. The client's comparisons would coerce such a value instead (a numeric string's last activity
  // included), a value it never writes.
  const isReadableSession = (value: unknown): value is IReadableSession =>
    isRecord(value) && typeof value.startTime === 'number' && typeof value.lastActivity === 'number'

  // A workspace's stored entries by name (getSessions): none when nothing is stored or what is stored does not parse,
  // and none for a stored value that parses as nothing (JSON.parse(t) || {}). Any other value is taken as the client
  // takes it, entry by entry, and fails the command only where recordSessionActivity itself throws or loses data:
  // - an array, whose new session the client adds under a name JSON.stringify drops, so the write loses it
  // - a number, a string or true, to which the client's strict-mode code cannot add the new session, and throws
  // - an object with a null entry, whose ended isSessionActive reads, and throws
  const storedSessions = (saved: string | null): Record<string, unknown> => {
    if (saved === null || saved === '') {
      return {}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(saved)
    } catch {
      return {}
    }

    const isTruthy = Boolean(parsed)
    const sessions = isTruthy ? parsed : {}
    if (!isRecord(sessions) || Array.isArray(sessions) || Object.values(sessions).includes(null)) {
      throw new PageFailure('activity-session-unreadable')
    }

    return sessions
  }

  // isSessionActive: not ended, and less than SESSION_ACTIVE_MS since its last activity.
  const isSessionActive = (session: IReadableSession, now: number): boolean => {
    const hasEnded = Boolean(session.ended)

    return !hasEnded && now < session.lastActivity + SESSION_ACTIVE_MS
  }

  // The session active at now (getActiveSessionFromSessionObject): of the active sessions, the one that started first,
  // the first stored on a tie, as lodash's stable sortBy and head pick it.
  const activeSessionOf = (sessions: Readonly<Record<string, unknown>>, now: number): IReadableSession | undefined =>
    Object.values(sessions)
      .filter(isReadableSession)
      .filter((session) => isSessionActive(session, now))
      .toSorted((first, second) => first.startTime - second.startTime)[0]

  // The name a session's id gives its entry (a[i.id]), as JavaScript converts a property name: a value the conversion
  // throws on (an object whose own toString and valueOf cannot be called) throws in the client too.
  const entryNameOf = (id: unknown): string => {
    try {
      return String(id)
    } catch {
      throw new PageFailure('activity-session-unreadable')
    }
  }

  // The last activity pruneStaleSessionsObject subtracts from the time, as JavaScript's subtraction converts it: an
  // entry that is no object has none (NaN, so it is never pruned). A value the conversion throws on (an object whose
  // own toString and valueOf cannot be called) throws in the client too.
  const prunedLastActivityOf = (entry: unknown): number => {
    try {
      return Number(isRecord(entry) ? entry.lastActivity : undefined)
    } catch {
      throw new PageFailure('activity-session-unreadable')
    }
  }

  // A new session id (makeSessionId), from Math.random as the client draws it. The client masks the last character's
  // index with 60, which for an index below 64 rounds it down to a multiple of 4, as written here.
  const newSessionId = (): string => {
    const randomIndex = (): number => Math.floor(SESSION_ID_ALPHABET.length * Math.random())
    const random = Array.from({ length: SESSION_ID_RANDOM_LENGTH }, () => SESSION_ID_ALPHABET.charAt(randomIndex()))

    return `${random.join('')}${SESSION_ID_ALPHABET.charAt(4 * Math.floor(randomIndex() / 4))}`
  }

  // The key a workspace's sessions are stored under (getActivitySessionKey): its enterprise id when it belongs to an
  // Enterprise Grid, else its team id. The client takes the enterprise id from the path when the path names an
  // enterprise, else from the saved team's enterprise_id (getGantryBootId).
  const activitySessionKeyOf = (teamId: string, savedEnterpriseId: unknown): string => {
    const enterpriseId = ENTERPRISE_ID.test(teamId) ? teamId : savedEnterpriseId

    return typeof enterpriseId === 'string' && enterpriseId !== '' ? enterpriseId : teamId
  }

  const run = async (): Promise<SlackPageResult> => {
    // The path and the key the observer reads too (config.ts SLACK_CLIENT_PATH and SLACK_CLIENT_STATE_KEY), written out
    // since this function cannot import.
    const teamId = /^\/client\/(?<teamId>[TE][A-Z0-9]+)/u.exec(location.pathname)?.groups?.teamId
    const saved = localStorage.getItem('localConfig_v2')
    const config: unknown =
      saved === null ? null : await guarded('client-state-unreadable', (): unknown => JSON.parse(saved))
    const team: unknown =
      teamId !== undefined && isRecord(config) && isRecord(config.teams) ? config.teams[teamId] : null
    if (teamId === undefined || !isRecord(team) || typeof team.user_id !== 'string' || typeof team.name !== 'string') {
      return command.kind === 'identity' ? { kind: 'identity', identity: null } : { kind: 'other-account' }
    }

    if (command.kind === 'identity') {
      return { kind: 'identity', identity: { teamId, userId: team.user_id, teamName: team.name } }
    }

    if (command.account.teamId !== teamId || command.account.userId !== team.user_id) {
      return { kind: 'other-account' }
    }

    if (typeof team.token !== 'string' || typeof team.url !== 'string') {
      throw new PageFailure('no-api-session')
    }

    const { token } = team
    // The guard runs on the page's own URL and RegExp, which a page script could replace. Page scripts are out of scope
    // (README, Security), so it keeps the token from a saved address that is not Slack's and is not hardened against
    // such a script.
    const base = URL.parse(team.url)
    const isSlackApiBase =
      base?.protocol === 'https:' &&
      base.username === '' &&
      base.password === '' &&
      base.port === '' &&
      SLACK_API_HOSTNAME.test(base.hostname)
    if (!isSlackApiBase) {
      throw new PageFailure('no-api-address')
    }

    const apiUrl = new URL('/api/', base.origin)
    const { deadline } = command

    // Sends the command's request only while its caller still waits: the deadline is checked right before the fetch
    // call, the last point before the request leaves.
    const sent = async (failure: SlackPageFailure, send: () => Promise<Response>): Promise<Response> => {
      if (Date.now() >= deadline) {
        throw new PageFailure('deadline-passed')
      }

      return guarded(failure, send)
    }

    // Slack's client sends a Web API call with _x_csid, the id of the page's active activity session, only while one is
    // active (generateQueryString, given getActiveSession's session), and starts or extends a session only on a user's
    // input while its window has focus (listenForUserEvents). A tab Misha acts in is not one its owner has in focus, so
    // right before each call the command records activity as the client does on input (recordSessionActivity), and
    // answers the id of the session that is active now, as generateQueryString writes it: null for a session whose id
    // is falsy (empty, 0, null or missing), for which it writes no _x_csid.
    const recordedSessionId = (): string | null => {
      const storageKey = `${ACTIVITY_SESSION_PREFIX}${activitySessionKeyOf(teamId, team.enterprise_id)}`
      const now = Date.now()
      const sessions = storedSessions(localStorage.getItem(storageKey))
      // The active session is extended, or else a new one is added with the client's fields in the client's order. The
      // client extends the entry the selected session's id names (a[i.id]), so it throws when that id names no object,
      // and extends another entry than the one it selected when the id names another; either fails the command.
      const active = activeSessionOf(sessions, now)
      const session = active ?? {
        id: newSessionId(),
        startTime: now,
        lastActivity: now,
        lastLogged: null,
        definitionVersion: SESSION_DEFINITION_VERSION,
      }
      const entryName = entryNameOf(session.id)
      const isOwnEntry = Object.hasOwn(sessions, entryName) && sessions[entryName] === session
      if (active !== undefined && !isOwnEntry) {
        throw new PageFailure('activity-session-unreadable')
      }

      session.lastActivity = now
      sessions[entryName] = session
      // pruneStaleSessionsObject, after the session was extended or added, as the client prunes: at the time it reads
      // when pruning starts, which is later than the activity's.
      const pruneNow = Date.now()
      for (const [name, entry] of Object.entries(sessions)) {
        if (pruneNow - prunedLastActivityOf(entry) > SESSION_STALE_MS) {
          Reflect.deleteProperty(sessions, name)
        }
      }
      // setSessions. When localStorage refuses the write, the client keeps the sessions in its own memory, which this
      // function cannot reach, so the id would name a session the client does not hold.
      try {
        localStorage.setItem(storageKey, JSON.stringify(sessions))
      } catch {
        throw new PageFailure('activity-session-unsaved')
      }

      const isIdWritten = Boolean(session.id)

      return isIdWritten ? entryName : null
    }

    // Slack's client calls the Web API with a query of its own (_x_id, _x_csid, slack_route, _x_version_ts and the rest),
    // and Slack answers a call with cookies with credentialed CORS (the page's origin, allow-credentials) only when it
    // carries that query; without it the answer is "*", which a call with cookies cannot read. So a call goes out with
    // the query the service worker borrowed from this page's client for the workspace's API, with the session just
    // recorded in _x_csid (none for a session whose id is falsy), right before slack_route where generateQueryString
    // writes it. A borrowed _x_csid, the session
    // the client had when it made the call the query came from, gives way to it.
    // Slack answers 200 with ok false for its own errors; anything else (another status, no JSON, no ok) is no answer.
    const callSlack = async (
      method: string,
      params: Readonly<Record<string, string>>,
      queries: Readonly<Record<string, string>>
    ): Promise<{ readonly ok: boolean; readonly [field: string]: unknown }> => {
      const query = Object.hasOwn(queries, apiUrl.origin) ? queries[apiUrl.origin] : undefined
      if (query === undefined) {
        throw new PageFailure('no-client-query')
      }

      const fields = [...new URLSearchParams(query)].filter(([name]) => name !== SESSION_FIELD)
      const routeAt = fields.findIndex(([name]) => name === ROUTE_FIELD)
      if (routeAt === -1) {
        throw new PageFailure('no-client-query')
      }

      const sessionId = recordedSessionId()
      const url = new URL(method, apiUrl)
      url.search = new URLSearchParams([
        ...fields.slice(0, routeAt),
        ...(sessionId === null ? [] : [[SESSION_FIELD, sessionId]]),
        ...fields.slice(routeAt),
      ]).toString()
      // A multipart body, as the client posts: the call's parameters, the token and the client's own fields.
      const body = new FormData()
      for (const [name, value] of Object.entries({
        ...params,
        token,
        _x_mode: 'online',
        _x_sonic: 'true',
        _x_app_name: 'client',
      })) {
        body.append(name, value)
      }
      const response = await sent('api-unreachable', () =>
        fetch(url, { method: 'POST', body, credentials: 'include', redirect: 'error' })
      )
      if (!response.ok) {
        throw new PageFailure('api-refused', response.status)
      }

      const answer: unknown = await guarded('api-no-answer', (): Promise<unknown> => response.json())
      if (!isRecord(answer) || typeof answer.ok !== 'boolean') {
        throw new PageFailure('api-no-answer')
      }

      return { ...answer, ok: answer.ok }
    }

    // A private file, fetched with the browser's cookies.
    const download = async (url: string): Promise<SlackPageResult> => {
      const response = await sent('file-unreachable', () => fetch(url, { credentials: 'include', redirect: 'error' }))
      if (!response.ok) {
        throw new PageFailure('file-refused', response.status)
      }

      const bytes = await guarded('file-bytes-lost', () => response.arrayBuffer())

      return { kind: 'file', data: new Uint8Array(bytes).toBase64() }
    }

    // The bytes of Slack's external upload, to the upload URL files.getUploadURLExternal answered. Nothing is shared yet.
    // A multipart body needs no preflight, and the upload URL itself grants the upload, so no cookies go with it. A
    // redirect is refused, so the bytes go out in this one request and to this one address.
    const upload = async (uploadUrl: string, filename: string, chunks: readonly string[]): Promise<SlackPageResult> => {
      const body = new FormData()
      body.append('filename', new Blob(chunks.map((chunk) => Uint8Array.fromBase64(chunk))), filename)
      const posted = await sent('upload-unreachable', () =>
        fetch(uploadUrl, { method: 'POST', body, redirect: 'error' })
      )

      return posted.ok ? { kind: 'uploaded' } : { kind: 'upload-refused', status: posted.status }
    }

    switch (command.kind) {
      case 'call':
        return { kind: 'answer', answer: await callSlack(command.method, command.params, command.queries) }
      case 'download':
        return download(command.url)
      case 'upload':
        return upload(command.uploadUrl, command.filename, command.chunks)
    }
  }

  try {
    return await run()
  } catch (error) {
    return error instanceof PageFailure
      ? { kind: 'failed', failure: error.failure, status: error.status }
      : { kind: 'failed', failure: 'uncaught', status: null }
  }
}
