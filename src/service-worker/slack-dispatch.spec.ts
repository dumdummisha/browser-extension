import assert from 'node:assert/strict'
import { before, describe, it, type Mock, type TestContext } from 'node:test'
import type { SlackPageCommand } from './slack-page.js'

// The service worker's Slack dispatch (extension/background.ts), driven through its native port as the relay drives
// it: the build's bundle of background.ts runs in a fake Chrome, whose Slack tab runs each command handed to it through
// the page function itself, against a page with made-up state and a mocked fetch. The spec lives here, beside the
// modules the tests load, since the build replaces the compiled extension folder with its bundles.

type Listener = (...args: unknown[]) => unknown

// A Chrome event: the listeners the service worker added, which the fake Chrome calls as Chrome would.
interface IChromeEvent {
  readonly listeners: Listener[]
  readonly addListener: (listener: Listener) => void
}

// What the service worker hands chrome.scripting.executeScript for a Slack page command.
interface IInjection {
  readonly target: { readonly tabId: number }
  readonly func: (command: SlackPageCommand) => Promise<unknown>
  readonly args: readonly [SlackPageCommand]
}

// A command handed to a page: the tab it went to, and the time on the clock when it was handed over.
interface IHandOver {
  readonly tabId: number
  readonly command: SlackPageCommand
  readonly at: number
}

// The fake Chrome's Slack tabs, every command handed to a page, and how the page runs one: through run, the page
// function itself, at once unless a test holds it or loses its result.
interface IFakeBrowser {
  tabs: { readonly id: number; readonly url: string }[]
  handOvers: IHandOver[]
  runInPage: (command: SlackPageCommand, run: () => Promise<unknown>) => Promise<unknown>
}

interface ISlackTab {
  readonly tabId: number
  readonly account: { readonly teamId: string; readonly userId: string }
}

const SLACK_ORIGIN = 'https://app.slack.com'
const API_ORIGIN = 'https://example.slack.com'
const UPLOAD_URL = 'https://files.slack.com/upload/v1/example-grant'
const UPLOAD_ID = '00000000-0000-4000-8000-000000000001'
const NOTES = 'made-up notes'
const NOW = 1_794_900_000_000
const DEADLINE = NOW + 60_000
// The gap the pace draws lies in this range (slack-pace.ts).
const GAP_MIN_MS = 500
const GAP_MAX_MS = 2_000
const GAVE_UP = 'The caller gave up on the request before it was sent, so it was not sent'

const chromeEvent = (): IChromeEvent => {
  const listeners: Listener[] = []

  return {
    listeners,
    addListener: (listener) => {
      listeners.push(listener)
    },
  }
}

const emit = (event: IChromeEvent, ...args: unknown[]): void => {
  for (const listener of event.listeners) {
    listener(...args)
  }
}

const documentOf = (tabId: number): string => `DOC-${tabId}`

const runAtOnce: IFakeBrowser['runInPage'] = (_command, run) => run()

const browser: IFakeBrowser = { tabs: [], handOvers: [], runInPage: runAtOnce }
const portMessages = chromeEvent()
const requestsStarted = chromeEvent()
const replies = new Map<number, (reply: unknown) => void>()

const fakeChrome = {
  runtime: {
    connectNative: () => ({
      onMessage: portMessages,
      onDisconnect: chromeEvent(),
      postMessage: (reply: { readonly id: number }) => replies.get(reply.id)?.(reply),
    }),
    onMessage: chromeEvent(),
  },
  tabs: { query: () => Promise.resolve(browser.tabs), onRemoved: chromeEvent(), onUpdated: chromeEvent() },
  scripting: {
    executeScript: async ({ target, func, args: [command] }: IInjection) => {
      browser.handOvers.push({ tabId: target.tabId, command, at: Date.now() })
      const result = await browser.runInPage(command, () => func(command))

      return [{ documentId: documentOf(target.tabId), frameId: 0, result }]
    },
  },
  webRequest: {
    onBeforeRequest: requestsStarted,
    onBeforeSendHeaders: chromeEvent(),
    onSendHeaders: chromeEvent(),
    onCompleted: chromeEvent(),
    onErrorOccurred: chromeEvent(),
  },
  alarms: { create: () => Promise.resolve(), onAlarm: chromeEvent() },
}

// Sends a request on the native port, as the relay does, and answers the reply the service worker sends back.
const ask = (id: number, method: string, params: unknown, deadline = DEADLINE): Promise<unknown> => {
  const { promise, resolve } = Promise.withResolvers<unknown>()
  replies.set(id, resolve)
  emit(portMessages, { type: 'request', id, method, params, deadline })

  return promise
}

const cancel = (id: number): void => {
  emit(portMessages, { type: 'cancel', id })
}

const handedOver = (kind: SlackPageCommand['kind']): IHandOver[] =>
  browser.handOvers.filter(({ command }) => command.kind === kind)

const deadlineOf = (handOver: IHandOver | undefined): number | null =>
  handOver === undefined || handOver.command.kind === 'identity' ? null : handOver.command.deadline

