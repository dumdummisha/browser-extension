import assert from 'node:assert/strict'
import { after, before, describe, it, type Mock, type TestContext } from 'node:test'
import type { SlackPageCommand } from './slack-page.js'
import { chromeEvent, emit, fakeWebRequest, HOST_HELLO, type IChromeEvent, settled, tick } from './testing.js'

// The service worker's Slack dispatch (extension/background.ts), driven through its native port as the relay drives
// it: the build's bundle of background.ts runs in a fake Chrome, whose Slack tabs run each command handed to them
// through the page function itself, against pages with made-up state and a mocked fetch, and whose relays answer the
// client queries a test gives them. Each test starts a worker of its own, a fresh copy of the bundle, so it sees the
// startup attachment of its own tabs. The fake Chrome binds an injection with documentIds and a message with documentId
// to that document, as Chrome does. The spec lives here, beside the modules the tests load, since the build replaces
// the compiled extension folder with its bundles.

// What the service worker hands chrome.scripting.executeScript: a Slack page command (MAIN), the relay probe
// (ISOLATED) or the relay's bundle (files).
interface IInjection {
  readonly target: { readonly tabId: number; readonly documentIds?: readonly string[] }
  readonly world?: 'MAIN' | 'ISOLATED'
  readonly files?: readonly string[]
  readonly func?: (command: SlackPageCommand) => Promise<unknown>
  readonly args?: readonly [SlackPageCommand]
}

// A command handed to a page: the tab it went to, and the time on the clock when it was handed over.
interface IHandOver {
  readonly tabId: number
  readonly command: SlackPageCommand
  readonly at: number
}

interface IAccount {
  readonly teamId: string
  readonly userId: string
}

// What a tab's relay answers the service worker's CLIENT_QUERY.
interface IFakeRelay {
  readonly answer: () => Promise<unknown>
}

// A Slack tab: the document it shows, the account its page is signed in as, the activity sessions a page command
// records there, the relay of the running load of the extension in that document (null for none), and how an
// injection of a new relay goes, at once unless a test holds it or fails it.
interface IFakeTab {
  readonly id: number
  documentId: string
  account: IAccount
  readonly storage: Map<string, string>
  relay: IFakeRelay | null
  injectRelay: () => Promise<void>
}

// The fake Chrome's Slack tabs, every command handed to a page, every CLIENT_QUERY a relay was asked, every relay
// injection, and how a page runs a command: through run, the page function itself, at once unless a test holds it,
// changes the tab around it, or loses its result.
interface IFakeBrowser {
  tabs: IFakeTab[]
  handOvers: IHandOver[]
  relayReads: { readonly tabId: number; readonly at: number }[]
  injections: { readonly tabId: number; readonly documentId: string }[]
  runInPage: (tab: IFakeTab, command: SlackPageCommand, run: () => Promise<unknown>) => Promise<unknown>
}

// The native port of the worker under test, and the replies waiting for its answers.
interface IWorkerPort {
  portMessages: IChromeEvent
  replies: Map<number, (reply: unknown) => void>
}

const SLACK_ORIGIN = 'https://app.slack.com'
const API_ORIGIN = 'https://example.slack.com'
const OTHER_API_ORIGIN = 'https://other.slack.com'
const UPLOAD_URL = 'https://files.slack.com/upload/v1/example-grant'
const FILE_URL = 'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt'
const UPLOAD_ID = '00000000-0000-4000-8000-000000000001'
const NOTES = 'made-up notes'
const NOW = 1_794_900_000_000
const DEADLINE = NOW + 60_000

// The gap the pace draws lies in this range (request-pace.ts).
const GAP_MIN_MS = 500
const GAP_MAX_MS = 2_000

// The messages the service worker sends a relay, and the relay's bundle (config.ts, which the build leaves out of the
// compiled extension).
const CLIENT_QUERY = 'misha-client-query'
const CAPTURE_QUERY = 'misha-capture-query'
const RELAY_SCRIPT = 'relay.js'
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
const GAVE_UP = 'The caller gave up on the request before it was sent, so it was not sent'
const VERSION_A = '1794800000'
const VERSION_B = '1794800001'

const runAtOnce: IFakeBrowser['runInPage'] = (_tab, _command, run) => run()

const browser: IFakeBrowser = { tabs: [], handOvers: [], relayReads: [], injections: [], runInPage: runAtOnce }
const workerPort: IWorkerPort = { portMessages: chromeEvent(), replies: new Map() }
let workers = 0

// The page whose globals a running command reads. Pages run one command at a time, so no command reads another tab's
// page while it awaits.
let shownTab: IFakeTab | null = null
let pageTurns: Promise<unknown> = Promise.resolve()

