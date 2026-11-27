import { redeliveryDelayMs } from '../protocol/pending-queue.js'
import type { SlackEvent } from '../protocol/slack.js'

// Forwards pending events to the app's listener: each one at once, then again under the same id after the redelivery
// waits, for as long as it stays pending. Nothing goes out before a listener attaches. One that attaches gets every
// pending event at once, and each one's waits start over. The relay does not say when a listener leaves, so the waits
// run on until the next one attaches or the native port drops; the relay drops what nobody listens to.
export class Forwarder {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private isListening = false

  constructor(
    private readonly send: (event: SlackEvent) => void,
    private readonly isPending: (id: string) => boolean
  ) {}

  public attach(events: readonly SlackEvent[]): void {
    this.clear()
    this.isListening = true

    for (const event of events) {
      this.deliver(event, 1)
    }
  }

  public forward(event: SlackEvent): void {
    if (this.isListening) {
      this.deliver(event, 1)
    }
  }

  // The app acknowledged the event: it is not sent again.
  public settle(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }

  public detach(): void {
    this.clear()
    this.isListening = false
  }

  private deliver(event: SlackEvent, sends: number): void {
    this.settle(event.id)
    this.send(event)

    this.timers.set(
      event.id,
      setTimeout(() => {
        if (this.isPending(event.id)) {
          this.deliver(event, sends + 1)
        } else {
          this.timers.delete(event.id)
        }
      }, redeliveryDelayMs(sends))
    )
  }

  private clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }

    this.timers.clear()
  }
}
