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
import { EARLIER, LATER, replaceGlobal } from './testing.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const TOKEN = 'xoxc-0000-example'

// The query the service worker sends for the workspace's API, as the page's observer kept it (borrowed-query.ts
// borrowedQueryString).
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

// The id of a session the command starts while Math.random answers 0 (Slack's makeSessionId).
const NEW_SESSION_ID = 'AAAAAAAAAAA'

const savedConfig = (url: string, team: Readonly<Record<string, string>> = {}): string =>
  JSON.stringify({ teams: { T0EXAMPLE1: { user_id: 'U0EXAMPLE1', name: 'Example', token: TOKEN, url, ...team } } })

// The Slack page the command runs in: the workspace's client, with what savedState answers as its saved client state,
// and the page's other localStorage entries in the map it answers, which the command may change.
const openSlackPage = (
  context: TestContext,
  savedState: () => string | null,
  pathname = '/client/T0EXAMPLE1/C0EXAMPLE1'
): Map<string, string> => {
  const stored = new Map<string, string>()

  const page = {
    location: { pathname },
    localStorage: {
      getItem: (key: string) => (key === 'localConfig_v2' ? savedState() : (stored.get(key) ?? null)),
      setItem: (key: string, value: string) => {
        stored.set(key, value)
      },
    },
  }

  const restores: (() => void)[] = []

  for (const [name, value] of Object.entries(page)) {
    replaceGlobal(restores, name, value)
  }

  context.after(() => {
    for (const restore of restores) {
      restore()
    }
  })

  return stored
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
    context.mock.method(Math, 'random', () => 0)
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const queries = { 'https://other.slack.com': 'slack_route=T0OTHER001', ...CALL.queries }

    // Act
    await runSlackPageCommand({ ...CALL, method: 'conversations.info', params: { channel: 'D0EXAMPLE1' }, queries })

    // Assert
    const [url, init] = fetched.mock.calls[0]?.arguments ?? []

    assert.equal(
      String(url),
      `https://example.slack.com/api/conversations.info?${CLIENT_QUERY.replace('example-csid', NEW_SESSION_ID)}`
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

// The time the activity-session cases run at (2026-11-17), and the localStorage key of the workspace's sessions.
const NOW = 1_794_900_000_000
const SESSIONS_KEY = 'activitySession_T0EXAMPLE1'
// Slack's client's limits: a session is active for 60 s after its last activity and pruned a day after it.
const ACTIVE_MS = 60_000
const STALE_MS = 86_400_000

// A session as Slack's client stores it.
const storedSession = (
  id: string,
  startTime: number,
  lastActivity: number,
  fields: Record<string, unknown> = {}
): Record<string, unknown> & { readonly id: string } => ({
  id,
  startTime,
  lastActivity,
  lastLogged: null,
  definitionVersion: 1,
  ...fields,
})

const queryOf = (fetched: { mock: { calls: { arguments: unknown[] }[] } }): string =>
  new URL(String(fetched.mock.calls[0]?.arguments[0])).search.slice(1)

describe('[service-worker] Slack page - activity session', () => {
  it('should extend the active session and send its id in place of the borrowed _x_csid', async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const active = storedSession('Sactive0001', NOW - 300_000, NOW - ACTIVE_MS + 1)
    stored.set(SESSIONS_KEY, JSON.stringify({ [active.id]: active }))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', 'Sactive0001'))
    assert.equal(stored.get(SESSIONS_KEY), JSON.stringify({ [active.id]: { ...active, lastActivity: NOW } }))
  })

  it("should write _x_csid right before slack_route, where Slack's client writes it, when the borrowed query has none", async (context) => {
    // Arrange
    openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.method(Math, 'random', () => 0)
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const query = '_x_id=0f1e2d3c-1794900000.100&_x_gantry=true&slack_route=T0EXAMPLE1&_x_version_ts=1794800000'

    // Act
    await runSlackPageCommand({ ...CALL, queries: { 'https://example.slack.com': query } })

    // Assert
    assert.equal(
      queryOf(fetched),
      `_x_id=0f1e2d3c-1794900000.100&_x_gantry=true&_x_csid=${NEW_SESSION_ID}&slack_route=T0EXAMPLE1&_x_version_ts=1794800000`
    )
  })

  it("should start a new session once the others expired or ended, keeping them as Slack's pruning leaves them", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    context.mock.method(Math, 'random', () => 0)

    const expired = storedSession('Sexpired001', NOW - 600_000, NOW - ACTIVE_MS, {
      lastLogged: NOW - 120_000,
      v1Start: NOW - 600_000,
    })

    const ended = storedSession('Sended00001', NOW - 30_000, NOW - 1_000, { ended: true })
    const lastKept = storedSession('Slastkept01', NOW - STALE_MS - 60_000, NOW - STALE_MS)
    const stale = storedSession('Sstale00001', NOW - STALE_MS - 60_000, NOW - STALE_MS - 1)

    stored.set(
      SESSIONS_KEY,
      JSON.stringify(Object.fromEntries([expired, stale, ended, lastKept].map((session) => [session.id, session])))
    )

    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', NEW_SESSION_ID))

    assert.equal(
      stored.get(SESSIONS_KEY),
      JSON.stringify({
        [expired.id]: expired,
        [ended.id]: ended,
        [lastKept.id]: lastKept,
        [NEW_SESSION_ID]: storedSession(NEW_SESSION_ID, NOW, NOW),
      })
    )
  })

  it('should extend the active session that started first when several are active', async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const later = storedSession('Slater00001', NOW - 10_000, NOW - 1_000)
    const earlier = storedSession('Searlier001', NOW - 20_000, NOW - 2_000)
    stored.set(SESSIONS_KEY, JSON.stringify({ [later.id]: later, [earlier.id]: earlier }))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', 'Searlier001'))

    assert.equal(
      stored.get(SESSIONS_KEY),
      JSON.stringify({ [later.id]: later, [earlier.id]: { ...earlier, lastActivity: NOW } })
    )
  })

  it("should keep an Enterprise Grid workspace's sessions under its enterprise id, from the saved team or the path", async (context) => {
    // Arrange
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    const enterpriseConfig = JSON.stringify({
      teams: {
        E0EXAMPLE1: { user_id: 'U0EXAMPLE1', name: 'Example', token: TOKEN, url: 'https://example.slack.com/' },
      },
    })

    // Act
    const fromTeam = openSlackPage(context, () =>
      savedConfig('https://example.slack.com/', { enterprise_id: 'E0EXAMPLE1' })
    )

    await runSlackPageCommand(CALL)

    const fromPath = openSlackPage(context, () => enterpriseConfig, '/client/E0EXAMPLE1/C0EXAMPLE1')
    await runSlackPageCommand({ ...CALL, account: { teamId: 'E0EXAMPLE1', userId: 'U0EXAMPLE1' } })

    // Assert
    assert.deepEqual(
      [[...fromTeam.keys()], [...fromPath.keys()]],
      [['activitySession_E0EXAMPLE1'], ['activitySession_E0EXAMPLE1']]
    )
  })

  it('should take stored sessions that do not parse as none, as the client does', async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    context.mock.method(Math, 'random', () => 0)
    stored.set(SESSIONS_KEY, '{"Sbroken0001":')
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'answer', answer: { ok: true } })
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', NEW_SESSION_ID))

    assert.equal(
      stored.get(SESSIONS_KEY),
      JSON.stringify({ [NEW_SESSION_ID]: storedSession(NEW_SESSION_ID, NOW, NOW) })
    )
  })

  it("should answer a failure code, sending nothing and changing nothing, where Slack's client throws while recording", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const active = storedSession('Sactive0001', NOW - 20_000, NOW - 1_000)

    // An array whose active element's id names no index, primitives the new session cannot be assigned to, a null
    // entry, an active id that names no entry, an active entry with no id, and a last activity + cannot convert.
    const values = [
      JSON.stringify([active]),
      '7',
      '"text"',
      'true',
      '{"Sother00001":null}',
      JSON.stringify({ Snamed00001: active }),
      JSON.stringify({ Snoid000001: { startTime: active.startTime, lastActivity: active.lastActivity } }),
      '{"Sodd0000001":{"lastActivity":{"toString":1,"valueOf":1}}}',
    ]

    // Act
    const outcomes: [SlackPageResult, string | undefined][] = []

    for (const value of values) {
      stored.set(SESSIONS_KEY, value)
      outcomes.push([await runSlackPageCommand(CALL), stored.get(SESSIONS_KEY)])
    }

    // Assert
    assert.deepEqual(
      outcomes,
      values.map((value) => [{ kind: 'failed', failure: 'activity-session-unreadable', status: null }, value])
    )
    assert.equal(fetched.mock.callCount(), 0)
  })

  it("should answer a failure code, sending nothing, when the write loses the session or leaves what Slack's read throws on", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    context.mock.method(Math, 'random', () => 0)
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const indexed = storedSession('0', NOW - 20_000, NOW - 1_000)
    const stale = storedSession('1', 1, 1)
    // The new session lands on an array under a name JSON.stringify drops; pruning an array leaves a null its read
    // throws on.
    const values = ['[]', JSON.stringify([stale]), JSON.stringify([indexed, stale])]

    // Act
    const outcomes: [SlackPageResult, string | undefined][] = []

    for (const value of values) {
      stored.set(SESSIONS_KEY, value)
      outcomes.push([await runSlackPageCommand(CALL), stored.get(SESSIONS_KEY)])
    }

    // Assert
    const failed = { kind: 'failed', failure: 'activity-session-unreadable', status: null }

    assert.deepEqual(outcomes, [
      [failed, '[]'],
      [failed, '[null]'],
      [failed, JSON.stringify([{ ...indexed, lastActivity: NOW }, null])],
    ])

    assert.equal(fetched.mock.callCount(), 0)
  })

  it("should extend an active array element its id names by index, and send that id, as Slack's client does", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const indexed = storedSession('0', NOW - 20_000, NOW - 1_000)
    stored.set(SESSIONS_KEY, JSON.stringify([indexed]))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', '0'))
    assert.equal(stored.get(SESSIONS_KEY), JSON.stringify([{ ...indexed, lastActivity: NOW }]))
  })

  it("should extend the entry an active session's id names, and send the session Slack's read then gives", async (context) => {
    // Arrange - the active entry's id names an older entry, which the client extends and then reads as active
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const target = storedSession('Sother00001', NOW - 600_000, NOW - 300_000)
    const alias = storedSession(target.id, NOW - 20_000, NOW - 1_000)
    stored.set(SESSIONS_KEY, JSON.stringify({ [target.id]: target, Salias00001: alias }))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', target.id))

    assert.equal(
      stored.get(SESSIONS_KEY),
      JSON.stringify({ [target.id]: { ...target, lastActivity: NOW }, Salias00001: alias })
    )
  })

  it('should extend a sole active session with no start, and one whose last activity is a numeric string', async (context) => {
    // Arrange - + joins a string last activity with 60000, so '17949000' reads as 1794900060000, after NOW, where
    // adding the number would read 18009000
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))
    const noStart = { id: 'Snostart001', lastActivity: NOW - 500 }
    const coerced = { id: 'Scoerce0001', startTime: NOW - 20_000, lastActivity: '17949000' }

    // Act
    const written: (string | undefined)[] = []

    for (const session of [noStart, coerced]) {
      stored.set(SESSIONS_KEY, JSON.stringify({ [session.id]: session }))
      await runSlackPageCommand(CALL)
      written.push(stored.get(SESSIONS_KEY))
    }

    // Assert
    assert.deepEqual(
      fetched.mock.calls.map((call) => new URL(String(call.arguments[0])).searchParams.get('_x_csid')),
      [noStart.id, coerced.id]
    )

    assert.deepEqual(written, [
      JSON.stringify({ [noStart.id]: { ...noStart, lastActivity: NOW } }),
      JSON.stringify({ [coerced.id]: { ...coerced, lastActivity: NOW } }),
    ])
  })

  it("should order active sessions' start times as lodash's sortBy does: by coercion, with null after the rest", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const nullStart = { id: 'Snullstart1', startTime: null, lastActivity: NOW - 1_000 }
    const stringStart = { id: 'Sstrstart01', startTime: '5', lastActivity: NOW - 1_000 }
    const numberStart = storedSession('Snumstart01', NOW - 10_000, NOW - 1_000)

    stored.set(
      SESSIONS_KEY,
      JSON.stringify(Object.fromEntries([nullStart, numberStart, stringStart].map((session) => [session.id, session])))
    )

    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', stringStart.id))
  })

  it('should prune a stale entry whose id is not its name, as the client does, and start a new session', async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    context.mock.method(Math, 'random', () => 0)
    stored.set(SESSIONS_KEY, '{"Sother00001":{"id":"Snotitskey1","startTime":1,"lastActivity":1}}')
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'answer', answer: { ok: true } })
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', NEW_SESSION_ID))

    assert.equal(
      stored.get(SESSIONS_KEY),
      JSON.stringify({ [NEW_SESSION_ID]: storedSession(NEW_SESSION_ID, NOW, NOW) })
    )
  })

  it("should extend the active session beside entries it cannot read as sessions, keeping or pruning them as Slack's client does", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const active = storedSession('Sactive0001', NOW - 20_000, NOW - 1_000)

    // Kept: no object, or no last activity a subtraction reads as a number. Pruned: a last activity a subtraction reads
    // as more than a day ago (a numeric string, null).
    const kept = {
      Stext000001: 'text',
      Snumber0001: 5,
      Sarray00001: [],
      Snolast0001: { id: 'Snolast0001', startTime: NOW - 20_000 },
      Snostart001: { id: 'Snostart001', lastActivity: NOW - 500 },
    }

    const pruned = {
      Sstring0001: { id: 'Sstring0001', startTime: 1, lastActivity: '1' },
      Snull000001: { id: 'Snull000001', startTime: 1, lastActivity: null },
    }

    stored.set(SESSIONS_KEY, JSON.stringify({ ...kept, ...pruned, [active.id]: active }))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', 'Sactive0001'))
    assert.equal(stored.get(SESSIONS_KEY), JSON.stringify({ ...kept, [active.id]: { ...active, lastActivity: NOW } }))
  })

  it("should send no _x_csid for an active session whose id is empty, as Slack's client writes none", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const active = storedSession('', NOW - 20_000, NOW - 1_000)
    stored.set(SESSIONS_KEY, JSON.stringify({ '': active }))
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('_x_csid=example-csid&', ''))
    assert.equal(stored.get(SESSIONS_KEY), JSON.stringify({ '': { ...active, lastActivity: NOW } }))
  })

  it('should prune at the time pruning starts, which Slack reads after the activity time', async (context) => {
    // Arrange - the clock moves 1 ms while the command reads the sessions
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    context.mock.method(Math, 'random', () => 0)
    const dayOld = storedSession('Sdayold0001', NOW - STALE_MS - 60_000, NOW - STALE_MS)
    stored.set(SESSIONS_KEY, JSON.stringify({ [dayOld.id]: dayOld }))
    const read = stored.get.bind(stored)

    context.mock.method(stored, 'get', (key: string) => {
      const value = read(key)
      context.mock.timers.tick(1)
      return value
    })

    context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(read(SESSIONS_KEY), JSON.stringify({ [NEW_SESSION_ID]: storedSession(NEW_SESSION_ID, NOW, NOW) }))
  })

  it("should make a new session's id as Slack's makeSessionId does, masking the last character's index with 60", async (context) => {
    // Arrange - the draws land on Z a z 0 9 - _ A M q, then on _ (63), which the mask turns into 8 (60)
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    context.mock.timers.enable({ apis: ['Date'], now: NOW })
    const draws = [25, 26, 51, 52, 61, 62, 63, 0, 12, 42, 63].map((index) => (index + 0.5) / 64)
    context.mock.method(Math, 'random', () => draws.shift() ?? Number.NaN)
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    await runSlackPageCommand(CALL)

    // Assert
    assert.equal(queryOf(fetched), CLIENT_QUERY.replace('example-csid', 'Zaz09-_AMq8'))
    assert.equal(stored.get(SESSIONS_KEY), JSON.stringify({ 'Zaz09-_AMq8': storedSession('Zaz09-_AMq8', NOW, NOW) }))
  })

  it("should answer a failure code, sending nothing, when the page's storage refuses the session", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))

    context.mock.method(stored, 'set', () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    })

    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({ ok: true })))

    // Act
    const result = await runSlackPageCommand(CALL)

    // Assert
    assert.deepEqual(result, { kind: 'failed', failure: 'activity-session-unsaved', status: null })
    assert.equal(fetched.mock.callCount(), 0)
  })

  it("should record no session for a file's download or upload, which Slack's client sends without _x_csid", async (context) => {
    // Arrange
    const stored = openSlackPage(context, () => savedConfig('https://example.slack.com/'))
    decodeBase64InPage(context)
    context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('OK')))

    // Act
    await runSlackPageCommand({
      kind: 'download',
      account: ACCOUNT,
      url: 'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/a.txt',
      deadline: LATER,
    })

    await runSlackPageCommand({
      kind: 'upload',
      account: ACCOUNT,
      uploadUrl: 'https://files.slack.com/upload/v1/example-grant',
      filename: 'a.txt',
      chunks: [Buffer.from('made-up').toString('base64')],
      deadline: LATER,
    })

    // Assert
    assert.deepEqual([...stored.keys()], [])
  })
})

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
      { kind: 'failed', failure: 'activity-session-unreadable', status: null },
      { kind: 'failed', failure: 'activity-session-unsaved', status: null },
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
      [true, false],
      [true, false],
      [false, false],
      [false, true],
      [false, false],
    ])
  })
})