const shown = (): IFakeTab => {
  assert.ok(shownTab !== null, 'a page global was read outside a page command')

  return shownTab
}

const inPage = <TResult>(tab: IFakeTab, run: () => Promise<TResult>): Promise<TResult> => {
  const turn = pageTurns.then(() => {
    shownTab = tab

    return run()
  })

  pageTurns = turn.then(
    () => undefined,
    () => undefined
  )

  return turn
}

const tabOf = (tabId: number): IFakeTab => {
  const tab = browser.tabs.find(({ id }) => id === tabId)
  if (tab === undefined) {
    throw new Error(`No tab with id: ${tabId}`)
  }

  return tab
}

const documentGone = (tab: IFakeTab, documentId: string): Error =>
  new Error(`No document with id ${documentId} in tab with id ${tab.id}`)

const executeScript = async (injection: IInjection): Promise<unknown[]> => {
  const tab = tabOf(injection.target.tabId)
  const [boundDocument] = injection.target.documentIds ?? [tab.documentId]
  if (boundDocument !== tab.documentId) {
    throw documentGone(tab, boundDocument ?? '')
  }

  const { documentId } = tab

  if (injection.files?.includes(RELAY_SCRIPT) === true) {
    browser.injections.push({ tabId: tab.id, documentId })
    await tab.injectRelay()

    return [{ documentId, frameId: 0 }]
  }

  if (injection.world === 'ISOLATED') {
    return [{ documentId, frameId: 0, result: { origin: SLACK_ORIGIN, hasRelay: tab.relay !== null } }]
  }

  const { func, args } = injection
  assert.ok(func !== undefined && args !== undefined, 'a page command comes with its function and command')
  const [command] = args
  browser.handOvers.push({ tabId: tab.id, command, at: Date.now() })
  const result = await browser.runInPage(tab, command, () => inPage(tab, () => func(command)))

  return [{ documentId, frameId: 0, result }]
}

const sendMessage = (tabId: number, message: unknown, options?: { readonly documentId?: string }): Promise<unknown> => {
  const tab = tabOf(tabId)
  const { relay } = tab
  if (relay === null || (options?.documentId !== undefined && options.documentId !== tab.documentId)) {
    return Promise.reject(new Error(NO_RECEIVER))
  }

  if (message === CLIENT_QUERY) {
    browser.relayReads.push({ tabId, at: Date.now() })

    return relay.answer()
  }

  assert.equal(message, CAPTURE_QUERY)

  return Promise.resolve({ isSocketOpen: true, error: null })
}

// A fresh Chrome for a fresh worker: its events are its own, so a worker of an earlier test hears none of them.
const fakeChrome = (): object => {
  const portMessages = chromeEvent()
  const replies = new Map<number, (reply: unknown) => void>()
  workerPort.portMessages = portMessages
  workerPort.replies = replies

  return {
    runtime: {
      connectNative: () => ({
        onMessage: portMessages,
        onDisconnect: chromeEvent(),
        postMessage: (reply: { readonly id: number }) => replies.get(reply.id)?.(reply),
      }),
      onMessage: chromeEvent(),
      getManifest: () => ({ name: 'Misha Browser', version: '1.2.3' }),
    },
    action: { setBadgeText: () => Promise.resolve(), setTitle: () => Promise.resolve() },
    tabs: {
      query: () =>
        Promise.resolve(
          browser.tabs.map(({ id, account }) => ({ id, url: `${SLACK_ORIGIN}/client/${account.teamId}` }))
        ),
      sendMessage,
      onRemoved: chromeEvent(),
      onUpdated: chromeEvent(),
    },
    scripting: { executeScript },
    webRequest: fakeWebRequest(),
    alarms: { create: () => Promise.resolve(), onAlarm: chromeEvent() },
  }
}

// Sends a request on the native port, as the relay does, and answers the reply the service worker sends back.
const ask = (id: number, method: string, params: unknown, deadline = DEADLINE): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  workerPort.replies.set(id, resolve)
  emit(workerPort.portMessages, { type: 'request', id, method, params, deadline })

  return promise
}

const cancel = (id: number): void => {
  emit(workerPort.portMessages, { type: 'cancel', id })
}

const handedOver = (kind: SlackPageCommand['kind']): IHandOver[] =>
  browser.handOvers.filter(({ command }) => command.kind === kind)

const deadlineOf = (handOver: IHandOver | undefined): number | null =>
  handOver === undefined || handOver.command.kind === 'identity' ? null : handOver.command.deadline

const until = async (condition: () => boolean): Promise<void> => {
  for (let step = 0; step < 50 && !condition(); step += 1) {
    await settled()
  }

  assert.ok(condition(), 'The service worker never got there')
}

