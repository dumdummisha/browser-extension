import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'
import type { FieldState, PageCommand, PageFind, PageOutcome, PointerState } from '../protocol/tab.js'

// The service worker's tab commands (extension/tab-commands.ts), driven through its native port as the relay drives
// them: the build's bundle of background.ts runs in a fake Chrome whose one tab answers each page command from a
// scripted page, so a test sees exactly what leaves the service worker for the raw page it read. The spec lives here,
// beside the modules the tests load, since the build replaces the compiled extension folder with its bundles.

type Listener = (...args: unknown[]) => unknown

interface IChromeEvent {
  readonly listeners: Listener[]
  readonly addListener: (listener: Listener) => void
}

// What the service worker hands chrome.scripting.executeScript: a page command, or the wait for a quiet page.
interface IInjection {
  readonly args: readonly [PageCommand] | readonly [number, number]
}

// The tab's page as its commands read it: the outline a snapshot answers, what find, field and pointer answer, and a
// message every command fails with while it is set.
interface IFakePage {
  documentId: string
  title: string
  url: string
  outline: string[]
  find: PageFind
  field: FieldState
  pointer: PointerState
  error: string | null
}

const TAB_ID = 21
const WINDOW_ID = 5
const DEADLINE = Date.now() + 3_600_000
const MAX_CHARS = 10_000

// Token-shaped samples are assembled at run time, so the repository holds nothing a secret scanner would flag.
const FIRST_TOKEN = ['xoxb', '1024', '2048', 'aBcDeFgHiJkLmNoP'].join('-')
const SECOND_TOKEN = ['xoxb', '1024', '2048', 'zYxWvUtSrQpOnMlK'].join('-')
const KEY_LINES = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7exampleBody'] as const
const ROTATED_KEY_LINES = ['MIIEpAIBAAKCAQEAwExampleRotated', 'c2Vjb25kLWV4YW1wbGUta2V5LWJvZHk='] as const
const BEGIN_KEY = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
const END_KEY = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
const SECRET_FRAGMENTS = [FIRST_TOKEN, SECOND_TOKEN, ...KEY_LINES, ...ROTATED_KEY_LINES, 'BEGIN', 'END']

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

const page: IFakePage = {
  documentId: 'DOC-1',
  title: 'Settings',
  url: 'https://app.example.test/settings',
  outline: [],
  find: { outline: [], sections: [], matches: [], isTruncated: false },
  field: {
    isFocused: true,
    focusedElement: 'nothing',
    content: { isMasked: false, value: '', revision: 0 },
    isMultiline: false,
  },
  pointer: { seq: 0, position: null, isOnTarget: false, under: 'nothing' },
  error: null,
}

const answerInPage = (command: PageCommand): PageOutcome => {
  if (page.error !== null) {
    return { isOk: false, error: page.error }
  }

  switch (command.method) {
    case 'snapshot':
      return {
        isOk: true,
        value: {
          documentId: page.documentId,
          title: page.title,
          url: page.url,
          scrollY: 0,
          scrollHeight: 800,
          viewportWidth: 1000,
          viewportHeight: 800,
          outline: page.outline.join('\n'),
          isTruncated: false,
        },
      }
    case 'find':
      return { isOk: true, value: page.find }
    case 'field':
      return { isOk: true, value: page.field }
    case 'pointer':
      return { isOk: true, value: page.pointer }
    case 'selectOption':
      return { isOk: true, value: { label: `Token ${FIRST_TOKEN}` } }
    case 'locate':
    case 'selectContent':
    case 'hasFocus':
      throw new Error(`The test does not answer ${command.method}`)
  }
}

