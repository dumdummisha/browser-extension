import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  borrowedQueryOf,
  borrowedQueryString,
  differencesOf,
  freshRequestId,
  headerFieldsOf,
  type IRequestShape,
  operationOf,
  requestKeyOf,
  startedShapeOf,
} from './slack-request-shape.js'

// A Web API call of Slack's client, as webRequest reports it, with made-up values: client.counts, a method the
// transport never calls itself.
const CLIENT_COUNTS =
  'https://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_frontend_build_type=current&_x_desktop_ia=4&_x_gantry=true&fp=7a&_x_num_retries=2'

describe('[service-worker] Slack request shape - borrowed query', () => {
  it("should borrow the transport fields of any client Web API call, client.counts included, in the client's order", () => {
    // Act
    const borrowed = borrowedQueryOf(new URL(CLIENT_COUNTS))

    // Assert
    assert.deepEqual(borrowed, [
      ['_x_id', null],
      ['_x_csid', 'example-csid'],
      ['slack_route', 'T0EXAMPLE1'],
      ['_x_version_ts', '1794800000'],
      ['_x_frontend_build_type', 'current'],
      ['_x_desktop_ia', '4'],
      ['_x_gantry', 'true'],
      ['fp', '7a'],
      ['_x_num_retries', null],
    ])
  })

  it('should borrow no value outside the transport fields and their forms: payloads, reasons, tokens, secret-shaped keys', () => {
    // Arrange
    const secrets = ['confidential sentence', 'message-pane/requestHistory', 'xoxc-0000-made-up', 'xoxp-1111-made-up']
    const url = new URL(
      'https://example.slack.com/api/search.messages?_x_id=0f1e2d3c-1794900000.100&slack_route=T0EXAMPLE1'
    )
    url.searchParams.append('query', 'confidential sentence')
    url.searchParams.append('_x_reason', 'message-pane/requestHistory')
    url.searchParams.append('token', 'xoxc-0000-made-up')
    url.searchParams.append('xoxp-1111-made-up', '1')
    url.searchParams.append('_x_csid', 'not a session id')
    url.searchParams.append('fp', 'xoxc-0000-made-up')

    // Act
    const borrowed = borrowedQueryOf(url)

    // Assert
    assert.deepEqual(borrowed, [
      ['_x_id', null],
      ['slack_route', 'T0EXAMPLE1'],
    ])
    assert.ok(secrets.every((secret) => !JSON.stringify(borrowed).includes(secret)))
  })

  it('should borrow nothing from a request that is no Web API call of the client', () => {
    // Arrange
    const urls = [
      'https://example.slack.com/api/client.counts?slack_route=T0EXAMPLE1',
      'https://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100',
      'https://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100&slack_route=t0%20example',
      'https://example.slack.com/client.counts?_x_id=0f1e2d3c-1794900000.100&slack_route=T0EXAMPLE1',
      'http://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100&slack_route=T0EXAMPLE1',
      'https://example.slack.com.attacker.example/api/client.counts?_x_id=0&slack_route=T0EXAMPLE1',
      'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt?_x_id=0&slack_route=T0EXAMPLE1',
    ]

    // Act
    const borrowed = urls.map((url) => borrowedQueryOf(new URL(url)))

    // Assert
    assert.deepEqual(
      borrowed,
      urls.map(() => null)
    )
  })

  it("should fill the request's own fields: a fresh id, and a first attempt only where the client sent an attempt", () => {
    // Arrange
    const withRetries = borrowedQueryOf(new URL(CLIENT_COUNTS)) ?? []
    const withoutRetries = withRetries.filter(([name]) => name !== '_x_num_retries')

    // Act
    const queries = [withRetries, withoutRetries].map((query) => borrowedQueryString(query, 'a1b2c3d4-1794900001.200'))

    // Assert
    assert.deepEqual(queries, [
      '_x_id=a1b2c3d4-1794900001.200&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_frontend_build_type=current&_x_desktop_ia=4&_x_gantry=true&fp=7a&_x_num_retries=0',
      '_x_id=a1b2c3d4-1794900001.200&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_frontend_build_type=current&_x_desktop_ia=4&_x_gantry=true&fp=7a',
    ])
  })

  it("should give request ids in the form Slack's client gives its own", () => {
    // Act
    const requestId = freshRequestId()

    // Assert
    assert.match(requestId, /^[\da-f]{8}-\d+\.\d{3}$/u)
  })
})

