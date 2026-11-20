import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import type { IAbandonment } from './bridge-requests.js'
import { paceGapMs, SlackPace } from './slack-pace.js'

const NOW = 1_000_000
const GAP_MS = 1_000
// A caller's deadline that has not passed (2100-01-01).
const LATER = 4_102_444_800_000

const wanted = (deadline = LATER): IAbandonment => ({ deadline, signal: new AbortController().signal })

// Lets the promises that can move on do so; setImmediate is not one of the mocked timers.
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const mockClock = (context: TestContext): void => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
}

// A request to Slack that goes out, records when, and answers at once, or after durationMs on the mocked clock.
const recorder = (
  durationMs = 0
): { readonly sentAt: number[]; readonly request: (sent: () => void) => Promise<void> } => {
  const sentAt: number[] = []

  return {
    sentAt,
    request: (sent) => {
      sentAt.push(Date.now())
      sent()

      return durationMs === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, durationMs))
    },
  }
}

const tick = async (context: TestContext, ms: number): Promise<void> => {
  context.mock.timers.tick(ms)
  await settled()
}

describe('[service-worker] Slack pace - gaps', () => {
  it('should draw a gap from the normal distribution, again whenever it falls outside 500 to 2,000 ms', () => {
    // Arrange
    const draws = [0.9999, 0, 0.9999, 0.5, 1 - Math.exp(-0.5), 0]

    // Act
    const gap = paceGapMs(() => draws.shift() ?? 0)

    // Assert
    assert.ok(Math.abs(gap - 1_250) < 1e-6)
    assert.equal(draws.length, 0)
  })

  it('should keep every gap within 500 to 2,000 ms, around a mean of 1,000 ms', () => {
    // Arrange
    let seed = 7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648

      return seed / 2_147_483_648
    }

    // Act
    const gaps = Array.from({ length: 10_000 }, () => paceGapMs(random))

    // Assert
    const mean = gaps.reduce((total, gap) => total + gap, 0) / gaps.length
    assert.ok(gaps.every((gap) => gap >= 500 && gap <= 2_000))
    assert.ok(Math.abs(mean - 1_000) < 20)
  })
})

describe('[service-worker] Slack pace - turns', () => {
  it("should send a workspace's requests one at a time, each a gap after the previous one ended", async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder(300)

    // Act
    const turns = [
      pace.turn('T0EXAMPLE1', wanted(), (send) => send(request)),
      pace.turn('T0EXAMPLE1', wanted(), (send) => send(request)),
    ]
    await settled()
    await tick(context, 300)
    await tick(context, GAP_MS - 1)
    const beforeGap = [...sentAt]
    await tick(context, 1)
    await tick(context, 300)
    await Promise.all(turns)

    // Assert
    assert.deepEqual([beforeGap, sentAt], [[NOW], [NOW, NOW + 300 + GAP_MS]])
  })

  it('should not make another workspace wait', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()

    // Act
    const turns = [
      pace.turn('T0EXAMPLE1', wanted(), (send) => send(request)),
      pace.turn('T0OTHER001', wanted(), (send) => send(request)),
    ]
    await settled()
    await tick(context, 0)
    await Promise.all(turns)

    // Assert
    assert.deepEqual(sentAt, [NOW, NOW])
  })

  it("should wait a gap between two requests of one turn, as between an upload's ticket and its bytes", async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()

    // Act
    const turn = pace.turn('T0EXAMPLE1', wanted(), async (send) => {
      await send(request)
      await send(request)
    })
    await settled()
    await tick(context, 0)
    await tick(context, GAP_MS)
    await turn

    // Assert
    assert.deepEqual(sentAt, [NOW, NOW + GAP_MS])
  })

  it('should send at once when the gap since the previous request has passed already', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()
    const first = pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))
    await settled()
    await tick(context, 0)
    await first
    await tick(context, 5_000)

    // Act
    await pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))

    // Assert
    assert.deepEqual(sentAt, [NOW, NOW + 5_000])
  })

  it('should leave no gap behind an attempt that sent nothing, such as a page signed in as another account', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()
    await pace.turn('T0EXAMPLE1', wanted(), (send) => send(() => Promise.resolve()))

    // Act
    await pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))

    // Assert
    assert.deepEqual(sentAt, [NOW])
  })

  it('should keep the queue going after a request failed', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()

    // Act
    const failed = pace.turn('T0EXAMPLE1', wanted(), (send) =>
      send((sent) => {
        sent()

        return Promise.reject(new Error('Tab 12 closed'))
      })
    )
    const next = pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))
    await assert.rejects(failed, { message: 'Tab 12 closed' })
    await tick(context, GAP_MS)
    await tick(context, 0)
    await next

    // Assert
    assert.deepEqual(sentAt, [NOW + GAP_MS])
  })
})

