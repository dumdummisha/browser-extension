import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { borrowedQueryOf, borrowedQueryString, freshRequestId, requestKeyOf } from './slack-request-shape.js'

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