// The client query a tab's observer keeps for the workspace API, with the page's version as its marker.
const clientQuery = ({ teamId }: IAccount, versionTs = VERSION_A): unknown => [
  ['_x_id', null],
  ['_x_csid', 'example-csid'],
  ['slack_route', teamId],
  ['_x_version_ts', versionTs],
  ['_x_num_retries', null],
]

// A relay that answers queries for every CLIENT_QUERY, or null when given none.
const relayWith = (queries: object | null): IFakeRelay => ({ answer: () => Promise.resolve({ queries }) })

// A Slack tab whose page is signed in as the account and whose relay of the running load holds the query of its
// client's call to the workspace API, unless the test changes either.
const slackTab = (id: number, account: IAccount = { teamId: `T0DISPATCH${id}`, userId: 'U0EXAMPLE1' }): IFakeTab => {
  const tab: IFakeTab = {
    id,
    documentId: `DOC-${id}`,
    account,
    storage: new Map(),
    relay: relayWith({ [API_ORIGIN]: clientQuery(account) }),
    injectRelay: () => {
      tab.relay = relayWith({ [API_ORIGIN]: clientQuery(account) })

      return Promise.resolve()
    },
  }

  return tab
}

// Starts a worker of its own for the test on these tabs, with the clock at NOW.
const startWorker = async (context: TestContext, tabs: IFakeTab[]): Promise<void> => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
  browser.tabs = tabs
  browser.handOvers = []
  browser.relayReads = []
  browser.injections = []
  browser.runInPage = runAtOnce
  Object.defineProperty(globalThis, 'chrome', { value: fakeChrome(), configurable: true })
  workers += 1
  await import(`../extension/background.js?worker=${workers}`)

  emit(workerPort.portMessages, HOST_HELLO)
}

// A worker's startup on one open Slack tab whose relay of this load runs, as after Chrome stopped an idle worker.
const startOnTab = async (context: TestContext, id: number): Promise<IFakeTab> => {
  const tab = slackTab(id)
  await startWorker(context, [tab])

  return tab
}

// Slack's Web API answers every call with answer, and the upload URL and the private file answer OK.
const mockSlack = (context: TestContext, answer: object = { ok: true }): Mock<typeof fetch> =>
  context.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0]) =>
    Promise.resolve(String(input).startsWith(API_ORIGIN) ? Response.json(answer) : new Response('OK'))
  )

// The Web API calls that reached fetch: each one's method, the page version its query carries, and its request id.
const sentCalls = (
  fetched: Mock<typeof fetch>
): { method: string; versionTs: string | null; requestId: string | null }[] =>
  fetched.mock.calls.flatMap(({ arguments: [input] }) => {
    const url = new URL(String(input))

    return url.origin === API_ORIGIN
      ? [
          {
            method: url.pathname.replace('/api/', ''),
            versionTs: url.searchParams.get('_x_version_ts'),
            requestId: url.searchParams.get('_x_id'),
          },
        ]
      : []
  })

// Chrome (from 140, the manifest's minimum) decodes and encodes base64 with Uint8Array.fromBase64 and toBase64, which
// Node 24 lacks; the service worker and the page get both for the test, from Buffer, and lose them after it.
const supplyBase64 = (context: TestContext): void => {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value: (text: string) => new Uint8Array(Buffer.from(text, 'base64')),
    configurable: true,
  })

  const encoder = {
    toBase64(this: Uint8Array): string {
      return Buffer.from(this).toString('base64')
    },
  }

  // The page function encodes a file's bytes with the built-in Chrome has and Node lacks, so the test supplies it.
  // oxlint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: encoder.toBase64, configurable: true })

  context.after(() => {
    Reflect.deleteProperty(Uint8Array, 'fromBase64')
    Reflect.deleteProperty(Uint8Array.prototype, 'toBase64')
  })
}

// Takes the test runner's unhandled rejection listeners off for the test, and answers the first rejection no handler
// took: the startup pass throws the tabs whose relay could not be attached that way, so Chrome lists them.
const unhandledRejection = (context: TestContext): Promise<unknown> => {
  const runner = process.listeners('unhandledRejection')
  const { promise, resolve } = Promise.withResolvers<unknown>()
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', resolve)

  context.after(() => {
    process.removeAllListeners('unhandledRejection')
    for (const listener of runner) {
      process.on('unhandledRejection', listener)
    }
  })

  return promise
}

const postMessageCall = ({ account }: IFakeTab): unknown => ({
  account,
  method: 'chat.postMessage',
  params: { channel: 'C0EXAMPLE1', text: 'a made-up message' },
})