describe('[service-worker] Slack pace - callers that gave up', () => {
  const GAVE_UP = { message: 'The caller gave up on the request before it was sent, so it was not sent' }

  it('should send nothing of a request cancelled while it waited for its turn', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder(300)
    const controller = new AbortController()
    const first = pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))
    const cancelled = pace.turn('T0EXAMPLE1', { deadline: LATER, signal: controller.signal }, (send) => send(request))
    const rejected = assert.rejects(cancelled, GAVE_UP)
    await settled()

    // Act
    controller.abort()
    await tick(context, 300)
    await first
    await rejected

    // Assert
    assert.deepEqual(sentAt, [NOW])
  })

  it('should hand nothing over when the caller cancelled while the turn found its page', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()
    const controller = new AbortController()
    const pageFound = Promise.withResolvers<undefined>()

    // Act
    const turn = pace.turn('T0EXAMPLE1', { deadline: LATER, signal: controller.signal }, async (send) => {
      await pageFound.promise
      await send(request)
    })
    const rejected = assert.rejects(turn, GAVE_UP)
    await settled()
    controller.abort()
    pageFound.resolve(undefined)
    await rejected

    // Assert
    assert.deepEqual(sentAt, [])
  })

  it('should send nothing of a request cancelled during its gap, and stop waiting at once', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()
    const controller = new AbortController()
    await pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))
    const cancelled = pace.turn('T0EXAMPLE1', { deadline: LATER, signal: controller.signal }, (send) => send(request))
    const rejected = assert.rejects(cancelled, GAVE_UP)
    await settled()

    // Act
    controller.abort()
    await rejected

    // Assert
    assert.deepEqual(sentAt, [NOW])
  })

  it("should send nothing more of a turn cancelled after its first request, such as an upload's bytes", async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()
    const controller = new AbortController()

    // Act
    const turn = pace.turn('T0EXAMPLE1', { deadline: LATER, signal: controller.signal }, async (send) => {
      await send(request)
      controller.abort()
      await send(request)
    })

    // Assert
    await assert.rejects(turn, GAVE_UP)
    assert.deepEqual(sentAt, [NOW])
  })

  it('should drop at once a request whose deadline passes before its gap would end', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder()
    await pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))

    // Act
    const late = pace.turn('T0EXAMPLE1', wanted(NOW + GAP_MS - 1), (send) => send(request))

    // Assert
    await assert.rejects(late, GAVE_UP)
    assert.deepEqual(sentAt, [NOW])
  })

  it('should drop a request whose deadline passed while it waited for its turn', async (context) => {
    // Arrange
    mockClock(context)
    const pace = new SlackPace(() => GAP_MS)
    const { sentAt, request } = recorder(1_500)
    const first = pace.turn('T0EXAMPLE1', wanted(), (send) => send(request))
    const late = pace.turn('T0EXAMPLE1', wanted(NOW + 1_000), (send) => send(request))
    const rejected = assert.rejects(late, GAVE_UP)
    await settled()

    // Act
    await tick(context, 1_500)
    await first
    await rejected

    // Assert
    assert.deepEqual(sentAt, [NOW])
  })
})