const portMessages = chromeEvent()
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
  tabs: {
    query: () => Promise.resolve([]),
    get: () =>
      Promise.resolve({ id: TAB_ID, windowId: WINDOW_ID, title: page.title, url: page.url, status: 'complete' }),
    getZoom: () => Promise.resolve(1),
    onRemoved: chromeEvent(),
    onUpdated: chromeEvent(),
  },
  windows: {
    get: () => Promise.resolve({ left: 0, top: 0, width: 1200, height: 900 }),
    getAll: () =>
      Promise.resolve([
        {
          id: WINDOW_ID,
          focused: true,
          tabs: [{ id: TAB_ID, title: page.title, url: page.url, active: true }],
        },
      ]),
  },
  downloads: {
    search: () =>
      Promise.resolve([
        {
          url: `https://files.example.test/export?token=${FIRST_TOKEN}`,
          filename: `/Users/example/Downloads/keys-${FIRST_TOKEN}.csv`,
          state: 'complete',
          bytesReceived: 2048,
        },
      ]),
  },
  scripting: {
    executeScript: ({ args }: IInjection) => {
      const [command] = args

      return Promise.resolve([
        { documentId: page.documentId, frameId: 0, result: typeof command === 'number' ? null : answerInPage(command) },
      ])
    },
  },
  webRequest: {
    onBeforeRequest: chromeEvent(),
    onBeforeSendHeaders: chromeEvent(),
    onSendHeaders: chromeEvent(),
    onCompleted: chromeEvent(),
    onErrorOccurred: chromeEvent(),
  },
  alarms: { create: () => Promise.resolve(), onAlarm: chromeEvent() },
}

let nextId = 1

// Sends a request on the native port, as the relay does, and answers the reply the service worker sends back.
const ask = (method: string, params: unknown): Promise<unknown> => {
  const id = nextId
  nextId += 1
  const { promise, resolve } = Promise.withResolvers<unknown>()
  replies.set(id, resolve)
  emit(portMessages, { type: 'request', id, method, params, deadline: DEADLINE })

  return promise
}

const result = async (method: string, params: unknown): Promise<unknown> => {
  const reply = (await ask(method, params)) as { readonly result?: unknown; readonly error?: string }
  assert.equal(reply.error, undefined)

  return reply.result
}

const changes = (): Promise<unknown> =>
  result('changes', { tabId: TAB_ID, maxChars: MAX_CHARS, viewportMaxChars: MAX_CHARS })

const assertNoSecret = (answer: unknown): void => {
  const text = JSON.stringify(answer)
  for (const fragment of SECRET_FRAGMENTS) {
    assert.ok(!text.includes(fragment), `${fragment} left the service worker`)
  }
}

before(async () => {
  Object.defineProperty(globalThis, 'chrome', { value: fakeChrome, configurable: true })
  await import('../extension/background.js')
})

beforeEach(() => {
  Object.assign(page, {
    documentId: 'DOC-1',
    title: 'Settings',
    url: 'https://app.example.test/settings',
    outline: [],
    error: null,
  })
})