// Pushes the file's one chunk, then asks for it to be uploaded.
const prepareUpload = async ({ account }: IFakeTab, id: number): Promise<unknown> => {
  await ask(id, 'slackUploadChunk', { uploadId: UPLOAD_ID, index: 0, data: Buffer.from(NOTES).toString('base64') })

  return ask(id + 1, 'slackUploadPrepare', {
    account,
    uploadId: UPLOAD_ID,
    filename: 'notes.txt',
    byteLength: NOTES.length,
  })
}

const TICKET = { ok: true, upload_url: UPLOAD_URL, file_id: 'F0EXAMPLE1' }

const reloadMessage = ({ teamId, userId }: IAccount, tabs: string): string =>
  `No Slack tab signed in as slack:${teamId}:${userId} can send Misha's calls until it is reloaded (${tabs}). Reload the Slack tab, then try again.`

const unqueriedMessage = (tabId: number): string =>
  `The Slack page in tab ${tabId} failed call: Misha hasn't seen Slack in this tab make a request to this workspace yet. Wait for Slack to finish loading, then try again.`

// Holds the page's run of each command isHeld picks until the returned function releases them.
const holdInPage = (isHeld: (command: SlackPageCommand) => boolean): (() => void) => {
  const held = Promise.withResolvers<undefined>()

  browser.runInPage = async (_tab, command, run) => {
    if (isHeld(command)) {
      await held.promise
    }

    return run()
  }

  return () => held.resolve(undefined)
}

// Holds every answer of the tab's relay until the returned function releases them.
const holdRelay = (tab: IFakeTab): (() => void) => {
  const held = Promise.withResolvers<undefined>()
  const { relay } = tab
  assert.ok(relay !== null, 'the tab has a relay to hold')
  tab.relay = { answer: () => held.promise.then(() => relay.answer()) }

  return () => held.resolve(undefined)
}

// Holds the injection of the tab's new relay until the returned function releases it, and gives the relay then.
const holdInjection = (tab: IFakeTab): (() => void) => {
  const held = Promise.withResolvers<undefined>()
  const inject = tab.injectRelay
  tab.injectRelay = () => held.promise.then(inject)

  return () => held.resolve(undefined)
}

// A tab whose page loaded before this load of the extension: its relay was cut off, and the startup gives it a new one.
const cutOff = (tab: IFakeTab): IFakeTab => {
  tab.relay = null

  return tab
}

// The page globals the page function reads, from the tab whose command runs: its address, and its storage, which holds
// Slack's saved client state for the account it is signed in as beside the activity sessions a command records.
before(() => {
  const page = {
    location: {
      get pathname() {
        return `/client/${shown().account.teamId}/C0EXAMPLE1`
      },
    },
    localStorage: {
      getItem: (key: string) => {
        const { account, storage } = shown()

        const saved = {
          name: 'Example',
          user_id: account.userId,
          token: 'xoxc-0000-made-up-token',
          url: `${API_ORIGIN}/`,
        }

        return key === 'localConfig_v2'
          ? JSON.stringify({ teams: { [account.teamId]: saved } })
          : (storage.get(key) ?? null)
      },
      setItem: (key: string, value: string) => {
        shown().storage.set(key, value)
      },
    },
  }

  for (const [name, value] of Object.entries(page)) {
    Object.defineProperty(globalThis, name, { value, configurable: true })
  }
})

after(() => {
  for (const name of ['location', 'localStorage', 'chrome']) {
    Reflect.deleteProperty(globalThis, name)
  }
})