describe('[service-worker] Slack request shape - request keys', () => {
  it('should know a Web API call by its request id, a private file or upload by its address, and nothing else', () => {
    // Arrange
    const urls = [
      CLIENT_COUNTS,
      'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt',
      'https://files.slack.com/upload/v1/example-grant',
      'https://example.slack.com/api/client.counts',
      'https://edge.example.com/cache/T0EXAMPLE1/users/info',
    ]

    // Act
    const keys = urls.map((url) => requestKeyOf(new URL(url)))

    // Assert
    assert.deepEqual(keys, [
      '0f1e2d3c-1794900000.100',
      'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt',
      'https://files.slack.com/upload/v1/example-grant',
      null,
      null,
    ])
  })
})

describe('[service-worker] Slack request shape - operations', () => {
  it('should know the Web API methods the transport calls, both upload stages, downloads and upload bytes, and nothing else', () => {
    // Arrange
    const requests: readonly (readonly [string, string])[] = [
      ['POST', 'https://example.slack.com/api/chat.postMessage'],
      ['POST', 'https://example.enterprise.slack.com/api/files.getUploadURLExternal'],
      ['POST', 'https://example.slack.com/api/files.completeUploadExternal'],
      ['POST', 'https://example.slack.com/api/client.counts'],
      ['GET', 'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt'],
      ['POST', 'https://files.slack.com/upload/v1/example-grant'],
      ['GET', 'https://files.slack.com/upload/v1/example-grant'],
      ['POST', 'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt'],
      ['GET', 'https://slack.example.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt'],
    ]

    // Act
    const operations = requests.map(([method, url]) => operationOf(method, new URL(url)))

    // Assert
    assert.deepEqual(operations, [
      'chat.postMessage',
      'files.getUploadURLExternal',
      'files.completeUploadExternal',
      null,
      'download',
      'upload',
      null,
      null,
      null,
    ])
  })
})

describe('[service-worker] Slack request shape - what the check keeps', () => {
  const TOKEN = 'xoxc-0000-made-up-token'
  const MESSAGE = 'a made-up private message'

  it("should keep a Web API call's query names and the client's own body fields, with only the listed values", () => {
    // Arrange
    const url = new URL(
      'https://example.slack.com/api/chat.postMessage?_x_id=0f1e2d3c-1794900000.100&_x_reason=send&slack_route=T0EXAMPLE1&query=confidential&xoxb-2222-made-up-key=1'
    )
    const body = {
      formData: {
        channel: ['C0EXAMPLE1'],
        text: [MESSAGE],
        token: [TOKEN],
        _x_id: ['0f1e2d3c-1794900000.100'],
        _x_reason: ['webapp_message_send'],
        _x_mode: ['online'],
        _x_sonic: ['not a boolean'],
        _x_app_name: ['client'],
        _x_draft: [MESSAGE],
      },
    }

    // Act
    const shape = startedShapeOf('POST', url, body)

    // Assert
    assert.ok(shape !== null && shape.query !== null && shape.body !== null)
    const kept = JSON.stringify([shape.method, [...shape.query], [...shape.body]])
    assert.deepEqual(
      [shape.operation, shape.method, [...shape.query], [...shape.body]],
      [
        'chat.postMessage',
        'POST',
        [
          ['slack_route', null],
          ['query', null],
        ],
        [
          ['_x_mode', 'online'],
          ['_x_sonic', null],
          ['_x_app_name', 'client'],
          ['_x_draft', null],
        ],
      ]
    )
    assert.ok([TOKEN, MESSAGE, 'confidential', 'xoxb-', 'webapp_message_send'].every((value) => !kept.includes(value)))
  })

  it('should compare no body Chrome did not read as form fields, and find no fields in a call with no body', () => {
    // Arrange
    const url = new URL('https://example.slack.com/api/users.info?_x_id=0f1e2d3c-1794900000.100')

    // Act
    const raw = startedShapeOf('POST', url, {})
    const none = startedShapeOf('GET', url, undefined)

    // Assert
    assert.deepEqual([raw?.body, [...(none?.body ?? [])]], [null, []])
  })

  it("should keep neither the query nor the body of a file's address, so no upload grant", () => {
    // Arrange
    const url = new URL('https://files.slack.com/upload/v1/example-grant-0000?t=xoxe-0000-made-up')

    // Act
    const shape = startedShapeOf('POST', url, { formData: { filename: [MESSAGE] } })

    // Assert
    assert.deepEqual(shape, { operation: 'upload', method: 'POST', query: null, body: null })
    assert.ok(!JSON.stringify(shape).includes('example-grant'))
  })

  it('should keep header names, and only the listed values of their form: no cookie, no page address, no secret', () => {
    // Arrange
    const headers = [
      { name: 'Accept', value: '*/*' },
      { name: 'Content-Type', value: 'multipart/form-data; boundary=----WebKitFormBoundaryMADEUP0000' },
      { name: 'Cookie', value: 'd=xoxd-0000-made-up-cookie' },
      { name: 'Referer', value: 'https://app.slack.com/client/T0EXAMPLE1/search/confidential' },
      { name: 'User-Agent', value: `Example/1.0 ${TOKEN}` },
      { name: 'X-Slack-Made-Up', value: 'opaque' },
      { name: 'xoxp-1111-made-up-name', value: '1' },
      { name: 'Origin' },
    ]

    // Act
    const fields = headerFieldsOf(headers)

    // Assert
    assert.deepEqual(
      [...fields],
      [
        ['accept', '*/*'],
        ['content-type', 'multipart/form-data'],
        ['cookie', null],
        ['referer', null],
        ['user-agent', null],
        ['x-slack-made-up', null],
        ['origin', null],
      ]
    )
  })
})