describe('[extension] Tab commands - reads', () => {
  it('should answer a snapshot with each credential span redacted and every other line and ref as read', async () => {
    // Arrange
    page.title = `Token ${FIRST_TOKEN} - Settings`
    page.url = `https://app.example.test/settings?token=${FIRST_TOKEN}&tab=keys`
    page.outline = [
      '## [1] Bot token',
      `[2] textbox "Bot token" value="${FIRST_TOKEN}" readonly`,
      BEGIN_KEY,
      ...KEY_LINES,
      END_KEY,
      '[3] button "Copy"',
    ]

    // Act
    const snapshot = await result('snapshot', { tabId: TAB_ID, scope: 'page', maxChars: MAX_CHARS })

    // Assert
    assert.deepEqual(snapshot, {
      documentId: 'DOC-1',
      title: 'Token [redacted] - Settings',
      url: 'https://app.example.test/settings?token=[redacted]&tab=keys',
      scrollY: 0,
      scrollHeight: 800,
      viewportWidth: 1000,
      viewportHeight: 800,
      outline:
        '## [1] Bot token\n[2] textbox "Bot token" value="[redacted]" readonly\n[redacted]\n\n\n\n[3] button "Copy"',
      isTruncated: false,
      tabId: TAB_ID,
    })
  })

  it('should answer search hits from outlines redacted whole, a key body line without its BEGIN included', async () => {
    // Arrange
    page.find = {
      outline: ['# [1] Keys', BEGIN_KEY, ...KEY_LINES, END_KEY, `Bot ${FIRST_TOKEN} active`],
      sections: [['## [5] Tokens', `[6] textbox "User" value="${SECOND_TOKEN}"`, '[7] button "Regenerate"', 'Rotated']],
      matches: [
        { kind: 'line', line: 2 },
        { kind: 'line', line: 5 },
        { kind: 'line', line: 0 },
        { kind: 'sectionLine', section: 0, line: 1 },
        { kind: 'sectionLine', section: 0, line: 2 },
        { kind: 'moreLines', count: 1 },
      ],
      isTruncated: true,
    }

    // Act
    const found = await result('find', { tabId: TAB_ID, query: 'a', maxChars: MAX_CHARS, sectionLines: 2 })

    // Assert
    assert.deepEqual(found, {
      matches: [
        '',
        'Bot [redacted] active',
        '# [1] Keys',
        '  [6] textbox "User" value="[redacted]"',
        '  [7] button "Regenerate"',
        '  ... and 1 more lines',
      ],
      isTruncated: true,
    })
    assertNoSecret(found)
  })

  it('should answer a search without hits with no matches', async () => {
    // Arrange
    page.find = { outline: [`Bot ${FIRST_TOKEN}`], sections: [], matches: [], isTruncated: false }

    // Act
    const found = await result('find', { tabId: TAB_ID, query: 'absent', maxChars: MAX_CHARS, sectionLines: 2 })

    // Assert
    assert.deepEqual(found, { matches: [], isTruncated: false })
  })

  it('should answer tabs, a field, the pointer and a picked option with their page text redacted', async () => {
    // Arrange
    page.title = `Token ${FIRST_TOKEN}`
    page.field = {
      isFocused: true,
      focusedElement: `<input#key> "${FIRST_TOKEN}"`,
      content: { isMasked: false, value: `key ${SECOND_TOKEN}`, revision: 4 },
      isMultiline: false,
    }
    page.pointer = {
      seq: 3,
      position: { clientX: 10, clientY: 20 },
      isOnTarget: false,
      under: `<code> "${FIRST_TOKEN}"`,
    }

    // Act
    const answers = [
      await result('listTabs', {}),
      await result('field', { tabId: TAB_ID, ref: 4 }),
      await result('pointer', { tabId: TAB_ID, ref: 4 }),
      await result('selectOption', { tabId: TAB_ID, ref: 4, option: 'Token' }),
    ]

    // Assert
    assert.deepEqual(answers, [
      [
        {
          windowId: WINDOW_ID,
          isFocused: true,
          tabs: [
            { tabId: TAB_ID, title: 'Token [redacted]', url: 'https://app.example.test/settings', isActive: true },
          ],
        },
      ],
      {
        isFocused: true,
        focusedElement: '<input#key> "[redacted]"',
        content: { isMasked: false, value: 'key [redacted]', revision: 4 },
        isMultiline: false,
      },
      { seq: 3, position: { clientX: 10, clientY: 20 }, isOnTarget: false, under: '<code> "[redacted]"' },
      { label: 'Token [redacted]' },
    ])
  })

  it('should answer a page command that fails with its message redacted', async () => {
    // Arrange
    page.error = `Element 4 has no option "Admin". Its options: Viewer | Token ${FIRST_TOKEN}`

    // Act
    const reply = await ask('selectOption', { tabId: TAB_ID, ref: 4, option: 'Admin' })

    // Assert
    assert.deepEqual(reply, {
      type: 'reply',
      id: nextId - 1,
      error: 'Element 4 has no option "Admin". Its options: Viewer | Token [redacted]',
    })
  })
})