describe('[extension] Slack dispatch - callers that gave up', () => {
  it('should hand no command to the page when the caller cancels while its signed-in page is being found', async (context) => {
    // Arrange
    const tab = await startOnTab(context, 11)
    const fetched = mockSlack(context)
    const releaseIdentity = holdInPage(({ kind }) => kind === 'identity')

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('identity').length === 1)
    cancel(1)
    releaseIdentity()

    // Assert
    assert.deepEqual(await reply, { type: 'reply', id: 1, error: GAVE_UP })
    assert.deepEqual([browser.handOvers.length, fetched.mock.callCount()], [1, 0])
  })

  it("should hand no bytes to the page when the caller cancels between an upload's ticket and its bytes", async (context) => {
    // Arrange
    const tab = await startOnTab(context, 12)
    supplyBase64(context)
    const fetched = mockSlack(context, TICKET)

    // Act
    const reply = prepareUpload(tab, 1)
    await until(() => fetched.mock.callCount() === 1)
    await settled()
    cancel(2)

    // Assert
    assert.deepEqual(await reply, { type: 'reply', id: 2, error: GAVE_UP })

    assert.deepEqual(
      [handedOver('call').map(({ command }) => command.kind === 'call' && command.method), handedOver('upload')],
      [['files.getUploadURLExternal'], []]
    )
  })

  it('should send a command the caller cancels after its hand-off, since a cancel then comes too late', async (context) => {
    // Arrange
    const tab = await startOnTab(context, 13)
    const fetched = mockSlack(context, { ok: true, ts: '1794900000.000100' })
    const runPage = holdInPage(({ kind }) => kind !== 'identity')

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('call').length === 1)
    cancel(1)
    runPage()

    // Assert
    assert.deepEqual(await reply, { type: 'reply', id: 1, result: { ok: true, ts: '1794900000.000100' } })
    assert.equal(fetched.mock.callCount(), 1)
  })

  it('should hand nothing over and leave no gap when the caller cancels during the startup attachment', async (context) => {
    // Arrange
    const tab = cutOff(slackTab(14))
    const releaseInjection = holdInjection(tab)
    await startWorker(context, [tab])
    const fetched = mockSlack(context)

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('identity').length === 1)
    await settled()
    cancel(1)
    releaseInjection()
    const cancelled = await reply
    const next = ask(2, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('call').length === 1)

    // Assert
    assert.deepEqual(cancelled, { type: 'reply', id: 1, error: GAVE_UP })
    assert.deepEqual(await next, { type: 'reply', id: 2, result: { ok: true } })
    assert.deepEqual([handedOver('call')[0]?.at, fetched.mock.callCount()], [NOW, 1])
  })

  it("should hand nothing over and leave no gap when the deadline passes while the relay's answer is pending", async (context) => {
    // Arrange
    const tab = await startOnTab(context, 15)
    const fetched = mockSlack(context)
    const releaseRelay = holdRelay(tab)
    const deadline = NOW + 5_000

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tab), deadline)
    await until(() => browser.relayReads.length === 1)
    await tick(context, 5_000)
    releaseRelay()
    const expired = await reply
    const next = ask(2, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('call').length === 1)

    // Assert
    assert.deepEqual(expired, { type: 'reply', id: 1, error: GAVE_UP })
    assert.deepEqual(await next, { type: 'reply', id: 2, result: { ok: true } })
    assert.deepEqual([handedOver('call')[0]?.at, fetched.mock.callCount()], [NOW + 5_000, 1])
  })
})

describe('[extension] Slack dispatch - deadlines', () => {
  it('should send nothing of a command handed over before its deadline that the page runs after it', async (context) => {
    // Arrange
    const tab = await startOnTab(context, 21)
    const fetched = mockSlack(context)
    const deadline = NOW + 5_000
    const runPage = holdInPage(({ kind }) => kind !== 'identity')

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tab), deadline)
    await until(() => handedOver('call').length === 1)
    await tick(context, 5_000)
    runPage()

    // Assert
    const [call] = handedOver('call')

    assert.deepEqual(await reply, {
      type: 'reply',
      id: 1,
      error:
        "The Slack page in tab 21 failed call: The caller's deadline passed before the request went out, so nothing was sent",
    })

    assert.deepEqual([call?.at, deadlineOf(call), fetched.mock.callCount()], [NOW, deadline, 0])
  })

  it("should hand both of an upload's commands to the page with the caller's own deadline, a gap apart", async (context) => {
    // Arrange
    const tab = await startOnTab(context, 22)
    supplyBase64(context)
    const fetched = mockSlack(context, TICKET)

    // Act
    const reply = prepareUpload(tab, 1)
    await until(() => fetched.mock.callCount() === 1)
    await settled()
    await tick(context, GAP_MAX_MS)

    // Assert
    assert.deepEqual(await reply, { type: 'reply', id: 2, result: { ok: true, fileId: 'F0EXAMPLE1' } })
    const [ticket] = handedOver('call')
    const [bytes] = handedOver('upload')
    assert.deepEqual([deadlineOf(ticket), deadlineOf(bytes)], [DEADLINE, DEADLINE])
    assert.ok(ticket !== undefined && bytes !== undefined && bytes.at - ticket.at >= GAP_MIN_MS)
  })
})

