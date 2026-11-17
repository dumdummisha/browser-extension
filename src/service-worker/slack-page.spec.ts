import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { runSlackPageCommand, type SlackPageCommand, type SlackPageResult } from './slack-page.js'

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
      addresses.map(() => ({ kind: 'failed', error: "Slack's client keeps no Slack API address for T0EXAMPLE1" }))
    )
    assert.equal(fetched.mock.callCount(), 0)
  })
})

describe('[service-worker] Slack page - failures', () => {
  it('should answer a fixed failure, quoting nothing, when the saved client state does not parse', async (context) => {
    // Arrange
    openSlackPage(context, () => `{"teams":{"T0EXAMPLE1":{"token":"${TOKEN}",`)

    // Act
    const result = await runSlackPageCommand({ kind: 'identity' })

    // Assert
    assert.deepEqual(result, { kind: 'failed', error: "Slack's saved client state does not read" })
  })

  it('should answer a fixed failure, quoting nothing, when what Slack answered does not parse', async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(`not json ${TOKEN}`)))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'failed', error: 'Slack auth.test answered no JSON' })
  })

  it('should replace any other error with a fixed message naming only the command', async (context) => {
    // Arrange
    openSlackPage(context, () => {
      throw new Error(`The storage failed near ${TOKEN}`)
    })

    // Act
    const result = await runSlackPageCommand({ kind: 'identity' })

    // Assert
    assert.deepEqual(result, { kind: 'failed', error: 'The Slack page could not run identity' })
  })
})
