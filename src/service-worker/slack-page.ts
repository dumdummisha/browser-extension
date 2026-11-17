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

// What a command answers, checked when it comes back, since the page's own scripts run in the same world. A command
// that did not complete answers failed, in words the function chose itself.
export const SlackPageResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('identity'),
    identity: z.strictObject({ teamId: z.string(), userId: z.string(), teamName: z.string() }).nullable(),
  }),
  z.strictObject({ kind: z.literal('other-account') }),
  z.strictObject({ kind: z.literal('answer'), answer: SlackAnswerSchema }),
  z.strictObject({ kind: z.literal('file'), data: z.string() }),
  z.strictObject({ kind: z.literal('prepared'), prepared: PreparedUploadSchema }),
  z.strictObject({ kind: z.literal('failed'), error: z.string().min(1) }),
])

export type SlackPageResult = z.infer<typeof SlackPageResultSchema>

// chrome.scripting serializes this function into the page, so it uses nothing from the module's scope. The signed-in
// account is the workspace the tab shows (/client/<team>) and that workspace's user in the client's saved state. The
// token is read here for the request the command makes and never leaves: the function answers only ids, Slack's
// answers and file bytes. It posts the token, with the browser's cookies, only to the workspace's https address on
// Slack's own domain, and follows no redirect with it, since the saved state is the page's to change. An error could
// quote what the page holds (a JSON parser quotes the text it failed on), so none leaves the function: a command that
// fails answers failed, in words of its own.
export const runSlackPageCommand = async (command: SlackPageCommand): Promise<SlackPageResult> => {
  // A failure the function words itself; any other error becomes a fixed message.
  class PageFailure extends Error {}

  // A workspace's own host on Slack's domain: example.slack.com, or example.enterprise.slack.com in an Enterprise Grid.
  const SLACK_API_HOSTNAME = /^[a-z0-9][a-z0-9-]*(?:\.enterprise)?\.slack\.com$/u

  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

  // Runs step, and fails with failure in place of whatever error it threw.
  const guarded = async <TResult>(failure: string, step: () => TResult | Promise<TResult>): Promise<TResult> => {
    try {
      return await step()
    } catch {
      throw new PageFailure(failure)
    }
  }

  const run = async (): Promise<SlackPageResult> => {
    const teamId = /^\/client\/(?<teamId>[TE][A-Z0-9]+)/u.exec(location.pathname)?.groups?.teamId
    const saved = localStorage.getItem('localConfig_v2')
    const config: unknown =
      saved === null
        ? null
        : await guarded("Slack's saved client state does not read", (): unknown => JSON.parse(saved))
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
      throw new PageFailure(`Slack's client keeps no API session for ${teamId}`)
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
      throw new PageFailure(`Slack's client keeps no Slack API address for ${teamId}`)
    }

    const apiUrl = new URL('/api/', base.origin)

    // Slack answers 200 with ok false for its own errors; anything else (another status, no JSON, no ok) is no answer.
    const callSlack = async (
      method: string,
      params: Readonly<Record<string, string>>
    ): Promise<{ readonly ok: boolean; readonly [field: string]: unknown }> => {
      const response = await guarded(`Slack ${method} could not be reached`, () =>
        fetch(new URL(method, apiUrl), {
          method: 'POST',
          body: new URLSearchParams({ ...params, token }),
          credentials: 'include',
          redirect: 'error',
        })
      )
      const answer: unknown = response.ok
        ? await guarded(`Slack ${method} answered no JSON`, (): Promise<unknown> => response.json())
        : null
      if (!isRecord(answer) || typeof answer.ok !== 'boolean') {
        throw new PageFailure(`Slack ${method} answered ${response.status}`)
      }

      return { ...answer, ok: answer.ok }
    }

    // A private file, fetched with the browser's cookies.
    const download = async (url: string): Promise<SlackPageResult> => {
      const response = await guarded('Slack could not be reached for the file', () =>
        fetch(url, { credentials: 'include', redirect: 'error' })
      )
      if (!response.ok) {
        throw new PageFailure(`Slack answered ${response.status} for the file`)
      }

      const bytes = await guarded("The file's bytes did not arrive", () => response.arrayBuffer())

      return { kind: 'file', data: new Uint8Array(bytes).toBase64() }
    }

    // Slack's external upload up to the file's id: an upload URL, then the bytes. Nothing is shared yet.
    const upload = async (filename: string, chunks: readonly string[]): Promise<SlackPageResult> => {
      const parts = chunks.map((chunk) => Uint8Array.fromBase64(chunk))
      const byteLength = parts.reduce((total, part) => total + part.byteLength, 0)
      const ticket = await callSlack('files.getUploadURLExternal', { filename, length: String(byteLength) })
      if (!ticket.ok) {
        if (typeof ticket.error !== 'string') {
          throw new PageFailure('files.getUploadURLExternal answered not ok without an error')
        }

        return { kind: 'prepared', prepared: { ok: false, error: ticket.error } }
      }

      const { upload_url: uploadUrl, file_id: fileId } = ticket
      if (typeof uploadUrl !== 'string' || typeof fileId !== 'string') {
        throw new PageFailure('files.getUploadURLExternal answered no upload URL')
      }

      // A multipart body needs no preflight, and the upload URL itself grants the upload, so no cookies go with it.
      const body = new FormData()
      body.append('filename', new Blob(parts), filename)
      const posted = await guarded('The upload URL could not be reached', () =>
        fetch(uploadUrl, { method: 'POST', body })
      )

      return posted.ok
        ? { kind: 'prepared', prepared: { ok: true, fileId } }
        : { kind: 'prepared', prepared: { ok: false, error: `The upload URL answered ${posted.status}` } }
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
    return {
      kind: 'failed',
      error: error instanceof PageFailure ? error.message : `The Slack page could not run ${command.kind}`,
    }
  }
}
