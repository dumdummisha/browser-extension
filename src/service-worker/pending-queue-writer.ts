import {
  countedLoss,
  DROPPED_EVENTS_ID,
  droppedEventsOf,
  EVENT_IDS_REMEMBERED,
  EVENT_QUEUE_MAX,
  LOSS_STORE,
  PENDING_EVENTS_STORE,
  PENDING_QUEUE_DATABASE,
  PENDING_QUEUE_DATABASE_VERSION,
  PendingQueueError,
  restoredQueue,
  STORE_KEY_PATH,
} from '../protocol/pending-queue.js'
import type { QueueHealth, SlackEvent } from '../protocol/slack.js'

// The pending queue's one writer (protocol pending-queue.ts holds the rules it follows). Every change waits for the one
// before it, recovery first, and runs as one readwrite transaction over both stores. A change that does not commit
// leaves the queue failing until one does; what it could not store, the writer holds in memory and the service worker
// forwards from there.

// What admitting a captured event came to: put in the queue, held in memory because the queue fails, already pending
// or acknowledged (nothing changes), or lost for want of room.
export type Admission = 'stored' | 'held' | 'duplicate' | 'lost'

export interface IWriterHooks {
  // The stored events recovery found, once it committed, for the service worker to forward.
  readonly onRestored: (events: readonly SlackEvent[]) => void
  readonly onHealthChange: (health: QueueHealth) => void
}

// One change's view of the queue inside its transaction: the events pending once it commits, and how many events it
// counts as lost.
interface IDraft {
  readonly events: IDBObjectStore
  readonly pending: Map<string, SlackEvent>
  lost: number
}

export const openPendingQueue = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const opening = factory.open(PENDING_QUEUE_DATABASE, PENDING_QUEUE_DATABASE_VERSION)
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(PENDING_EVENTS_STORE, { keyPath: STORE_KEY_PATH })
      opening.result.createObjectStore(LOSS_STORE, { keyPath: STORE_KEY_PATH })
    }
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error ?? new PendingQueueError('The pending queue did not open'))
  })

// A read of the change's transaction. A failed read leaves the transaction for the change to abort, so every change
// reads first and writes last, and no read can follow a write that failed.
const read = <TResult>(operation: IDBRequest<TResult>): Promise<TResult> =>
  new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = (event) => {
      event.preventDefault()
      reject(operation.error ?? new PendingQueueError('A read of the pending queue failed'))
    }
  })

// Runs change in one readwrite transaction over both stores, durable on disk once it commits. It resolves only after
// the commit; a change that throws aborts the transaction, and one that does not commit rejects.
const commit = async <TResult>(
  database: IDBDatabase,
  change: (events: IDBObjectStore, loss: IDBObjectStore) => Promise<TResult>
): Promise<TResult> => {
  const transaction = database.transaction([PENDING_EVENTS_STORE, LOSS_STORE], 'readwrite', { durability: 'strict' })
  const state = { isFinished: false }
  const completion = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => {
      state.isFinished = true
      resolve()
    }
    transaction.onabort = () => {
      state.isFinished = true
      reject(transaction.error ?? new PendingQueueError('The transaction aborted'))
    }
  })

  try {
    const result = await change(transaction.objectStore(PENDING_EVENTS_STORE), transaction.objectStore(LOSS_STORE))
    await completion

    return result
  } catch (error) {
    if (!state.isFinished) {
      transaction.abort()
    }

    // The change's own error says why; the abort that follows it adds nothing.
    await completion.catch(() => undefined)
    throw error
  }
}

// The admission rule inside a change: an event already pending changes nothing, one that fits is put, and one that does
// not is counted as lost.
const admitInto = (draft: IDraft, event: SlackEvent): Admission => {
  if (draft.pending.has(event.id)) {
    return 'duplicate'
  }

  if (draft.pending.size >= EVENT_QUEUE_MAX) {
    draft.lost += 1
    return 'lost'
  }

  draft.events.put(event)
  draft.pending.set(event.id, event)

  return 'stored'
}

