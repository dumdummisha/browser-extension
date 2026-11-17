import { z } from 'zod'
import { PreparedUploadSchema, type SlackAccount, SlackAnswerSchema } from '../protocol/slack.js'

// What the service worker asks of a Slack tab. Each command runs in the page's own world (MAIN), where Slack's client
// keeps its state, through chrome.scripting. Every command but identity names the account it acts as, and acts only
// when the tab is signed in as that account at that moment.
export type SlackPageCommand =
  | { readonly kind: 'identity' }
  | {
      readonly kind: 'call'
      readonly account: SlackAccount
      readonly method: string
      readonly params: Readonly<Record<string, string>>
    }
  | { readonly kind: 'download'; readonly account: SlackAccount; readonly url: string }
  | {
      readonly kind: 'upload'
      readonly account: SlackAccount
      readonly filename: string
      readonly chunks: readonly string[]
    }

// Why a command did not complete, as a fixed code. The page words no error itself, so no text the page or a response
// holds becomes one: the service worker words each code (background.ts).
// - client-state-unreadable: Slack's saved client state is not JSON
// - no-api-session, no-api-address: the saved state keeps no token, or no https address on a workspace's Slack host
// - api-unreachable, api-refused, api-no-answer: a Web API call got no response, an HTTP status other than 2xx, or no
//   JSON object with a boolean ok
// - file-unreachable, file-refused, file-bytes-lost: a private file got no response, a status other than 2xx, or its
//   bytes did not arrive
// - upload-url-missing: files.getUploadURLExternal answered neither an upload URL with a file id nor an error
// - upload-unreachable: the upload URL got no response
// - uncaught: any other error
export const SLACK_PAGE_FAILURES = [
  'client-state-unreadable',
  'no-api-session',
  'no-api-address',
  'api-unreachable',
  'api-refused',
  'api-no-answer',
  'file-unreachable',
  'file-refused',
  'file-bytes-lost',
  'upload-url-missing',
  'upload-unreachable',
  'uncaught',
] as const

export type SlackPageFailure = (typeof SLACK_PAGE_FAILURES)[number]

// The HTTP status of a response that was not 2xx: a number, never text.
const HttpStatusSchema = z.number().int().min(100).max(599)

// What a command answers, checked when it comes back, since the page's own scripts run in the same world. A command
// that did not complete answers failed with its code, and with the HTTP status of the refusal for api-refused and
// file-refused. upload-refused: the upload URL answered a status other than 2xx, so Slack holds no bytes.
export const SlackPageResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('identity'),
    identity: z.strictObject({ teamId: z.string(), userId: z.string(), teamName: z.string() }).nullable(),
  }),
  z.strictObject({ kind: z.literal('other-account') }),
  z.strictObject({ kind: z.literal('answer'), answer: SlackAnswerSchema }),
  z.strictObject({ kind: z.literal('file'), data: z.string() }),
  z.strictObject({ kind: z.literal('prepared'), prepared: PreparedUploadSchema }),
  z.strictObject({ kind: z.literal('upload-refused'), status: HttpStatusSchema }),
  z.strictObject({
    kind: z.literal('failed'),
    failure: z.enum(SLACK_PAGE_FAILURES),
    status: HttpStatusSchema.nullable(),
  }),
])

export type SlackPageResult = z.infer<typeof SlackPageResultSchema>

// chrome.scripting serializes this function into the page, so it uses nothing from the module's scope. The signed-in
// account is the workspace the tab shows (/client/<team>) and that workspace's user in the client's saved state. The
// token is read here for the request the command makes and never leaves: the function answers only ids, Slack's
// answers and file bytes. It posts the token, with the browser's cookies, only to the workspace's https address on
// Slack's own domain, and follows no redirect with it, since the saved state is the page's to change. An error could
// quote what the page holds (a JSON parser quotes the text it failed on), so none leaves the function: a command that
// fails answers failed with a fixed code (SLACK_PAGE_FAILURES).
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

    // Slack answers 200 with ok false for its own errors; anything else (another status, no JSON, no ok) is no answer.
    const callSlack = async (
      method: string,
      params: Readonly<Record<string, string>>
    ): Promise<{ readonly ok: boolean; readonly [field: string]: unknown }> => {
      const response = await guarded('api-unreachable', () =>
        fetch(new URL(method, apiUrl), {
          method: 'POST',
          body: new URLSearchParams({ ...params, token }),
          credentials: 'include',
          redirect: 'error',
        })
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
      const response = await guarded('file-unreachable', () =>
        fetch(url, { credentials: 'include', redirect: 'error' })
      )
      if (!response.ok) {
        throw new PageFailure('file-refused', response.status)
      }

      const bytes = await guarded('file-bytes-lost', () => response.arrayBuffer())

      return { kind: 'file', data: new Uint8Array(bytes).toBase64() }
    }

    // Slack's external upload up to the file's id: an upload URL, then the bytes. Nothing is shared yet.
    const upload = async (filename: string, chunks: readonly string[]): Promise<SlackPageResult> => {
      const parts = chunks.map((chunk) => Uint8Array.fromBase64(chunk))
      const byteLength = parts.reduce((total, part) => total + part.byteLength, 0)
      const ticket = await callSlack('files.getUploadURLExternal', { filename, length: String(byteLength) })
      if (!ticket.ok) {
        if (typeof ticket.error !== 'string') {
          throw new PageFailure('upload-url-missing')
        }

        return { kind: 'prepared', prepared: { ok: false, error: ticket.error } }
      }

      const { upload_url: uploadUrl, file_id: fileId } = ticket
      if (typeof uploadUrl !== 'string' || typeof fileId !== 'string') {
        throw new PageFailure('upload-url-missing')
      }

      // A multipart body needs no preflight, and the upload URL itself grants the upload, so no cookies go with it.
      const body = new FormData()
      body.append('filename', new Blob(parts), filename)
      const posted = await guarded('upload-unreachable', () => fetch(uploadUrl, { method: 'POST', body }))

      return posted.ok
        ? { kind: 'prepared', prepared: { ok: true, fileId } }
        : { kind: 'upload-refused', status: posted.status }
    }

    switch (command.kind) {
      case 'call':
        return { kind: 'answer', answer: await callSlack(command.method, command.params) }
      case 'download':
        return download(command.url)
      case 'upload':
        return upload(command.filename, command.chunks)
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
