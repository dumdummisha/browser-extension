import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { borrowedQueryOf } from './borrowed-query.js'
import { captureHealthOf, ObserverMessageSchema, RelayClientQuerySchema } from './observed-message.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const FRAME = { type: 'message', channel: 'C0EXAMPLE1', ts: '1700000000.000100', text: 'hello' }
const SAVED_STATE = '{"teams":{"T0EXAMPLE1":{"token":"xoxc-0000-example"}}}'
const API_ORIGIN = 'https://example.slack.com'
// A client query as the observer keeps it, in the client's order.
const QUERY = [
  ['_x_id', null],
  ['_x_gantry', 'true'],
  ['_x_csid', 'example-csid'],
  ['slack_route', 'T0EXAMPLE1'],
  ['fp', '7a'],
  ['_x_num_retries', null],
]

const isClientQueryRead = (query: unknown, origin: unknown = API_ORIGIN): boolean =>
  ObserverMessageSchema.safeParse({ kind: 'client-query', origin, query }).success

describe('[service-worker] Observed messages - from the observer', () => {
  it('should take a new message with its signed-in account and number, and a socket state that is a boolean', () => {
    // Arrange
    const messages = [
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: 0 },
      { kind: 'socket', isSocketOpen: true },
    ]

    // Act
    const results = messages.map((message) => ObserverMessageSchema.safeParse(message).success)

    // Assert
    assert.deepEqual(results, [true, true])
  })

  it('should refuse a socket state that is no boolean, a message without its user or number, and anything else', () => {
    // Arrange
    const messages = [
      { kind: 'socket' },
      { kind: 'socket', isSocketOpen: '{}' },
      { kind: 'socket', isSocketOpen: true, state: SAVED_STATE },
      { kind: 'frame', account: ACCOUNT, frame: SAVED_STATE, seq: 0 },
      { kind: 'frame', account: ACCOUNT, frame: { ...FRAME, token: 'xoxc-0000-example' }, seq: 0 },
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: 0, state: SAVED_STATE },
      { kind: 'frame', teamId: ACCOUNT.teamId, frame: FRAME, seq: 0 },
      { kind: 'frame', account: { teamId: ACCOUNT.teamId }, frame: FRAME, seq: 0 },
      { kind: 'frame', frame: FRAME, seq: 0 },
      { kind: 'frame', account: ACCOUNT, frame: FRAME },
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: -1 },
      { kind: 'frame', account: ACCOUNT, frame: FRAME, seq: 0.5 },
      SAVED_STATE,
    ]

    // Act
    const results = messages.map((message) => ObserverMessageSchema.safeParse(message).success)

    // Assert
    assert.deepEqual(
      results,
      messages.map(() => false)
    )
  })
})

describe('[service-worker] Observed messages - capture health', () => {
  it('should report a relay answer that does not read as that tab failed, rather than throw', () => {
    // Arrange
    const answers = [{}, '{"isSocketOpen":true}', { isSocketOpen: 'yes', error: null }, null, undefined]

    // Act
    const captures = answers.map((answer) => captureHealthOf(7, answer))

    // Assert
    assert.deepEqual(
      captures,
      answers.map(() => ({ tabId: 7, state: 'failed', error: 'The relay in tab 7 answered no capture state' }))
    )
  })

  it('should report a tab detached until its observer reports, attached once it does, and failed with its error', () => {
    // Arrange
    const error = 'The observer sent what does not read'
    const answers = [
      { isSocketOpen: null, error: null },
      { isSocketOpen: false, error: null },
      { isSocketOpen: true, error },
    ]

    // Act
    const captures = answers.map((answer) => captureHealthOf(7, answer))

    // Assert
    assert.deepEqual(captures, [
      { tabId: 7, state: 'detached' },
      { tabId: 7, state: 'attached', isSocketOpen: false },
      { tabId: 7, state: 'failed', error },
    ])
  })
})

