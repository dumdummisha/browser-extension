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

// Sends one request to Slack in a turn of the pace (SlackPace). request must hand its command to the page with nothing
// asynchronous before the hand-off, from which the request counts as sent, and calls unsent only when the page's
// result, read, shows that nothing went out to Slack.
export type PacedSend = <TResult>(request: (unsent: () => void) => Promise<TResult>) => Promise<TResult>

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
// previous request to Slack ended, or goes at once when it has passed already. A request handed to the page leaves a
// gap behind unless its result shows that nothing went out (a page signed in as another account, a failure before the
// fetch); one that failed or whose result did not read after the hand-off may have gone out, so it leaves one, and is
// never sent again. Whether the caller still waits is
// checked before the turn, at the end of the gap and so right before the request hands its command to the page, which
// is the send boundary, after every asynchronous step of the turn (finding the page, an upload's ticket). A request
// whose caller gave up by then is dropped; one whose deadline would pass before its gap ends is dropped at once. A
// cancel after the hand-off is too late; the page checks only the deadline once more, right before its fetch.
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
    request: (unsent: () => void) => Promise<TResult>
  ): Promise<TResult> {
    throwIfAbandoned(abandonment)
    const now = Date.now()
    const sendAt = Math.max(now, (this.lastEnds.get(teamId) ?? Number.NEGATIVE_INFINITY) + this.drawGapMs())
    throwIfAbandoned(abandonment, sendAt)
    if (sendAt > now) {
      await pause(sendAt - now, abandonment.signal)
      throwIfAbandoned(abandonment)
    }

    const attempt = { isSent: true }
    try {
      return await request(() => {
        attempt.isSent = false
      })
    } finally {
      if (attempt.isSent) {
        this.lastEnds.set(teamId, Date.now())
      }
    }
  }
}
