import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type IResourceEntry, keepClientQueries } from './client-query-keeper.js'

// Web API calls of Slack's client, with made-up values.
const API_ORIGIN = 'https://example.slack.com'
const OTHER_API_ORIGIN = 'https://other.enterprise.slack.com'
const callTo = (origin: string, query: string): string => `${origin}/api/client.counts?_x_id=0f1e2d3c-1.000&${query}`

const FOREGROUND = 'slack_route=T0EXAMPLE1&_x_foreground=true'
const BACKGROUND = 'slack_route=T0EXAMPLE1&_x_background=true'

const xhr = (url: string, startTime: number): IResourceEntry => ({
  initiatorType: 'xmlhttprequest',
  startTime,
  url: () => url,
})

const focusQuery = (field: '_x_foreground' | '_x_background'): unknown => [
  ['_x_id', null],
  ['slack_route', 'T0EXAMPLE1'],
  [field, 'true'],
]

describe('[service-worker] Client query keeper - the latest call', () => {
  it("should keep each workspace API's latest call by its start, and post each change", () => {
    // Arrange
    const keeper = keepClientQueries()

    // Act
    const changes = [
      keeper.take(xhr(callTo(API_ORIGIN, FOREGROUND), 10)),
      keeper.take(xhr(callTo(OTHER_API_ORIGIN, 'slack_route=E0EXAMPLE1'), 11)),
      keeper.take(xhr(callTo(API_ORIGIN, BACKGROUND), 12)),
    ]

    // Assert
    assert.deepEqual(changes, [
      { origin: API_ORIGIN, query: focusQuery('_x_foreground') },
      {
        origin: OTHER_API_ORIGIN,
        query: [
          ['_x_id', null],
          ['slack_route', 'E0EXAMPLE1'],
        ],
      },
      { origin: API_ORIGIN, query: focusQuery('_x_background') },
    ])

    assert.deepEqual(
      { ...keeper.queries() },
      {
        [API_ORIGIN]: focusQuery('_x_background'),
        [OTHER_API_ORIGIN]: [
          ['_x_id', null],
          ['slack_route', 'E0EXAMPLE1'],
        ],
      }
    )
  })

  it('should keep a newer call when an older one ends after it, and the one delivered later of two that started together', () => {
    // Arrange
    const startedEarlier = keepClientQueries()
    const startedTogether = keepClientQueries()

    // Act - the newer call's entry comes first, since entries come as their responses end
    startedEarlier.take(xhr(callTo(API_ORIGIN, BACKGROUND), 20))
    const endedLater = startedEarlier.take(xhr(callTo(API_ORIGIN, FOREGROUND), 10))
    startedTogether.take(xhr(callTo(API_ORIGIN, FOREGROUND), 30))
    const deliveredLater = startedTogether.take(xhr(callTo(API_ORIGIN, BACKGROUND), 30))

    // Assert
    assert.deepEqual(
      [endedLater, { ...startedEarlier.queries() }],
      [null, { [API_ORIGIN]: focusQuery('_x_background') }]
    )

    assert.deepEqual(deliveredLater, { origin: API_ORIGIN, query: focusQuery('_x_background') })
  })

  it('should move the kept start on without a post when a newer call carries the same values', () => {
    // Arrange
    const keeper = keepClientQueries()
    keeper.take(xhr(callTo(API_ORIGIN, FOREGROUND), 10))

    // Act - the same values at 30, then a call that started at 20 and ended last
    const sameValues = keeper.take(xhr(callTo(API_ORIGIN, FOREGROUND), 30))
    const startedBefore = keeper.take(xhr(callTo(API_ORIGIN, BACKGROUND), 20))

    // Assert
    assert.deepEqual([sameValues, startedBefore], [null, null])
    assert.deepEqual({ ...keeper.queries() }, { [API_ORIGIN]: focusQuery('_x_foreground') })
  })
})

describe('[service-worker] Client query keeper - what it reads and keeps', () => {
  it("should read the address of no entry but the client's XHR, so Misha's fetch is never kept", () => {
    // Arrange
    const keeper = keepClientQueries()

    const unread = (initiatorType: string): IResourceEntry => ({
      initiatorType,
      startTime: 10,
      url: () => {
        throw new Error(`The keeper read the address of a ${initiatorType} entry`)
      },
    })

    // Act
    const changes = ['fetch', 'script', 'img', 'other'].map((initiatorType) => keeper.take(unread(initiatorType)))

    // Assert
    assert.deepEqual(changes, [null, null, null, null])
    assert.deepEqual({ ...keeper.queries() }, {})
  })

  it('should keep nothing of a request that is no Web API call, or a call without a request id or a workspace route', () => {
    // Arrange
    const keeper = keepClientQueries()

    const urls = [
      'https://app.slack.com/client/T0EXAMPLE1?_x_id=0f1e2d3c-1.000&slack_route=T0EXAMPLE1',
      'https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/notes.txt?_x_id=0f1e2d3c-1.000&slack_route=T0EXAMPLE1',
      `${API_ORIGIN}/api/client.counts?slack_route=T0EXAMPLE1`,
      `${API_ORIGIN}/api/client.counts?_x_id=0f1e2d3c-1.000`,
      'not a URL',
    ]

    // Act
    const changes = urls.map((url) => keeper.take(xhr(url, 10)))

    // Assert
    assert.deepEqual(
      changes,
      urls.map(() => null)
    )

    assert.deepEqual({ ...keeper.queries() }, {})
  })

  it('should keep no value out of its form or shaped like a secret, nor any field outside the borrowed ones', () => {
    // Arrange
    const keeper = keepClientQueries()
    const secrets = ['xoxc-0000-made-up-token', 'AKIAABCDEFGHIJKLMNOP', 'a made-up search']

    const url = callTo(
      API_ORIGIN,
      `slack_route=T0EXAMPLE1&_x_csid=${secrets[1]}_suffix&fp=xoxc-0000&token=${secrets[0]}&query=${encodeURIComponent(secrets[2] ?? '')}&_x_version_ts=not-a-time`
    )

    // Act
    const change = keeper.take(xhr(url, 10))

    // Assert
    assert.deepEqual(change, {
      origin: API_ORIGIN,
      query: [
        ['_x_id', null],
        ['slack_route', 'T0EXAMPLE1'],
      ],
    })

    const kept = JSON.stringify(keeper.queries())
    assert.ok(secrets.every((secret) => !kept.includes(secret)))
  })
})