describe('[extension] Slack dispatch - gaps after a hand-off', () => {
  const outcomes = [
    {
      tabId: 31,
      name: 'the page sent the request, then its tab closed before the result came back',
      answer: { ok: true },
      runInPage: async (_tab: IFakeTab, command: SlackPageCommand, run: () => Promise<unknown>): Promise<unknown> => {
        const result = await run()
        if (command.kind !== 'identity') {
          throw new Error('The tab was closed')
        }

        return result
      },
      error: 'The tab was closed',
    },
    {
      tabId: 32,
      name: 'the page answered what does not read',
      answer: { ok: true, error: 5 },
      runInPage: runAtOnce,
      error: 'The Slack page in tab 32 answered what does not read',
    },
  ]

  for (const outcome of outcomes) {
    it(`should wait a gap before the workspace's next request when ${outcome.name}`, async (context) => {
      // Arrange
      const tab = await startOnTab(context, outcome.tabId)
      const fetched = mockSlack(context, outcome.answer)
      browser.runInPage = outcome.runInPage
      const lost = await ask(1, 'slackCall', postMessageCall(tab))
      browser.runInPage = runAtOnce
      fetched.mock.mockImplementation(() => Promise.resolve(Response.json({ ok: true })))

      // Act
      const next = ask(2, 'slackCall', postMessageCall(tab))
      await until(() => handedOver('identity').length === 2)
      await settled()
      await tick(context, GAP_MIN_MS - 1)
      const beforeGap = handedOver('call').length
      await tick(context, GAP_MAX_MS - GAP_MIN_MS + 1)

      // Assert
      assert.deepEqual(lost, { type: 'reply', id: 1, error: outcome.error })
      assert.deepEqual(await next, { type: 'reply', id: 2, result: { ok: true } })
      assert.deepEqual([beforeGap, handedOver('call').length, fetched.mock.callCount()], [1, 2, 2])
    })
  }
})

describe('[extension] Slack dispatch - the startup attachment', () => {
  it("should hold a call that comes during the startup attachment until it settled, then send the relay's query", async (context) => {
    // Arrange
    const tab = cutOff(slackTab(41))
    const releaseInjection = holdInjection(tab)
    await startWorker(context, [tab])
    const fetched = mockSlack(context)

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('identity').length === 1)
    await settled()
    const readsBefore = browser.relayReads.length
    releaseInjection()

    // Assert
    assert.deepEqual(await reply, { type: 'reply', id: 1, result: { ok: true } })
    assert.equal(readsBefore, 0)

    assert.deepEqual(
      sentCalls(fetched).map(({ method, versionTs }) => [method, versionTs]),
      [['chat.postMessage', VERSION_A]]
    )
  })

  it('should call at once after a worker restart, whose relays still run, attaching none', async (context) => {
    // Arrange
    const tab = await startOnTab(context, 42)
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(tab))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, result: { ok: true } })

    assert.deepEqual(
      [browser.injections, handedOver('call')[0]?.at, sentCalls(fetched)[0]?.versionTs],
      [[], NOW, VERSION_A]
    )
  })

  it('should call after an extension reload through the new relay, which the surviving observer greeted', async (context) => {
    // Arrange
    const tab = cutOff(slackTab(43))
    await startWorker(context, [tab])
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(tab))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, result: { ok: true } })
    assert.deepEqual(browser.injections, [{ tabId: 43, documentId: 'DOC-43' }])
    assert.equal(sentCalls(fetched)[0]?.versionTs, VERSION_A)
  })

  it("should wait for every tab's attachment, so one that failed first cannot send a call to a tab still attaching", async (context) => {
    // Arrange - tab A's injection fails while its document stays, and tab B's finishes later
    const reported = unhandledRejection(context)
    const tabA = cutOff(slackTab(44, { teamId: 'T0OTHERTEAM', userId: 'U0OTHER001' }))
    tabA.injectRelay = () => Promise.reject(new Error('Cannot access the contents of the page'))
    const tabB = cutOff(slackTab(45))
    const releaseB = holdInjection(tabB)
    await startWorker(context, [tabA, tabB])
    const fetched = mockSlack(context)

    // Act
    const reply = ask(1, 'slackCall', postMessageCall(tabB))
    await until(() => handedOver('identity').length === 2)
    await settled()
    const readsWhileBAttaches = browser.relayReads.length
    releaseB()

    // Assert
    assert.deepEqual(await reply, { type: 'reply', id: 1, result: { ok: true } })
    assert.equal(readsWhileBAttaches, 0)

    assert.deepEqual(
      handedOver('call').map(({ tabId }) => tabId),
      [45]
    )

    assert.equal(fetched.mock.callCount(), 1)
    const failure = await reported
    assert.ok(failure instanceof AggregateError)
    assert.equal(failure.message, 'No relay could be attached in Slack tab 44')
  })
})

