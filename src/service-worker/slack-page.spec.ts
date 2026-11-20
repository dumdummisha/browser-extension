import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import {
  isAnsweredBySlack,
  isNothingSent,
  runSlackPageCommand,
  type SlackPageCommand,
  type SlackPageResult,
  SlackPageResultSchema,
} from './slack-page.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const TOKEN = 'xoxc-0000-example'
// A caller's deadline that has not passed (2100-01-01) and one that has (2000-01-01).
const LATER = 4_102_444_800_000
const EARLIER = 946_684_800_000
// The query the service worker borrowed for the workspace's API (slack-request-shape.ts borrowedQueryString).
const CLIENT_QUERY =
  '_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_gantry=true&fp=7a&_x_num_retries=0'
const CALL: Extract<SlackPageCommand, { kind: 'call' }> = {
  kind: 'call',
  account: ACCOUNT,
  method: 'auth.test',
  params: {},
  queries: { 'https://example.slack.com': CLIENT_QUERY },
  deadline: LATER,
}

const savedConfig = (url: string): string =>
  JSON.stringify({ teams: { T0EXAMPLE1: { user_id: 'U0EXAMPLE1', name: 'Example', token: TOKEN, url } } })

// The Slack page the command runs in: the workspace's client, with what getItem answers as its saved client state.
const openSlackPage = (context: TestContext, getItem: () => string | null): void => {
  const page = {
    location: { pathname: '/client/T0EXAMPLE1/C0EXAMPLE1' },
    localStorage: { getItem },
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

  it("should call as Slack's client does: with the query borrowed for the workspace's API, and a multipart body", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const queries = { 'https://other.slack.com': 'slack_route=T0OTHER001', ...CALL.queries }

    // Act
    await runSlackPageCommand({ ...CALL, method: 'conversations.info', params: { channel: 'D0EXAMPLE1' }, queries })

    // Assert
    const [url, init] = fetched.mock.calls[0]?.arguments ?? []
    assert.equal(String(url), `https://example.slack.com/api/conversations.info?${CLIENT_QUERY}`)
    assert.ok(init?.body instanceof FormData)
    assert.deepEqual(Object.fromEntries(init.body.entries()), {
      channel: 'D0EXAMPLE1',
      token: TOKEN,
      _x_mode: 'online',
      _x_sonic: 'true',
      _x_app_name: 'client',
    })
  })

  it("should answer a failure code, sending nothing, when no query was borrowed for the workspace's API", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    const result = await runSlackPageCommand({ ...CALL, queries: { 'https://other.slack.com': CLIENT_QUERY } })

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

// Chrome (from 140, the manifest's minimum) decodes base64 with Uint8Array.fromBase64, which Node 24 lacks; the page
// gets it for the test, from Buffer.
const decodeBase64InPage = (context: TestContext): void => {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value: (text: string) => new Uint8Array(Buffer.from(text, 'base64')),
    configurable: true,
  })
  context.after(() => Reflect.deleteProperty(Uint8Array, 'fromBase64'))
}

describe('[service-worker] Slack page - uploads', () => {
  const UPLOAD_URL = 'https://files.slack.com/upload/v1/example-grant'
  const UPLOAD: SlackPageCommand = {
    kind: 'upload',
    account: ACCOUNT,
    uploadUrl: UPLOAD_URL,
    filename: 'notes.txt',
    chunks: [Buffer.from('made-up ').toString('base64'), Buffer.from('notes').toString('base64')],
    deadline: LATER,
  }

  it('should post the bytes to the upload URL it is given, as one multipart file, without cookies or redirects', async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    decodeBase64InPage(context)
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('OK')))

    // Act
    const result = await runSlackPageCommand(UPLOAD)

    // Assert
    assert.deepEqual(result, { kind: 'uploaded' })
    const [url, init] = fetched.mock.calls[0]?.arguments ?? []
    const file = init?.body instanceof FormData ? init.body.get('filename') : null
    assert.deepEqual([url, init?.method, init?.credentials, init?.redirect], [UPLOAD_URL, 'POST', undefined, 'error'])
    assert.ok(file instanceof File)
    assert.deepEqual([file.name, await file.text()], ['notes.txt', 'made-up notes'])
  })

  it('should answer the status of an upload URL that refused the bytes', async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    decodeBase64InPage(context)
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status: 413 })))

    // Act
    const result = await runSlackPageCommand(UPLOAD)

    // Assert
    assert.deepEqual(result, { kind: 'upload-refused', status: 413 })
  })

  it('should answer a failure code when the upload URL redirects, which fetch refuses', async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    decodeBase64InPage(context)
    context.mock.method(globalThis, 'fetch', () => Promise.reject(new TypeError('Failed to fetch')))

    // Act
    const result = await runSlackPageCommand(UPLOAD)

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'upload-unreachable', status: null })
  })
})

describe('[service-worker] Slack page - deadlines', () => {
  it("should send nothing of a command that runs once its deadline passed, for a call, a download and an upload's bytes", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    decodeBase64InPage(context)
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const commands: SlackPageCommand[] = [
      { ...CALL, deadline: EARLIER },
      {
        kind: 'download',
        account: ACCOUNT,
        url: 'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/a.txt',
        deadline: EARLIER,
      },
      {
        kind: 'upload',
        account: ACCOUNT,
        uploadUrl: 'https://files.slack.com/upload/v1/example-grant',
        filename: 'a.txt',
        chunks: [Buffer.from('made-up').toString('base64')],
        deadline: EARLIER,
      },
    ]

    // Act
    const results = []
    for (const command of commands) {
      results.push(await runSlackPageCommand(command))
    }

    // Assert
    assert.deepEqual(
      results,
      commands.map(() => ({ kind: 'failed', failure: 'deadline-passed', status: null }))
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

describe('[service-worker] Slack page - what a result shows', () => {
  it('should tell a result that shows nothing went out to Slack, and one Slack answered', () => {
    // Arrange
    const results: SlackPageResult[] = [
      { kind: 'answer', answer: { ok: false, error: 'ratelimited' } },
      { kind: 'upload-refused', status: 413 },
      { kind: 'other-account' },
      { kind: 'failed', failure: 'no-client-query', status: null },
      { kind: 'failed', failure: 'deadline-passed', status: null },
      { kind: 'failed', failure: 'api-unreachable', status: null },
      { kind: 'failed', failure: 'api-refused', status: 429 },
      { kind: 'failed', failure: 'uncaught', status: null },
    ]

    // Act
    const shown = results.map((result) => [isNothingSent(result), isAnsweredBySlack(result)])

    // Assert
    assert.deepEqual(shown, [
      [false, true],
      [false, true],
      [true, false],
      [true, false],
      [true, false],
      [false, false],
      [false, true],
      [false, false],
    ])
  })
})