describe('[service-worker] Slack request shape - differences', () => {
  it('should count a value of another form as a different value, and two values that are not kept as the same', () => {
    // Arrange
    const shape = (headers: [string, string | null][]): IRequestShape => ({
      operation: 'download',
      method: 'GET',
      query: null,
      body: null,
      headers: new Map(headers),
    })
    const client = shape([
      ['accept', '*/*'],
      ['cookie', null],
      ['user-agent', null],
    ])
    const misha = shape([
      ['accept', '*/*'],
      ['cookie', null],
      ['user-agent', 'Example/1.0'],
    ])

    // Act
    const differences = differencesOf(client, misha)

    // Assert
    assert.deepEqual(differences, [{ part: 'header', name: 'user-agent', kind: 'value' }])
  })
})

describe('[service-worker] Slack request shape - secret shapes', () => {
  const TOKEN = 'xoxc-0000-made-up-token'
  const AWS_KEY = 'AKIAABCDEFGHIJKLMNOP'
  const SECRETS = ['xoxc-0000', 'AKIAABCD', 'akiaabcd']

  it('should keep no name holding a secret: glued to a prefix, or in another letter case', () => {
    // Arrange
    const url = new URL(`https://example.slack.com/api/chat.postMessage?_x_id=0f1e2d3c-1794900000.100&_x_${TOKEN}=1`)
    const body = { formData: { [`_x_${TOKEN}`]: ['1'], _x_mode: ['online'] } }
    const headers = [
      { name: AWS_KEY, value: '1' },
      { name: AWS_KEY.toLowerCase(), value: '1' },
      { name: `x-${TOKEN}`, value: '1' },
      { name: 'Accept', value: '*/*' },
    ]

    // Act
    const shape = startedShapeOf('POST', url, body)
    const fields = headerFieldsOf(headers)

    // Assert
    assert.ok(shape !== null && shape.query !== null && shape.body !== null)
    const kept = JSON.stringify([[...shape.query], [...shape.body], [...fields]])
    assert.deepEqual(
      [[...shape.query], [...shape.body], [...fields]],
      [[], [['_x_mode', 'online']], [['accept', '*/*']]]
    )
    assert.ok(SECRETS.every((secret) => !kept.includes(secret)))
  })

  it('should keep no value holding a secret, the content type included', () => {
    // Arrange
    const headers = [
      { name: 'Content-Type', value: `application/${TOKEN}` },
      { name: 'User-Agent', value: `Example/1.0_${TOKEN}` },
      { name: 'Accept-Language', value: `en_${AWS_KEY}` },
    ]

    // Act
    const fields = headerFieldsOf(headers)

    // Assert
    assert.deepEqual(
      [...fields],
      [
        ['content-type', null],
        ['user-agent', null],
        ['accept-language', null],
      ]
    )
  })
})