describe('[extension] Slack dispatch - tabs that cannot send', () => {
  it('should ask for a reload when the relay has no query to give, handing nothing over and leaving no gap', async (context) => {
    // Arrange
    const tab = await startOnTab(context, 51)
    tab.relay = relayWith(null)
    const fetched = mockSlack(context)
    const refused = await ask(1, 'slackCall', postMessageCall(tab))
    tab.relay = relayWith({ [API_ORIGIN]: clientQuery(tab.account) })

    // Act
    const next = ask(2, 'slackCall', postMessageCall(tab))
    await until(() => handedOver('call').length === 1)

    // Assert
    assert.deepEqual(refused, { type: 'reply', id: 1, error: reloadMessage(tab.account, 'tab 51') })
    assert.deepEqual(await next, { type: 'reply', id: 2, result: { ok: true } })
    assert.deepEqual([handedOver('call')[0]?.at, fetched.mock.callCount()], [NOW, 1])
  })

  it('should ask for a reload of a tab whose relay could not be attached, which no relay answers', async (context) => {
    // Arrange
    const reported = unhandledRejection(context)
    const tab = cutOff(slackTab(52))
    tab.injectRelay = () => Promise.reject(new Error('Cannot access the contents of the page'))
    await startWorker(context, [tab])
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(tab))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, error: reloadMessage(tab.account, 'tab 52') })
    assert.deepEqual([handedOver('call'), fetched.mock.callCount()], [[], 0])
    assert.ok((await reported) instanceof AggregateError)
  })

  it('should send through the second tab of the account when the first has no query to give', async (context) => {
    // Arrange
    const first = slackTab(53)
    first.relay = relayWith(null)
    const second = slackTab(54, first.account)
    await startWorker(context, [first, second])
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(first))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, result: { ok: true } })
    assert.deepEqual([handedOver('call').map(({ tabId }) => tabId), fetched.mock.callCount()], [[54], 1])
  })

  it("should send through the second tab when the first holds no query for the workspace's API, with no gap between", async (context) => {
    // Arrange
    const first = slackTab(55)
    first.relay = relayWith({ [OTHER_API_ORIGIN]: clientQuery(first.account) })
    const second = slackTab(56, first.account)
    await startWorker(context, [first, second])
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(first))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, result: { ok: true } })

    assert.deepEqual(
      handedOver('call').map(({ tabId, at }) => [tabId, at]),
      [
        [55, NOW],
        [56, NOW],
      ]
    )

    assert.equal(fetched.mock.callCount(), 1)
  })

  it('should ask to wait for Slack when every tab holds no query for the workspace, over a tab to reload', async (context) => {
    // Arrange
    const unqueried = slackTab(57)
    unqueried.relay = relayWith({})
    const unready = slackTab(58, unqueried.account)
    unready.relay = relayWith(null)
    await startWorker(context, [unready, unqueried])
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(unqueried))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, error: unqueriedMessage(57) })
    assert.equal(fetched.mock.callCount(), 0)
  })

  it('should not try the next tab after a failure that may follow a request Slack received', async (context) => {
    // Arrange
    const first = slackTab(59)
    const second = slackTab(60, first.account)
    await startWorker(context, [first, second])
    const fetched = context.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('', { status: 500 })))

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(first))

    // Assert
    assert.deepEqual(reply, {
      type: 'reply',
      id: 1,
      error: "The Slack page in tab 59 failed call: Slack's Web API refused the call (HTTP 500)",
    })

    assert.deepEqual([handedOver('call').map(({ tabId }) => tabId), fetched.mock.callCount()], [[59], 1])
  })

  it('should download, and send an upload its bytes, in a tab whose relay has no query to give', async (context) => {
    // Arrange - the relay gives the upload ticket its query, then has none
    const tab = await startOnTab(context, 61)
    supplyBase64(context)
    const fetched = mockSlack(context, TICKET)
    const ticketRelay = tab.relay

    tab.relay = {
      answer: () => {
        tab.relay = relayWith(null)

        return ticketRelay?.answer() ?? Promise.resolve(null)
      },
    }

    // Act
    const upload = prepareUpload(tab, 1)
    await until(() => fetched.mock.callCount() === 1)
    await settled()
    await tick(context, GAP_MAX_MS)
    const uploaded = await upload
    const download = ask(3, 'slackDownload', { account: tab.account, url: FILE_URL })
    await until(() => handedOver('identity').length === 2)
    await settled()
    await tick(context, GAP_MAX_MS)

    // Assert
    assert.deepEqual(uploaded, { type: 'reply', id: 2, result: { ok: true, fileId: 'F0EXAMPLE1' } })
    assert.partialDeepStrictEqual(await download, { type: 'reply', id: 3, result: { byteLength: 2 } })
    assert.equal(browser.relayReads.length, 1)
  })
})

