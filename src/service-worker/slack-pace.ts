import { type IAbandonment, throwIfAbandoned } from './bridge-requests.js'
import { serially } from './serially.js'

// The gap a person leaves between two requests to Slack: drawn from a normal distribution around 1,000 ms with a
// standard deviation of 250 ms, and drawn again when it falls outside 500 to 2,000 ms.
const GAP_MEAN_MS = 1_000
const GAP_DEVIATION_MS = 250
const GAP_MIN_MS = 500
const GAP_MAX_MS = 2_000

// A gap from random, which answers uniform numbers in [0, 1) as Math.random does (the Box-Muller transform).
export const paceGapMs = (random: () => number): number => {
  let gap: number
  do {
    const radius = Math.sqrt(-2 * Math.log(1 - random()))
    gap = GAP_MEAN_MS + GAP_DEVIATION_MS * radius * Math.cos(2 * Math.PI * random())
  } while (gap < GAP_MIN_MS || gap > GAP_MAX_MS)

  return gap
}

// Sends one request to Slack in a turn of the pace (SlackPace).
export type PacedSend = <TResult>(request: () => Promise<TResult>) => Promise<TResult>

// Waits ms, or less once signal aborts.
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

// Slack's requests at a person's pace, one queue per workspace: a workspace's turns run one at a time in the order
// they came, and each request a turn sends waits until a fresh gap (drawGapMs) has passed since the workspace's
// previous request ended, or goes at once when it has passed already. A request whose caller gave up is dropped, never
// sent late: before its turn, during its gap, or between two requests of one turn (an upload's ticket and its bytes).
// One whose deadline would pass before its gap ends is dropped at once.
export class SlackPace {
  private readonly queues = new Map<string, ReturnType<typeof serially>>()
  private readonly lastEnds = new Map<string, number>()

  constructor(private readonly drawGapMs: () => number) {}

  // Runs task in the workspace's queue; every request it sends to Slack goes through send.
  public turn<TResult>(
    teamId: string,
    abandonment: IAbandonment,
    task: (send: PacedSend) => Promise<TResult>
  ): Promise<TResult> {
    const queue = this.queues.get(teamId) ?? serially()
    this.queues.set(teamId, queue)

    return queue(() => {
      throwIfAbandoned(abandonment)

      return task((request) => this.send(teamId, abandonment, request))
    })
  }

  private async send<TResult>(
    teamId: string,
    abandonment: IAbandonment,
    request: () => Promise<TResult>
  ): Promise<TResult> {
    throwIfAbandoned(abandonment)
    const now = Date.now()
    const sendAt = Math.max(now, (this.lastEnds.get(teamId) ?? Number.NEGATIVE_INFINITY) + this.drawGapMs())
    throwIfAbandoned(abandonment, sendAt)
    if (sendAt > now) {
      await pause(sendAt - now, abandonment.signal)
      throwIfAbandoned(abandonment)
    }

    try {
      return await request()
    } finally {
      this.lastEnds.set(teamId, Date.now())
    }
  }
}