describe('[extension] Tab commands - change reports', () => {
  it('should compare against the raw mark, so an unchanged token reports no change however often it is read', async () => {
    // Arrange
    page.outline = ['## [1] API', `Key ${FIRST_TOKEN}`, '[2] button "Copy"']
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })

    // Act
    const reports = [await changes(), await changes()]

    // Assert
    assert.deepEqual(reports, [
      { isNavigated: false, added: [], removed: [] },
      { isNavigated: false, added: [], removed: [] },
    ])
  })

  it('should report a token that changed although both read redacted the same', async () => {
    // Arrange
    page.outline = ['## [1] API', `Key ${FIRST_TOKEN}`, '[2] button "Regenerate"']
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })
    page.outline = ['## [1] API', `Key ${SECOND_TOKEN}`, '[2] button "Regenerate"']

    // Act
    const report = await changes()

    // Assert
    assert.deepEqual(report, { isNavigated: false, added: ['Key [redacted]'], removed: ['Key [redacted]'] })
  })

  it('should redact a rotated key body whose unchanged BEGIN line the report leaves out', async () => {
    // Arrange
    page.outline = ['## [1] Deploy key', BEGIN_KEY, ...KEY_LINES, END_KEY, '[2] button "Rotate"']
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })
    page.outline = ['## [1] Deploy key', BEGIN_KEY, ...ROTATED_KEY_LINES, END_KEY, '[2] button "Rotate"']

    // Act
    const report = await changes()

    // Assert
    assert.deepEqual(report, { isNavigated: false, added: ['', ''], removed: ['', ''] })
    assertNoSecret(report)
  })

  it('should count a URL that changed only in a token as a navigation', async () => {
    // Arrange
    page.url = `https://app.example.test/keys?token=${FIRST_TOKEN}`
    page.outline = ['## [1] Keys', '[2] button "Next"']
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })
    page.url = `https://app.example.test/keys?token=${SECOND_TOKEN}`

    // Act
    const report = await changes()

    // Assert
    assert.deepEqual(report, {
      isNavigated: true,
      snapshot: {
        documentId: 'DOC-1',
        title: 'Settings',
        url: 'https://app.example.test/keys?token=[redacted]',
        scrollY: 0,
        scrollHeight: 800,
        viewportWidth: 1000,
        viewportHeight: 800,
        outline: '',
        isTruncated: false,
      },
      repeatedLineCount: 2,
    })
  })

  it('should keep a navigated line that differs from the previous page only in its token', async () => {
    // Arrange
    page.outline = ['# [1] Example', `API key ${FIRST_TOKEN}`, '[2] button "Save"']
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })
    page.documentId = 'DOC-2'
    page.outline = ['# [1] Example', `API key ${SECOND_TOKEN}`, 'Saved.']

    // Act
    const report = (await changes()) as { readonly snapshot: { readonly outline: string }; repeatedLineCount: number }

    // Assert
    assert.deepEqual([report.snapshot.outline, report.repeatedLineCount], ['API key [redacted]\nSaved.', 1])
  })

  it('should redact a navigated key body whose BEGIN line the previous page also had', async () => {
    // Arrange
    page.outline = ['# [1] Example', BEGIN_KEY, ...KEY_LINES, END_KEY]
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })
    page.documentId = 'DOC-2'
    page.outline = ['# [1] Example', BEGIN_KEY, ...ROTATED_KEY_LINES, END_KEY, '[3] button "Close"']

    // Act
    const report = (await changes()) as { readonly snapshot: { readonly outline: string }; repeatedLineCount: number }

    // Assert
    assert.deepEqual([report.snapshot.outline, report.repeatedLineCount], ['\n\n\n[3] button "Close"', 2])
    assertNoSecret(report)
  })

  it('should answer a download the action started with its URL and file name redacted', async () => {
    // Arrange
    page.outline = ['## [1] Export']
    await result('mark', { tabId: TAB_ID, maxChars: MAX_CHARS })

    // Act
    const downloads = await result('downloads', { tabId: TAB_ID, timeoutMs: 0 })

    // Assert
    assert.deepEqual(downloads, [
      {
        url: 'https://files.example.test/export?token=[redacted]',
        filename: '/Users/example/Downloads/keys-[redacted].csv',
        state: 'complete',
        bytesReceived: 2048,
        error: null,
      },
    ])
  })
})