describe('[extension] Slack dispatch - the client query a call goes out with', () => {
  it("should send both of an upload's Web API calls with the relay's query", async (context) => {
    // Arrange
    const tab = await startOnTab(context, 71)
    supplyBase64(context)
    const fetched = mockSlack(context, TICKET)
    const upload = prepareUpload(tab, 1)
    await until(() => fetched.mock.callCount() === 1)
    await settled()
    await tick(context, GAP_MAX_MS)
    await upload

    // Act
    const finish = ask(3, 'slackUploadFinish', {
      account: tab.account,
      fileId: 'F0EXAMPLE1',
      title: 'notes.txt',
      channel: 'C0EXAMPLE1',
      threadTs: null,
      initialComment: null,
    })

    await until(() => browser.relayReads.length === 2)
    await settled()
    await tick(context, GAP_MAX_MS)
    await finish

    // Assert
    assert.deepEqual(
      sentCalls(fetched).map(({ method, versionTs }) => [method, versionTs]),
      [
        ['files.getUploadURLExternal', VERSION_A],
        ['files.completeUploadExternal', VERSION_A],
      ]
    )
  })

  it('should send the query read when the call was prepared, though a newer one came during the gap', async (context) => {
    // Arrange - a first call leaves a gap behind
    const tab = await startOnTab(context, 72)
    const fetched = mockSlack(context)
    await ask(1, 'slackCall', postMessageCall(tab))
    const deadline = NOW + 30_000

    // Act - the second call reads query A, then query B arrives while it waits out its gap
    const second = ask(2, 'slackCall', postMessageCall(tab), deadline)
    await until(() => browser.relayReads.length === 2)
    tab.relay = relayWith({ [API_ORIGIN]: clientQuery(tab.account, VERSION_B) })
    await tick(context, GAP_MAX_MS)
    await second
    const third = ask(3, 'slackCall', postMessageCall(tab))
    await until(() => browser.relayReads.length === 3)
    await tick(context, GAP_MAX_MS)
    await third

    // Assert
    const [, sentSecond, sentThird] = sentCalls(fetched)
    const [, handedSecond] = handedOver('call')
    assert.deepEqual([sentSecond?.versionTs, sentThird?.versionTs], [VERSION_A, VERSION_B])
    assert.ok(handedSecond !== undefined && handedSecond.at > (browser.relayReads[1]?.at ?? Number.POSITIVE_INFINITY))
    assert.equal(sentSecond?.requestId?.endsWith(`-${(handedSecond.at / 1000).toFixed(3)}`), true)
    assert.equal(deadlineOf(handedSecond), deadline)
  })
})

describe('[extension] Slack dispatch - tabs that change under a call', () => {
  it('should ask for a reload when the tab navigated between its identity read and its query read', async (context) => {
    // Arrange - the tab moves to a new document once its identity was read there
    const tab = await startOnTab(context, 81)
    const fetched = mockSlack(context)

    browser.runInPage = async (changed, command, run) => {
      const result = await run()
      if (command.kind === 'identity') {
        changed.documentId = 'DOC-81-NEXT'
      }

      return result
    }

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(tab))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, error: reloadMessage(tab.account, 'tab 81') })
    assert.deepEqual([handedOver('call'), fetched.mock.callCount()], [[], 0])
  })

  it('should run no command in the document a tab navigated to after its query read, nor try another tab', async (context) => {
    // Arrange - the relay answers, and the tab moves to a new document before the command goes in
    const first = slackTab(82)
    const second = slackTab(83, first.account)
    const answer = first.relay?.answer

    first.relay = {
      answer: async () => {
        const queries = await answer?.()
        first.documentId = 'DOC-82-NEXT'

        return queries
      },
    }

    await startWorker(context, [first, second])
    const fetched = mockSlack(context)

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(first))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, error: 'No document with id DOC-82 in tab with id 82' })
    assert.deepEqual([handedOver('call'), browser.relayReads.length, fetched.mock.callCount()], [[], 1, 0])
  })

  it('should send through the next tab of the account when the first changed account after its identity read', async (context) => {
    // Arrange - the first tab's page is signed in as another user by the time the call runs
    const first = slackTab(84)
    const second = slackTab(85, first.account)
    await startWorker(context, [first, second])
    const fetched = mockSlack(context)

    browser.runInPage = (changed, command, run) => {
      if (command.kind === 'call' && changed.id === 84) {
        changed.account = { ...changed.account, userId: 'U0SOMEONE2' }
      }

      return run()
    }

    // Act
    const reply = await ask(1, 'slackCall', postMessageCall(first))

    // Assert
    assert.deepEqual(reply, { type: 'reply', id: 1, result: { ok: true } })

    assert.deepEqual(
      handedOver('call').map(({ tabId, at }) => [tabId, at]),
      [
        [84, NOW],
        [85, NOW],
      ]
    )

    assert.equal(fetched.mock.callCount(), 1)
  })
})