// The count the change leaves: the one its transaction read, plus the events it lost, stored with them.
const countLoss = (loss: IDBObjectStore, lossRecord: unknown, lost: number): number => {
  if (lost === 0) {
    return droppedEventsOf(lossRecord)
  }

  const record = countedLoss(lossRecord, lost)
  loss.put(record)

  return record.droppedEvents
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `Unknown failure: ${String(error)}`

export class PendingQueueWriter {
  private database: IDBDatabase | null = null
  private changes: Promise<unknown> = Promise.resolve()
  // The stored queue as of the last change that committed.
  private stored = new Map<string, SlackEvent>()
  // Events whose admission did not commit, forwarded from memory until a change commits and stores or counts them.
  private readonly held = new Map<string, SlackEvent>()
  // The held events the change in progress put in its transaction, which stores them if it commits.
  private readonly drafted = new Set<string>()
  // Events lost for want of room while the queue failed, not in the stored count yet.
  private uncountedEvents = 0
  // Whether recovery committed; until it does, every change runs it first.
  private isRecovered = false
  // The stored count as the writer last read or committed it, so a recovery that read it and then failed still knows
  // it. Undefined until a read of it succeeds.
  private droppedEvents: number | undefined
  // What the last change that did not commit failed with; null once a change commits.
  private failure: string | null = null
  // Ids acknowledged lately, oldest first, so a second tab's late copy of a message is dropped here.
  private readonly acknowledged = new Set<string>()
  private reportedHealth: string | null = null

  constructor(
    private readonly openDatabase: () => Promise<IDBDatabase>,
    private readonly hooks: IWriterHooks
  ) {}

  // Recovery, when the worker starts: every change waits for it, so it runs before any intake or ack.
  public recover(): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.recovered()
      } catch (error) {
        this.fail(error)
      }
    })
  }

  public admit(event: SlackEvent): Promise<Admission> {
    return this.enqueue(async () => {
      if (this.acknowledged.has(event.id) || this.isPending(event.id)) {
        return 'duplicate'
      }

      try {
        await this.recovered()

        // The held events are older than this one, so they go in first.
        return await this.commitChange((draft) => {
          this.admitHeld(draft)

          return admitInto(draft, event)
        })
      } catch (error) {
        this.fail(error)

        return this.hold(event)
      }
    })
  }

  // The app acknowledges an event once it committed it, and the writer remembers it at once. A held event leaves memory
  // at once too, with no transaction, unless the change in progress put it in its transaction: then the ack waits for
  // that change, after which the event is either still held, and leaves memory, or stored. A stored one is deleted by a
  // change, which deletes every acknowledged event still stored before it admits the held events (commitChange). It
  // resolves true once the event is no longer pending, and false when the deletion did not commit: the event stays
  // pending, so it is forwarded again, and the next change that commits deletes it.
  public ack(id: string): Promise<boolean> {
    this.remember(id)
    if (!this.drafted.has(id) && this.held.delete(id)) {
      this.reportHealth()

      return Promise.resolve(true)
    }

    return this.enqueue(async () => {
      if (this.held.delete(id) || !this.stored.has(id)) {
        return true
      }

      try {
        await this.recovered()
        await this.commitChange((draft) => this.admitHeld(draft))

        return true
      } catch (error) {
        this.fail(error)

        return false
      }
    })
  }

  // Resolves once every change asked for so far has run.
  public settled(): Promise<void> {
    return this.changes.then(() => undefined)
  }

  public health(): QueueHealth {
    if (this.failure !== null) {
      return {
        state: 'failing',
        error: this.failure,
        unstoredEvents: this.held.size,
        uncountedEvents: this.uncountedEvents,
        loss:
          this.droppedEvents === undefined
            ? { kind: 'unavailable' }
            : { kind: 'last-known', droppedEvents: this.droppedEvents },
      }
    }

    if (!this.isRecovered || this.droppedEvents === undefined) {
      throw new PendingQueueError('The pending queue has not run its recovery yet')
    }

    return { state: 'committing', droppedEvents: this.droppedEvents }
  }

  // Every event waiting for its ack, stored or held: what a listener that attaches gets.
  public pending(): SlackEvent[] {
    return [...this.stored.values(), ...this.held.values()]
  }

  public isPending(id: string): boolean {
    return this.stored.has(id) || this.held.has(id)
  }

  private enqueue<TResult>(change: () => Promise<TResult>): Promise<TResult> {
    const next = this.changes.then(change).finally(() => this.reportHealth())
    this.changes = next.catch(() => undefined)

    return next
  }

  // Runs recovery when it has not committed yet: read every stored record and the count, delete the records that hold
  // no readable event and count them, and admit what the writer holds, in one transaction. The count it read is the
  // stored one until that transaction commits, so it stays the last-known count when the transaction does not.
  private async recovered(): Promise<void> {
    if (this.isRecovered) {
      return
    }

    const database = await this.connect()
    const { restored, pending, droppedEvents } = await commit(database, async (events, loss) => {
      const [keys, values, lossRecord] = await Promise.all([
        read(events.getAllKeys()),
        read<unknown[]>(events.getAll()),
        read<unknown>(loss.get(DROPPED_EVENTS_ID)),
      ])
      const queue = restoredQueue(
        keys.map((key, index) => ({ key, value: values[index] })),
        lossRecord
      )
      this.droppedEvents = queue.droppedEvents
      for (const key of queue.unreadableKeys) {
        events.delete(key)
      }

      const draft = {
        events,
        pending: new Map(queue.events.map((event) => [event.id, event])),
        lost: queue.unreadableKeys.length,
      }
      this.admitHeld(draft)

      return {
        restored: queue.events,
        pending: draft.pending,
        droppedEvents: countLoss(loss, lossRecord, draft.lost + this.uncountedEvents),
      }
    })
    this.settle(pending, droppedEvents)
    this.isRecovered = true
    this.hooks.onRestored(restored)
  }

  // A change after recovery. It first deletes every acknowledged event still stored, whose own deletion did not commit,
  // so the room they free counts for it. Then work edits the draft, and the change counts every loss it made, the
  // uncounted ones of a failure included.
  private async commitChange<TResult>(work: (draft: IDraft) => TResult): Promise<TResult> {
    const database = await this.connect()
    const { result, pending, droppedEvents } = await commit(database, async (events, loss) => {
      const lossRecord = await read<unknown>(loss.get(DROPPED_EVENTS_ID))
      const draft: IDraft = { events, pending: new Map(this.stored), lost: 0 }
      for (const id of this.stored.keys()) {
        if (this.acknowledged.has(id)) {
          events.delete(id)
          draft.pending.delete(id)
        }
      }

      const changed = work(draft)

      return {
        result: changed,
        pending: draft.pending,
        droppedEvents: countLoss(loss, lossRecord, draft.lost + this.uncountedEvents),
      }
    })
    this.settle(pending, droppedEvents)

    return result
  }

  private admitHeld(draft: IDraft): void {
    for (const event of this.held.values()) {
      this.drafted.add(event.id)
      admitInto(draft, event)
    }
  }

  // A change committed: the draft is the stored queue, every held event is stored or counted, and the failure clears.
  private settle(pending: Map<string, SlackEvent>, droppedEvents: number): void {
    this.stored = pending
    this.held.clear()
    this.drafted.clear()
    this.uncountedEvents = 0
    this.droppedEvents = droppedEvents
    this.failure = null
  }

  // A change did not commit, so the held events it put in its transaction stay held only. The connection is dropped, so
  // the next change opens the database again.
  private fail(error: unknown): void {
    this.failure = describeError(error)
    this.drafted.clear()
    this.database?.close()
    this.database = null
  }

  private hold(event: SlackEvent): Admission {
    if (this.held.size >= EVENT_QUEUE_MAX) {
      this.uncountedEvents += 1
      return 'lost'
    }

    this.held.set(event.id, event)

    return 'held'
  }

  private remember(id: string): void {
    this.acknowledged.delete(id)
    this.acknowledged.add(id)
    const [oldest] = this.acknowledged
    if (oldest !== undefined && this.acknowledged.size > EVENT_IDS_REMEMBERED) {
      this.acknowledged.delete(oldest)
    }
  }

  private async connect(): Promise<IDBDatabase> {
    if (this.database === null) {
      this.database = await this.openDatabase()
    }

    return this.database
  }

  // Tells the service worker when the queue's health changed, so the status it pushes is never stale.
  private reportHealth(): void {
    if (this.failure === null && !this.isRecovered) {
      return
    }

    const health = this.health()
    const reported = JSON.stringify(health)
    if (reported !== this.reportedHealth) {
      this.reportedHealth = reported
      this.hooks.onHealthChange(health)
    }
  }
}
