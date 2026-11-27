import { once } from 'node:events'
import type { Server } from 'node:net'
import { PassThrough } from 'node:stream'
import type { TestContext } from 'node:test'
import { createFrameReader } from '../protocol/framing.js'
import { PROTOCOL_REVISION } from '../protocol/messages.js'
import { startNativeHostRelay } from './relay.js'

// Spec helpers: a native host relay whose browser pipe the test holds, the queue what it sends arrives in, and the
// extension's hello.

// The host's package version in these tests, unlike the clients' and the extension's: equal revisions talk whatever
// versions say.
export const HOST_VERSION = '9.8.7'
// The takeover deadline of a relay in these tests, well inside the test runner's timeout: a takeover between two
// relays here settles within milliseconds.
export const TAKEOVER_DEADLINE_MS = 5000

export const EXTENSION_HELLO = {
  type: 'hello',
  role: 'extension',
  protocolRevision: PROTOCOL_REVISION,
  componentVersion: '1.2.3',
}

export interface IQueue<TItem> {
  readonly put: (item: TItem) => void
  readonly next: () => Promise<TItem>
  // How many items came that nobody took yet.
  readonly size: () => number
}

// The relay with the extension's end of its pipe in the test's hands: frames written to input reach the relay, and
// what the relay sends the extension arrives in frames.
export interface ITestRelay {
  readonly server: Server
  readonly input: PassThrough
  readonly frames: IQueue<unknown>
}

// Items in the order they came, taken one at a time. Each waits in a box, since an item may itself be undefined.
export const createQueue = <TItem>(): IQueue<TItem> => {
  const boxes: { readonly item: TItem }[] = []
  const waiters: ((item: TItem) => void)[] = []

  return {
    put: (item) => {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        boxes.push({ item })
      } else {
        waiter(item)
      }
    },
    next: () => {
      const box = boxes.shift()

      return box === undefined ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(box.item)
    },
    size: () => boxes.length,
  }
}

// A relay listening on socketPath whose extension has not said hello yet; the host's hello to the extension is the
// first of its frames. A relay still listening when the test ends sees its browser's pipe end, and closes.
export const startTestRelay = async (
  context: TestContext,
  socketPath: string,
  browserApp: string | null
): Promise<ITestRelay> => {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames = createQueue<unknown>()
  output.on('data', createFrameReader(frames.put))

  const server = await startNativeHostRelay({
    input,
    output,
    socketPath,
    browserApp,
    componentVersion: HOST_VERSION,
    takeoverDeadlineMs: TAKEOVER_DEADLINE_MS,
  })

  context.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close')
      input.end()
      await closed
    }
  })

  return { server, input, frames }
}

// Lets what one end already wrote reach the other, so a queue that stays empty means nothing more went out.
export const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
