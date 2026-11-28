import { type IAbandonment, throwIfAbandoned } from './bridge-requests.js'
import { serially } from './serially.js'

// The gap a person leaves between two requests to a site: drawn from a normal distribution around 1,000 ms with a
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

// Sends one request to the site a turn acts on, in a turn of the pace (RequestPace). request must hand its command to
// the page with nothing asynchronous before the hand-off, or check the caller again after its last asynchronous step and
// call unsent before it gives up (a WhatsApp commit checks its document first), so the caller's deadline and cancel hold
// at the hand-off itself. From the hand-off the request counts as sent. It calls unsent only when it handed the page
// nothing, or when the result, read, shows that the site was handed nothing and nothing was kept. A WhatsApp prepare
// sends nothing to WhatsApp but keeps a message in the page, so it counts like a sent request: that bounds how many
// prepared messages a window holds (whatsapp-capture.ts PREPARED_SEND_WINDOW_MS).
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

// A key's turns, which run one at a time, and when its previous request to the site ended.
interface IPacedKey {
  readonly queue: ReturnType<typeof serially>
  lastEnd: number
}

// Requests to the site a turn acts on at a person's pace, one queue per key (Slack passes a workspace's team id,
// WhatsApp an account's id): a key's turns run one at a time in the order they came, and each request a turn sends waits
// until a fresh gap (drawGapMs) has passed since the key's previous request to the site ended, or goes at once when it
// has passed already. A request handed to the page leaves a gap behind unless its result shows that the page did
// nothing (a page signed in as another account, a failure before the fetch); one that failed or whose result did not
// read after the hand-off may have gone out, so it leaves one, and is never sent again. Whether the caller still waits
// is checked before the turn, and at the end of the gap, after every asynchronous step of the turn (finding the page, an
// upload's ticket), right before the request hands its command to the page, which is the send boundary; a request that
// takes one more asynchronous step after the gap checks the caller again itself (PacedSend). A request whose caller gave
// up by then is dropped; one whose deadline would pass before its gap ends is dropped at once. A cancel after the
// hand-off is too late; the page checks only the deadline once more, right before it acts.
export class RequestPace {
  private readonly keys = new Map<string, IPacedKey>()

  constructor(private readonly drawGapMs: () => number) {}

  // Runs task in the key's queue; every request it sends to the site goes through send.
  public turn<TResult>(
    key: string,
    abandonment: IAbandonment,
    task: (send: PacedSend) => Promise<TResult>
  ): Promise<TResult> {
    const paced = this.keys.get(key) ?? { queue: serially(), lastEnd: Number.NEGATIVE_INFINITY }
    this.keys.set(key, paced)

    return paced.queue(() => {
      throwIfAbandoned(abandonment)

      return task((request) => this.send(paced, abandonment, request))
    })
  }

  private async send<TResult>(
    paced: IPacedKey,
    abandonment: IAbandonment,
    request: (unsent: () => void) => Promise<TResult>
  ): Promise<TResult> {
    throwIfAbandoned(abandonment)

    const now = Date.now()
    const sendAt = Math.max(now, paced.lastEnd + this.drawGapMs())
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
        paced.lastEnd = Date.now()
      }
    }
  }
}
