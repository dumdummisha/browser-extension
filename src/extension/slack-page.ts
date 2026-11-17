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

// What a command answers, checked when it comes back, since the page's own scripts run in the same world.
export const SlackPageResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('identity'),
    identity: z.strictObject({ teamId: z.string(), userId: z.string(), teamName: z.string() }).nullable(),
  }),
  z.strictObject({ kind: z.literal('other-account') }),
  z.strictObject({ kind: z.literal('answer'), answer: SlackAnswerSchema }),
  z.strictObject({ kind: z.literal('file'), data: z.string() }),
  z.strictObject({ kind: z.literal('prepared'), prepared: PreparedUploadSchema }),
])

export type SlackPageResult = z.infer<typeof SlackPageResultSchema>

// chrome.scripting serializes this function into the page, so it uses nothing from the module's scope. The signed-in
// account is the workspace the tab shows (/client/<team>) and that workspace's user in the client's saved state. The
// token is read here for the request the command makes and never leaves: the function answers only ids, Slack's
// answers and file bytes.
export const runSlackPageCommand = async (command: SlackPageCommand): Promise<SlackPageResult> => {
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

  const teamId = /^\/client\/(?<teamId>[TE][A-Z0-9]+)/u.exec(location.pathname)?.groups?.teamId
  const saved = localStorage.getItem('localConfig_v2')
  const config: unknown = saved === null ? null : JSON.parse(saved)
  const team: unknown = teamId !== undefined && isRecord(config) && isRecord(config.teams) ? config.teams[teamId] : null
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
    throw new Error(`Slack's client keeps no API session for ${teamId}`)
  }

  const { token } = team
  const apiUrl = new URL('api/', team.url)

  // Slack answers 200 with ok false for its own errors; anything else (another status, no JSON, no ok) is no answer.
  const callSlack = async (
    method: string,
    params: Readonly<Record<string, string>>
  ): Promise<{ readonly ok: boolean; readonly [field: string]: unknown }> => {
    const response = await fetch(new URL(method, apiUrl), {
      method: 'POST',
      body: new URLSearchParams({ ...params, token }),
      credentials: 'include',
    })
    const answer: unknown = response.ok ? await response.json() : null
    if (!isRecord(answer) || typeof answer.ok !== 'boolean') {
      throw new Error(`Slack ${method} answered ${response.status}`)
    }

    return { ...answer, ok: answer.ok }
  }

  // A private file, fetched with the browser's cookies.
  const download = async (url: string): Promise<SlackPageResult> => {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) {
      throw new Error(`Slack answered ${response.status} for the file`)
    }

    return { kind: 'file', data: new Uint8Array(await response.arrayBuffer()).toBase64() }
  }

  // Slack's external upload up to the file's id: an upload URL, then the bytes. Nothing is shared yet.
  const upload = async (filename: string, chunks: readonly string[]): Promise<SlackPageResult> => {
    const parts = chunks.map((chunk) => Uint8Array.fromBase64(chunk))
    const byteLength = parts.reduce((total, part) => total + part.byteLength, 0)
    const ticket = await callSlack('files.getUploadURLExternal', { filename, length: String(byteLength) })
    if (!ticket.ok) {
      if (typeof ticket.error !== 'string') {
        throw new Error('files.getUploadURLExternal answered not ok without an error')
      }

      return { kind: 'prepared', prepared: { ok: false, error: ticket.error } }
    }

    const { upload_url: uploadUrl, file_id: fileId } = ticket
    if (typeof uploadUrl !== 'string' || typeof fileId !== 'string') {
      throw new Error('files.getUploadURLExternal answered no upload URL')
    }

    // A multipart body needs no preflight, and the upload URL itself grants the upload, so no cookies go with it.
    const body = new FormData()
    body.append('filename', new Blob(parts), filename)
    const posted = await fetch(uploadUrl, { method: 'POST', body })

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
