import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import {
  runSlackPageCommand,
  type SlackPageCommand,
  type SlackPageResult,
  SlackPageResultSchema,
} from './slack-page.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const TOKEN = 'xoxc-0000-example'
const CALL: SlackPageCommand = { kind: 'call', account: ACCOUNT, method: 'auth.test', params: {} }

const savedConfig = (url: string): string =>
  JSON.stringify({ teams: { T0EXAMPLE1: { user_id: 'U0EXAMPLE1', name: 'Example', token: TOKEN, url } } })

// The Slack page the command runs in: the workspace's client, with what getItem answers as its saved client state.
const openSlackPage = (context: TestContext, getItem: () => string | null): void => {
  const page = { location: { pathname: '/client/T0EXAMPLE1/C0EXAMPLE1' }, localStorage: { getItem } }
  for (const [name, value] of Object.entries(page)) {
    Object.defineProperty(globalThis, name, { value, configurable: true })
  }

  context.after(() => {
    for (const name of Object.keys(page)) {
      Reflect.deleteProperty(globalThis, name)
    }
  })
}

describe('[service-worker] Slack page - where the token goes', () => {
  it("should post the token to the workspace's API on its Slack host, with cookies and no redirect", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    const fetched = context.mock.method(globalThis, 'fetch', () =>
      Promise.resolve(Response.json({ ok: true, user_id: 'U0EXAMPLE1' }))
    )

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'answer', answer: { ok: true, user_id: 'U0EXAMPLE1' } })
    const [url, init] = fetched.mock.calls[0]?.arguments ?? []
    assert.deepEqual(
      [String(url), init?.credentials, init?.redirect, new URLSearchParams(String(init?.body)).get('token')],
      ['https://example.slack.com/api/auth.test', 'include', 'error', TOKEN]
    )
  })

  it('should refuse a saved API address that is not plain https on a Slack host, sending nothing', async (context) => {
    // Arrange
    const addresses = [
      'https://attacker.example/',
      'https://example.slack.com.attacker.example/',
      'http://example.slack.com/',
      'https://user:secret@example.slack.com/',
      'https://example.slack.com:8443/',
      'not an address',
    ]
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    const results: SlackPageResult[] = []
    for (const address of addresses) {
      openSlackPage(context, () => savedConfig(address))
      results.push(await runSlackPageCommand(CALL))
    }

    // Assert
    assert.deepEqual(
      results,
      addresses.map(() => ({ kind: 'failed', failure: 'no-api-address', status: null }))
    )
    assert.equal(fetched.mock.callCount(), 0)
  })
})

describe('[service-worker] Slack page - failures', () => {
  it('should answer a failure code, quoting nothing, when the saved client state does not parse', async (context) => {
    // Arrange
    openSlackPage(context, () => `{"teams":{"T0EXAMPLE1":{"token":"${TOKEN}",`)

    // Act
    const result = await runSlackPageCommand({ kind: 'identity' })

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'client-state-unreadable', status: null })
  })

  it('should answer a failure code, quoting nothing, when what Slack answered does not parse', async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(`not json ${TOKEN}`)))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'api-no-answer', status: null })
  })

  it('should answer a refused call with its code and HTTP status, quoting nothing of the response', async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(`denied ${TOKEN}`, { status: 503 })))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'api-refused', status: 503 })
  })

  it('should answer any other error as uncaught', async (context) => {
    // Arrange
    openSlackPage(context, () => {
      throw new Error(`The storage failed near ${TOKEN}`)
    })

    // Act
    const result = await runSlackPageCommand({ kind: 'identity' })

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'uncaught', status: null })
  })

  it('should refuse a failure that carries text, a code it does not know or a status that is no HTTP status', () => {
    // Arrange
    const answers = [
      { kind: 'failed', error: TOKEN },
      { kind: 'failed', failure: TOKEN, status: null },
      { kind: 'failed', failure: 'api-refused', status: TOKEN },
      { kind: 'failed', failure: 'api-refused', status: 503.5 },
      { kind: 'upload-refused', status: TOKEN },
    ]

    // Act
    const results = answers.map((answer) => SlackPageResultSchema.safeParse(answer).success)

    // Assert
    assert.deepEqual(
      results,
      answers.map(() => false)
    )
  })
})
