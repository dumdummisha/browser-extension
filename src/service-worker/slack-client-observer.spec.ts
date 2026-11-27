import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { borrowedQueryOf, borrowedQueryString } from './borrowed-query.js'
import { type IStartedRequest, SlackClientObserver } from './slack-client-observer.js'
import { type IRequestHeader } from './slack-request-shape.js'

const SLACK_ORIGIN = 'https://app.slack.com'
const PAGE = { tabId: 7, documentId: 'DOC-A' }
const OTHER_PAGE = { tabId: 8, documentId: 'DOC-B' }
const API_ORIGIN = 'https://example.slack.com'
const MISHA_ID = 'a1b2c3d4-1794900001.200'
const FILE_URL = 'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt'
// Made-up credentials and content, which must never reach what the observer keeps or reports.
const TOKEN = 'xoxc-0000-made-up-token'
const COOKIE = 'd=xoxd-0000-made-up-cookie; d-s=1794800000'
const MESSAGE = 'a made-up private message'
const SECRETS = [TOKEN, COOKIE, MESSAGE]

// The headers Chrome reports a fetch from Slack's page sent with, as a recorded client request, with made-up values.
const HEADERS: readonly IRequestHeader[] = [
  { name: 'Accept', value: '*/*' },
  { name: 'Accept-Language', value: 'en-US,en;q=0.9' },
  { name: 'Content-Type', value: 'multipart/form-data; boundary=----WebKitFormBoundaryMADEUP0000' },
  { name: 'Cookie', value: COOKIE },
  { name: 'Origin', value: SLACK_ORIGIN },
  { name: 'Referer', value: `${SLACK_ORIGIN}/` },
  { name: 'Sec-Fetch-Mode', value: 'cors' },
  { name: 'User-Agent', value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Example/140.0' },
]

// A chat.postMessage of the client: its query, and a body with the token, the call's arguments and the client's own
// fields, a reason among them.
const clientPost = (requestId: string, request: Partial<IStartedRequest> = {}): IStartedRequest => ({
  requestId,
  ...PAGE,
  frameId: 0,
  initiator: SLACK_ORIGIN,
  method: 'POST',
  url: `${API_ORIGIN}/api/chat.postMessage?_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_num_retries=0`,
  requestBody: {
    formData: {
      channel: ['C0EXAMPLE1'],
      blocks: [JSON.stringify([{ type: 'rich_text', text: MESSAGE }])],
      token: [TOKEN],
      _x_reason: ['webapp_message_send'],
      _x_mode: ['online'],
      _x_sonic: ['true'],
      _x_app_name: ['client'],
    },
  },
  ...request,
})

// Misha's chat.postMessage: another request id and other arguments, no reason.
const mishaPost = (requestId: string, request: Partial<IStartedRequest> = {}): IStartedRequest =>
  clientPost(requestId, {
    url: `${API_ORIGIN}/api/chat.postMessage?_x_id=${MISHA_ID}&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_num_retries=0`,
    requestBody: {
      formData: {
        channel: ['D0EXAMPLE1'],
        text: [MESSAGE],
        token: [TOKEN],
        _x_mode: ['online'],
        _x_sonic: ['true'],
        _x_app_name: ['client'],
      },
    },
    ...request,
  })

// What a command of Misha's tells the observer its request is known by: a Web API call's fresh request id, which only
// its request carries, or a file's address, which the client may fetch too.
interface IMishaKey {
  readonly key: string
  readonly isKeyUnique: boolean
}

const MISHA_CALL: IMishaKey = { key: MISHA_ID, isKeyUnique: true }
const MISHA_FILE: IMishaKey = { key: FILE_URL, isKeyUnique: false }

const fileGet = (requestId: string, url = FILE_URL): IStartedRequest => ({
  requestId,
  ...PAGE,
  frameId: 0,
  initiator: SLACK_ORIGIN,
  method: 'GET',
  url,
})

interface IObserved {
  readonly observer: SlackClientObserver
  readonly changes: () => number
}

const observe = (): IObserved => {
  let changes = 0

  const observer = new SlackClientObserver(SLACK_ORIGIN, () => {
    changes += 1
  })

  return { observer, changes: () => changes }
}

const sent = (observer: SlackClientObserver, request: IStartedRequest, headers = HEADERS): void => {
  observer.requestStarted(request)
  observer.headersSent({ requestId: request.requestId, requestHeaders: headers })
}

// A command of Misha's in a page: its request carries the key, and the command settles once it was sent.
const mishaSent = (
  observer: SlackClientObserver,
  request: IStartedRequest,
  { key, isKeyUnique }: IMishaKey,
  isAnswered = true
): void => {
  const release = observer.exclude({ tabId: request.tabId, documentId: request.documentId ?? '' }, key, isKeyUnique)
  sent(observer, request)
  release(isAnswered)
}

describe('[service-worker] Slack client observer - transport check', () => {
  it("should report an operation unchecked until the client sends it, then check Misha's first request once", () => {
    // Arrange
    const { observer, changes } = observe()
    mishaSent(observer, mishaPost('misha-1'), MISHA_CALL)
    const unchecked = observer.parity()

    // Act
    sent(observer, clientPost('client-1'))
    const checked = observer.parity()

    mishaSent(
      observer,
      mishaPost('misha-2', { url: `${API_ORIGIN}/api/chat.postMessage?_x_id=b2c3d4e5-1794900004.000` }),
      { key: 'b2c3d4e5-1794900004.000', isKeyUnique: true }
    )

    // Assert
    assert.deepEqual(unchecked, [{ operation: 'chat.postMessage', state: 'unchecked' }])
    assert.deepEqual(checked, [{ operation: 'chat.postMessage', state: 'matches' }])
    assert.deepEqual([observer.parity(), changes()], [checked, 2])
  })

  it('should match when only excluded fields differ: ids, reasons, tokens, cookies, boundaries and arguments', () => {
    // Arrange
    const { observer } = observe()

    const mishaHeaders = HEADERS.map((header) =>
      header.name === 'Content-Type' ? { ...header, value: 'multipart/form-data; boundary=----MishaBoundary' } : header
    )

    sent(observer, clientPost('client-1'))

    // Act
    const release = observer.exclude(PAGE, MISHA_ID, true)
    sent(observer, mishaPost('misha-1'), mishaHeaders)
    release(true)

    // Assert
    const parity = observer.parity()
    assert.deepEqual(parity, [{ operation: 'chat.postMessage', state: 'matches' }])
    assert.ok(SECRETS.every((secret) => !JSON.stringify(parity).includes(secret)))
  })

  it('should report how the envelope differs by names only: method, headers, query fields and body values', () => {
    // Arrange
    const { observer } = observe()
    sent(observer, clientPost('client-1'))

    const mishaHeaders = [
      ...HEADERS.filter(({ name }) => name !== 'Accept-Language' && name !== 'User-Agent'),
      { name: 'User-Agent', value: 'Mozilla/5.0 Other/1.0' },
      { name: 'X-Made-Up', value: TOKEN },
    ]

    const misha = mishaPost('misha-1', {
      method: 'PUT',
      url: `${API_ORIGIN}/api/chat.postMessage?_x_id=${MISHA_ID}&slack_route=T0EXAMPLE1&fp=7a`,
      requestBody: { formData: { token: [TOKEN], _x_mode: ['offline'], _x_sonic: ['true'], _x_extra: [MESSAGE] } },
    })

    // Act
    const release = observer.exclude(PAGE, MISHA_ID, true)
    sent(observer, misha, mishaHeaders)
    release(true)

    // Assert
    const parity = observer.parity()

    assert.deepEqual(parity, [
      {
        operation: 'chat.postMessage',
        state: 'differs',
        differences: [
          { part: 'request', name: 'method', kind: 'value' },
          { part: 'header', name: 'accept-language', kind: 'missing' },
          { part: 'header', name: 'user-agent', kind: 'value' },
          { part: 'header', name: 'x-made-up', kind: 'extra' },
          { part: 'query', name: '_x_csid', kind: 'missing' },
          { part: 'query', name: '_x_num_retries', kind: 'missing' },
          { part: 'query', name: 'fp', kind: 'extra' },
          { part: 'body', name: '_x_app_name', kind: 'missing' },
          { part: 'body', name: '_x_extra', kind: 'extra' },
          { part: 'body', name: '_x_mode', kind: 'value' },
        ],
      },
    ])

    assert.ok([...SECRETS, 'offline', 'Other/1.0'].every((value) => !JSON.stringify(parity).includes(value)))
  })

  it('should never name a field whose name is shaped like a secret', () => {
    // Arrange
    const { observer } = observe()
    const secretName = 'xoxp-1111-made-up-name'

    sent(observer, clientPost('client-1', { url: `${clientPost('').url}&${secretName}=1` }), [
      ...HEADERS,
      { name: secretName, value: '1' },
    ])

    // Act
    mishaSent(observer, mishaPost('misha-1'), MISHA_CALL)

    // Assert
    const parity = observer.parity()
    assert.deepEqual(parity, [{ operation: 'chat.postMessage', state: 'matches' }])
    assert.ok(!JSON.stringify(parity).includes(secretName))
  })

  it('should keep and emit no name holding a secret glued to a prefix or a suffix or lower-cased, nor such a value', () => {
    // Arrange
    const { observer } = observe()
    const awsKey = 'AKIAABCDEFGHIJKLMNOP'
    // A Google API key's shape, built here so the source holds no literal of one; lower-casing changes its prefix.
    const googleKey = `AIza${'a'.repeat(35)}`
    const glued = [`_x_${TOKEN}`, `_x_${awsKey}_suffix`]

    const client = clientPost('client-1', {
      url: `${clientPost('').url}&${glued.map((name) => `${name}=1`).join('&')}&_x_frontend_build_type=${awsKey.toLowerCase()}_x`,
      requestBody: {
        formData: {
          ...Object.fromEntries(glued.map((name) => [name, ['1']])),
          _x_mode: ['online'],
          _x_sonic: ['true'],
          _x_app_name: ['client'],
        },
      },
    })

    sent(observer, client, [
      ...HEADERS.filter(({ name }) => name !== 'Content-Type'),
      { name: 'Content-Type', value: `application/${googleKey}` },
      { name: googleKey.toLowerCase(), value: '1' },
    ])

    // Act
    mishaSent(observer, mishaPost('misha-1'), MISHA_CALL)

    // Assert
    const kept = JSON.stringify(observer.parity()).toLowerCase()
    assert.ok([TOKEN, 'akiaabcd', 'aizaaaaa'].every((secret) => !kept.includes(secret)))

    assert.deepEqual(observer.parity(), [
      {
        operation: 'chat.postMessage',
        state: 'differs',
        differences: [
          { part: 'header', name: 'content-type', kind: 'value' },
          { part: 'query', name: '_x_frontend_build_type', kind: 'missing' },
        ],
      },
    ])
  })

  it("should never take Misha's request as the client's reference, in its page, while its command runs", () => {
    // Arrange
    const { observer } = observe()
    mishaSent(observer, mishaPost('misha-1'), MISHA_CALL)

    // Act
    sent(observer, mishaPost('client-elsewhere', OTHER_PAGE))

    // Assert
    assert.deepEqual(observer.parity(), [{ operation: 'chat.postMessage', state: 'matches' }])
  })

  it("should keep a request Misha's until it ends, though its command settled first", () => {
    // Arrange
    const { observer } = observe()
    sent(observer, clientPost('client-1'))
    const release = observer.exclude(PAGE, MISHA_ID, true)
    observer.requestStarted(mishaPost('misha-1'))

    // Act
    release(true)
    const beforeHeaders = observer.parity()
    observer.headersSent({ requestId: 'misha-1', requestHeaders: HEADERS })

    // Assert
    assert.deepEqual([beforeHeaders, observer.parity()], [[], [{ operation: 'chat.postMessage', state: 'matches' }]])
  })

  it('should take nothing from a request that ended before its headers, or a download Slack did not answer', () => {
    // Arrange
    const { observer } = observe()
    const failed = observer.exclude(PAGE, MISHA_ID, true)
    observer.requestStarted(mishaPost('misha-1'))
    observer.requestEnded('misha-1')
    failed(true)

    // Act
    mishaSent(observer, fileGet('misha-2'), MISHA_FILE, false)

    // Assert
    assert.deepEqual(observer.parity(), [])
  })

  it('should check a Web API call that sent its headers whatever Slack answered, a refusal or no answer included', () => {
    // Arrange
    const { observer } = observe()
    mishaSent(observer, mishaPost('misha-1'), MISHA_CALL, false)
    const unanswered = observer.parity()

    // Act
    sent(observer, clientPost('client-1'))

    // Assert
    assert.deepEqual(
      [unanswered, observer.parity()],
      [[{ operation: 'chat.postMessage', state: 'unchecked' }], [{ operation: 'chat.postMessage', state: 'matches' }]]
    )
  })

  it("should match a call of Misha's built from the query a client call with a focus field and a next build lent", () => {
    // Arrange
    const { observer } = observe()

    const clientQuery =
      '_x_gantry=true&_x_desktop_ia=4&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_foreground=true&_x_frontend_build_type=next-0a1b2c3d&fp=7a'

    const clientUrl = `${API_ORIGIN}/api/conversations.history?_x_id=0f1e2d3c-1794900000.100&${clientQuery}&_x_num_retries=0`
    sent(observer, clientPost('client-1', { url: clientUrl }))
    const borrowed = borrowedQueryOf(new URL(clientUrl))
    assert.ok(borrowed !== null)

    // Act
    mishaSent(
      observer,
      mishaPost('misha-1', {
        url: `${API_ORIGIN}/api/conversations.history?${borrowedQueryString(borrowed, MISHA_ID)}`,
      }),
      MISHA_CALL
    )

    // Assert
    assert.deepEqual(observer.parity(), [{ operation: 'conversations.history', state: 'matches' }])
  })

  it('should name both focus fields when the reference carries one and the borrowed query the other', () => {
    // Arrange
    const { observer } = observe()

    sent(
      observer,
      clientPost('client-1', {
        url: `${API_ORIGIN}/api/conversations.history?_x_id=0f1e2d3c-1794900000.100&slack_route=T0EXAMPLE1&_x_foreground=true`,
      })
    )

    const lendingUrl = `${API_ORIGIN}/api/client.counts?_x_id=2b3c4d5e-1794900003.000&slack_route=T0EXAMPLE1&_x_background=true`
    sent(observer, clientPost('client-2', { url: lendingUrl }))
    const borrowed = borrowedQueryOf(new URL(lendingUrl))
    assert.ok(borrowed !== null)

    // Act
    mishaSent(
      observer,
      mishaPost('misha-1', {
        url: `${API_ORIGIN}/api/conversations.history?${borrowedQueryString(borrowed, MISHA_ID)}`,
      }),
      MISHA_CALL
    )

    // Assert
    assert.deepEqual(observer.parity(), [
      {
        operation: 'conversations.history',
        state: 'differs',
        differences: [
          { part: 'query', name: '_x_background', kind: 'extra' },
          { part: 'query', name: '_x_foreground', kind: 'missing' },
        ],
      },
    ])
  })
})

describe('[service-worker] Slack client observer - same-address collisions', () => {
  it("should take no shape and no reference when the client fetched the file first while Misha's download ran", () => {
    // Arrange
    const { observer } = observe()
    const release = observer.exclude(PAGE, FILE_URL, false)

    // Act
    sent(observer, fileGet('client-1'))
    sent(observer, fileGet('misha-1'))
    release(true)
    const afterCollision = observer.parity()
    mishaSent(observer, fileGet('misha-2'), MISHA_FILE)

    // Assert
    assert.deepEqual([afterCollision, observer.parity()], [[], [{ operation: 'download', state: 'unchecked' }]])
  })

  it("should take no shape when only the client fetched the file while Misha's download did not reach Slack", () => {
    // Arrange
    const { observer } = observe()
    const release = observer.exclude(PAGE, FILE_URL, false)

    // Act
    sent(observer, fileGet('client-1'))
    release(false)
    mishaSent(observer, fileGet('misha-2'), MISHA_FILE)

    // Assert
    assert.deepEqual(observer.parity(), [{ operation: 'download', state: 'unchecked' }])
  })

  it("should compare a download with the client's by its headers, never by its address", () => {
    // Arrange
    const { observer } = observe()

    sent(
      observer,
      fileGet('client-1', 'https://files.slack.com/files-pri/T0EXAMPLE1-F0OTHER001/other.png?t=xoxe-0000-made-up')
    )

    // Act
    mishaSent(observer, fileGet('misha-1'), MISHA_FILE)

    // Assert
    const parity = observer.parity()
    assert.deepEqual(parity, [{ operation: 'download', state: 'matches' }])
    assert.ok(!JSON.stringify(parity).includes('xoxe-'))
  })
})

describe('[service-worker] Slack client observer - requests that send no headers', () => {
  const orders = [
    ['the request without headers first', ['client-1', 'misha-1']],
    ['the request with headers first', ['misha-1', 'client-1']],
  ] as const

  for (const [order, [first, second]] of orders) {
    it(`should take no shape and no reference when two requests carried the key and one sent no headers, ${order}`, () => {
      // Arrange
      const { observer } = observe()
      const release = observer.exclude(PAGE, FILE_URL, false)
      observer.requestStarted(fileGet(first))
      observer.requestStarted(fileGet(second))

      // Act
      observer.headersSent({ requestId: 'misha-1', requestHeaders: HEADERS })
      observer.requestEnded('client-1')
      release(true)
      const afterCollision = observer.parity()
      mishaSent(observer, fileGet('misha-2'), MISHA_FILE)

      // Assert
      assert.deepEqual([afterCollision, observer.parity()], [[], [{ operation: 'download', state: 'unchecked' }]])
    })
  }
})

describe('[service-worker] Slack client observer - bodies it cannot read', () => {
  it('should leave an operation unchecked, never matching, when a body came as raw bytes, keeping none of it', () => {
    // Arrange
    const { observer } = observe()
    const raw = { raw: [{ bytes: new TextEncoder().encode(`token=${TOKEN}&text=${MESSAGE}&_x_mode=offline`).buffer }] }
    sent(observer, clientPost('client-1', { requestBody: raw }))

    // Act
    mishaSent(observer, mishaPost('misha-1'), MISHA_CALL)

    // Assert
    const parity = observer.parity()
    assert.deepEqual(parity, [{ operation: 'chat.postMessage', state: 'unchecked' }])
    assert.ok([...SECRETS, 'offline'].every((secret) => !JSON.stringify(parity).includes(secret)))
  })

  it('should still report the differences of the parts it could read', () => {
    // Arrange
    const { observer } = observe()
    sent(observer, clientPost('client-1', { requestBody: { raw: [] } }))

    // Act
    const release = observer.exclude(PAGE, MISHA_ID, true)

    sent(
      observer,
      mishaPost('misha-1'),
      HEADERS.filter(({ name }) => name !== 'Accept')
    )

    release(true)

    // Assert
    assert.deepEqual(observer.parity(), [
      {
        operation: 'chat.postMessage',
        state: 'differs',
        differences: [{ part: 'header', name: 'accept', kind: 'missing' }],
      },
    ])
  })
})