// Lets the promises that can move on do so; setImmediate is not one of the mocked timers.
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const until = async (condition: () => boolean): Promise<void> => {
  for (let step = 0; step < 50 && !condition(); step += 1) {
    await settled()
  }

  assert.ok(condition(), 'The service worker never got there')
}

const tick = async (context: TestContext, ms: number): Promise<void> => {
  context.mock.timers.tick(ms)
  await settled()
}

// An open Slack tab signed in as a workspace of its own, so no test waits on another's gap, whose page's client has
// made a Web API call the transport borrows its query from. The clock stands at NOW.
const openSlackTab = (context: TestContext, tabId: number): ISlackTab => {
  const account = { teamId: `T0DISPATCH${tabId}`, userId: 'U0EXAMPLE1' }
  const saved = { name: 'Example', user_id: account.userId, token: 'xoxc-0000-made-up-token', url: `${API_ORIGIN}/` }
  const page = {
    location: { pathname: `/client/${account.teamId}/C0EXAMPLE1` },
    localStorage: { getItem: () => JSON.stringify({ teams: { [account.teamId]: saved } }) },
  }
  const descriptors = Object.keys(page).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  )
  for (const [name, value] of Object.entries(page)) {
    Object.defineProperty(globalThis, name, { value, configurable: true })
  }

  context.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, name)
      } else {
        Object.defineProperty(globalThis, name, descriptor)
      }
    }
  })
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
  browser.tabs = [{ id: tabId, url: `${SLACK_ORIGIN}/client/${account.teamId}` }]
  browser.handOvers = []
  browser.runInPage = runAtOnce
  emit(requestsStarted, {
    requestId: `client-${tabId}`,
    tabId,
    frameId: 0,
    documentId: documentOf(tabId),
    initiator: SLACK_ORIGIN,
    method: 'POST',
    type: 'xmlhttprequest',
    timeStamp: NOW,
    url: `${API_ORIGIN}/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=${account.teamId}&_x_num_retries=0`,
  })

  return { tabId, account }
}

// Slack's Web API answers every call with answer, and the upload URL takes the bytes.
const mockSlack = (context: TestContext, answer: object = { ok: true }): Mock<typeof fetch> =>
  context.mock.method(globalThis, 'fetch', (input: Parameters<typeof fetch>[0]) =>
    Promise.resolve(String(input).startsWith(API_ORIGIN) ? Response.json(answer) : new Response('OK'))
  )

// Chrome (from 140, the manifest's minimum) decodes base64 with Uint8Array.fromBase64, which Node 24 lacks; the
// service worker and the page get it for the test, from Buffer.
const decodeBase64 = (context: TestContext): void => {
  Object.defineProperty(Uint8Array, 'fromBase64', {
    value: (text: string) => new Uint8Array(Buffer.from(text, 'base64')),
    configurable: true,
  })
  context.after(() => Reflect.deleteProperty(Uint8Array, 'fromBase64'))
}

const postMessageCall = ({ account }: ISlackTab): unknown => ({
  account,
  method: 'chat.postMessage',
  params: { channel: 'C0EXAMPLE1', text: 'a made-up message' },
})

// Pushes the file's one chunk, then asks for it to be uploaded.
const prepareUpload = async ({ account }: ISlackTab, id: number): Promise<unknown> => {
  await ask(id, 'slackUploadChunk', { uploadId: UPLOAD_ID, index: 0, data: Buffer.from(NOTES).toString('base64') })

  return ask(id + 1, 'slackUploadPrepare', {
    account,
    uploadId: UPLOAD_ID,
    filename: 'notes.txt',
    byteLength: NOTES.length,
  })
}

const TICKET = { ok: true, upload_url: UPLOAD_URL, file_id: 'F0EXAMPLE1' }

// Holds the page's run of each command isHeld picks until the returned function releases them.
const holdInPage = (isHeld: (command: SlackPageCommand) => boolean): (() => void) => {
  const held = Promise.withResolvers<undefined>()
  browser.runInPage = async (command, run) => {
    if (isHeld(command)) {
      await held.promise
    }

    return run()
  }

  return () => held.resolve(undefined)
}

before(async () => {
  Object.defineProperty(globalThis, 'chrome', { value: fakeChrome, configurable: true })
  await import('../extension/background.js')
})

describe('[extension] Slack dispatch - callers that gave up', () => {
  it('should hand no command to the page when the caller cancels while its signed-in page is being found', async (context) => {
    // Arrange
    const tab = openSlackTab(context, 11)
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
    const tab = openSlackTab(context, 12)
    decodeBase64(context)
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
    const tab = openSlackTab(context, 13)
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
})

describe('[extension] Slack dispatch - deadlines', () => {
  it('should send nothing of a command handed over before its deadline that the page runs after it', async (context) => {
    // Arrange
    const tab = openSlackTab(context, 21)
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
    const tab = openSlackTab(context, 22)
    decodeBase64(context)
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
      runInPage: async (command: SlackPageCommand, run: () => Promise<unknown>): Promise<unknown> => {
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
      const tab = openSlackTab(context, outcome.tabId)
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
