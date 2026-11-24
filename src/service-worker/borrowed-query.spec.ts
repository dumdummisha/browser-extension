import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { borrowedQueryOf, borrowedQueryString, freshRequestId } from './borrowed-query.js'

// A Web API call of Slack's client, as its page sends it, with made-up values in the order the client writes its
// fields: client.counts, a method the transport never calls itself.
const CLIENT_COUNTS =
  'https://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_gantry=true&_x_desktop_ia=4&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_foreground=true&_x_frontend_build_type=next-0a1b2c3d&fp=7a&_x_num_retries=2'
// The least a client call carries to lend its query: a request id and a workspace route.
const MINIMAL_CLIENT_CALL =
  'https://example.slack.com/api/client.counts?_x_id=0f1e2d3c-1794900000.100&slack_route=T0EXAMPLE1'

describe('[service-worker] Borrowed query - from a client call', () => {
  it("should borrow the transport fields of any client Web API call, client.counts included, in the client's order", () => {
    // Act
    const borrowed = borrowedQueryOf(new URL(CLIENT_COUNTS))

    // Assert
    assert.deepEqual(borrowed, [
      ['_x_id', null],
      ['_x_gantry', 'true'],
      ['_x_desktop_ia', '4'],
      ['_x_csid', 'example-csid'],
      ['slack_route', 'T0EXAMPLE1'],
      ['_x_version_ts', '1794800000'],
      ['_x_foreground', 'true'],
      ['_x_frontend_build_type', 'next-0a1b2c3d'],
      ['fp', '7a'],
      ['_x_num_retries', null],
    ])
  })

  it('should borrow either focus field the client sent, and only as true', () => {
    // Arrange
    const urls = ['_x_foreground=true', '_x_background=true', '_x_foreground=false', '_x_background=1'].map(
      (field) => new URL(`${MINIMAL_CLIENT_CALL}&${field}`)
    )

    // Act
    const borrowed = urls.map((url) => borrowedQueryOf(url))

    // Assert
    assert.deepEqual(borrowed, [
      [
        ['_x_id', null],
        ['slack_route', 'T0EXAMPLE1'],
        ['_x_foreground', 'true'],
      ],
      [
        ['_x_id', null],
        ['slack_route', 'T0EXAMPLE1'],
        ['_x_background', 'true'],
      ],
      [
        ['_x_id', null],
        ['slack_route', 'T0EXAMPLE1'],
      ],
      [
        ['_x_id', null],
        ['slack_route', 'T0EXAMPLE1'],
      ],
    ])
  })

  it("should borrow the page's build type only in the forms Slack's client accepts", () => {
    // Arrange
    const accepted = ['current', 'next-0a1b', 'next2-0a1b2c3d', 'next999-0a1b2c3d', `next-${'a'.repeat(40)}`]
    const refused = [
      'beta',
      'next1-0a1b',
      'next1000-0a1b',
      'next-0a1',
      'next-0A1B',
      'next-0a1x',
      `next-${'a'.repeat(41)}`,
    ]

    // Act
    const borrowed = [...accepted, ...refused].map((value) => {
      const url = new URL(MINIMAL_CLIENT_CALL)
      url.searchParams.set('_x_frontend_build_type', value)

      return borrowedQueryOf(url)?.some(([name]) => name === '_x_frontend_build_type')
    })

    // Assert
    assert.deepEqual(borrowed, [...accepted.map(() => true), ...refused.map(() => false)])
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
      '_x_id=a1b2c3d4-1794900001.200&_x_gantry=true&_x_desktop_ia=4&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_foreground=true&_x_frontend_build_type=next-0a1b2c3d&fp=7a&_x_num_retries=0',
      '_x_id=a1b2c3d4-1794900001.200&_x_gantry=true&_x_desktop_ia=4&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_foreground=true&_x_frontend_build_type=next-0a1b2c3d&fp=7a',
    ])
  })

  it("should give request ids in the form Slack's client gives its own", () => {
    // Act
    const requestId = freshRequestId()

    // Assert
    assert.match(requestId, /^[\da-f]{8}-\d+\.\d{3}$/u)
  })
})