describe('[service-worker] Observed messages - client queries from the observer', () => {
  it('should take a greeting with every kept query and a changed query, each in the order it came', () => {
    // Arrange
    const reordered = [QUERY[3], ...QUERY.slice(0, 3), ...QUERY.slice(4)]
    const messages = [
      { kind: 'greeting', isSocketOpen: false, queries: { [API_ORIGIN]: QUERY } },
      { kind: 'greeting', isSocketOpen: true, queries: {} },
      { kind: 'client-query', origin: 'https://other.enterprise.slack.com', query: reordered },
    ]

    // Act
    const parsed = messages.map((message) => ObserverMessageSchema.parse(message))

    // Assert
    assert.deepEqual(parsed, messages)
  })

  it('should take every query borrowedQueryOf cuts a client call down to', () => {
    // Arrange
    const urls = [
      `${API_ORIGIN}/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_gantry=true&_x_desktop_ia=4&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_version_ts=1794800000&_x_foreground=true&_x_frontend_build_type=next-0a1b2c3d&fp=7a&_x_num_retries=2`,
      `${API_ORIGIN}/api/conversations.history?_x_reason=history&_x_id=1a2b3c4d-1794900002.000&slack_route=T0EXAMPLE1&token=xoxc-0000-made-up&_x_background=true`,
    ]

    // Act
    const results = urls.map((url) => isClientQueryRead(borrowedQueryOf(new URL(url))))

    // Assert
    assert.deepEqual(results, [true, true])
  })

  it('should refuse a field outside the borrowed ones, a null or value where it does not belong, and a value out of form', () => {
    // Arrange
    const queries = [
      [...QUERY, ['token', 'xoxc-0000-made-up']],
      [...QUERY, ['_x_reason', 'history']],
      QUERY.map(([name, value]) => (name === 'slack_route' ? [name, null] : [name, value])),
      QUERY.map(([name, value]) => (name === '_x_id' ? [name, '0f1e2d3c-1794900000.100'] : [name, value])),
      QUERY.map(([name, value]) => (name === '_x_num_retries' ? [name, '2'] : [name, value])),
      QUERY.map(([name, value]) => (name === 'fp' ? [name, 'not hex'] : [name, value])),
      QUERY.map(([name, value]) => (name === '_x_csid' ? [name, 'xoxc-0000-made-up-token'] : [name, value])),
      QUERY.map(([name, value]) => (name === '_x_csid' ? [name, 'AKIAABCDEFGHIJKLMNOP_suffix'] : [name, value])),
      [...QUERY, ['_x_foreground', 'true', 'extra']],
      [...QUERY, '_x_foreground=true'],
      '_x_id=&slack_route=T0EXAMPLE1',
    ]

    // Act
    const results = queries.map((query) => isClientQueryRead(query))

    // Assert
    assert.deepEqual(
      results,
      queries.map(() => false)
    )
  })

  it('should refuse a query without its request id or its workspace route', () => {
    // Arrange
    const queries = [QUERY.filter(([name]) => name !== '_x_id'), QUERY.filter(([name]) => name !== 'slack_route'), []]

    // Act
    const results = queries.map((query) => isClientQueryRead(query))

    // Assert
    assert.deepEqual(results, [false, false, false])
  })

  it("should refuse an API origin that is not a workspace host's own https origin as URL writes it", () => {
    // Arrange
    const origins = [
      `${API_ORIGIN}/`,
      `${API_ORIGIN}/api/`,
      `${API_ORIGIN}:8443`,
      'http://example.slack.com',
      'https://EXAMPLE.slack.com',
      'https://user@example.slack.com',
      'https://example.slack.com.attacker.example',
      'https://files.slack.com.example',
      'example.slack.com',
      7,
    ]

    // Act
    const results = origins.map((origin) => isClientQueryRead(QUERY, origin))
    const greetings = origins.map(
      (origin) =>
        ObserverMessageSchema.safeParse({ kind: 'greeting', isSocketOpen: true, queries: { [String(origin)]: QUERY } })
          .success
    )

    // Assert
    assert.deepEqual([results, greetings], [origins.map(() => false), origins.map(() => false)])
  })
})

describe('[service-worker] Observed messages - client queries from the relay', () => {
  it("should read the relay's queries, or null when it has none to give", () => {
    // Arrange
    const answers = [{ queries: { [API_ORIGIN]: QUERY } }, { queries: null }]

    // Act
    const parsed = answers.map((answer) => RelayClientQuerySchema.parse(answer))

    // Assert
    assert.deepEqual(parsed, answers)
  })

  it('should refuse an answer that is missing its queries, carries more, or holds a query that does not read', () => {
    // Arrange
    const answers = [
      {},
      { queries: null, error: 'made-up' },
      { queries: { [API_ORIGIN]: [['token', 'xoxc-0000-made-up']] } },
      null,
      undefined,
    ]

    // Act
    const results = answers.map((answer) => RelayClientQuerySchema.safeParse(answer).success)

    // Assert
    assert.deepEqual(
      results,
      answers.map(() => false)
    )
  })
})
