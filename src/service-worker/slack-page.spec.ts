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

// A Web API call Slack's client made in the tab, as resource timing lists it: its query, never a token.
const CLIENT_CALL =
  'https://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_gantry=true&fp=7a&_x_num_retries=2'

// The Slack page the command runs in: the workspace's client, with what getItem answers as its saved client state, and
// the resources the tab loaded, Slack's own Web API calls among them.
const openSlackPage = (
  context: TestContext,
  getItem: () => string | null,
  resources: readonly string[] = [CLIENT_CALL]
): void => {
  const page = {
    location: { pathname: '/client/T0EXAMPLE1/C0EXAMPLE1' },
    localStorage: { getItem },
    performance: { getEntriesByType: () => resources.map((name) => ({ name })) },
  }
  const saved = Object.keys(page).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const [name, value] of Object.entries(page)) {
    Object.defineProperty(globalThis, name, { value, configurable: true })
  }

  context.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name)
      } else {
        Object.defineProperty(globalThis, name, descriptor)
      }
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
    const body = init?.body instanceof FormData ? init.body : new FormData()
    assert.deepEqual(
      [String(url).split('?')[0], init?.credentials, init?.redirect, body.get('token')],
      ['https://example.slack.com/api/auth.test', 'include', 'error', TOKEN]
    )
  })

  it("should call as Slack's client does: its latest call's query with a fresh _x_id, and a multipart body", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand({ ...CALL, method: 'conversations.info', params: { channel: 'D0EXAMPLE1' } })

    // Assert
    const [url, init] = fetched.mock.calls[0]?.arguments ?? []
    const query = new URL(String(url)).searchParams
    assert.match(query.get('_x_id') ?? '', /^[0-9a-f]{8}-\d+\.\d{3}$/u)
    query.delete('_x_id')
    assert.equal(
      query.toString(),
      '_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_gantry=true&fp=7a&_x_num_retries=0'
    )
    assert.ok(init?.body instanceof FormData)
    assert.deepEqual(Object.fromEntries(init.body.entries()), {
      channel: 'D0EXAMPLE1',
      token: TOKEN,
      _x_mode: 'online',
      _x_sonic: 'true',
      _x_app_name: 'client',
    })
  })

  it("should answer a failure code, sending nothing, when the tab lists no Web API call of Slack's client", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'), [
      'https://example.slack.com/api/client.counts',
      'https://other.slack.com/api/client.counts?slack_route=T0EXAMPLE1',
    ])
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'no-client-query', status: null })
    assert.equal(fetched.mock.callCount(), 0)
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
