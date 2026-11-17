import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { DROPPED_EVENTS_ID, EVENT_QUEUE_MAX, LOSS_STORE, PENDING_EVENTS_STORE } from '../protocol/pending-queue.js'
import { type QueueHealth, type SlackEvent, slackEventKey } from '../protocol/slack.js'
import { openPendingQueue, PendingQueueWriter } from './pending-queue-writer.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const DISK_FULL = 'QuotaExceededError: The disk is full'

interface IQueueControl {
  // While set, opening the database fails, as a disk that is full does.
  isOpeningRefused: boolean
  connection: IDBDatabase | null
}

interface IStoredQueue {
  readonly ids: string[]
  readonly lossRecord: unknown
}

const eventAt = (ts: string): SlackEvent => {
  const frame = { type: 'message', channel: 'C0EXAMPLE1', ts, text: 'hello' } as const

  return { type: 'event', id: slackEventKey(ACCOUNT, frame), account: ACCOUNT, frame }
}

const fullQueue = (): SlackEvent[] =>
  Array.from({ length: EVENT_QUEUE_MAX }, (_, index) => eventAt(`1700000000.${String(index + 1).padStart(6, '0')}`))

const finished = (transaction: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('The transaction aborted'))
  })

const seed = async (factory: IDBFactory, records: readonly unknown[], lossRecord?: unknown): Promise<void> => {
  const database = await openPendingQueue(factory)
  const transaction = database.transaction([PENDING_EVENTS_STORE, LOSS_STORE], 'readwrite')
  for (const record of records) {
    transaction.objectStore(PENDING_EVENTS_STORE).put(record)
  }

  if (lossRecord !== undefined) {
    transaction.objectStore(LOSS_STORE).put(lossRecord)
  }

  await finished(transaction)
  database.close()
}

const storedQueue = async (factory: IDBFactory): Promise<IStoredQueue> => {
  const database = await openPendingQueue(factory)
  const transaction = database.transaction([PENDING_EVENTS_STORE, LOSS_STORE], 'readonly')
  const keys = transaction.objectStore(PENDING_EVENTS_STORE).getAllKeys()
  const loss = transaction.objectStore(LOSS_STORE).get(DROPPED_EVENTS_ID)
  await finished(transaction)
  database.close()

  return { ids: keys.result.map(String), lossRecord: loss.result }
}

const createWriter = (
  factory: IDBFactory
): { writer: PendingQueueWriter; control: IQueueControl; restored: SlackEvent[][]; healths: QueueHealth[] } => {
  const control: IQueueControl = { isOpeningRefused: false, connection: null }
  const restored: SlackEvent[][] = []
  const healths: QueueHealth[] = []
  const writer = new PendingQueueWriter(
    async () => {
      if (control.isOpeningRefused) {
        throw new DOMException('The disk is full', 'QuotaExceededError')
      }

      control.connection = await openPendingQueue(factory)

      return control.connection
    },
    {
      onRestored: (events) => restored.push([...events]),
      onHealthChange: (health) => healths.push(health),
    }
  )

  return { writer, control, restored, healths }
}

// The open connection stops working and the database cannot be opened again: every change fails until it can.
const breakQueue = (control: IQueueControl): void => {
  control.isOpeningRefused = true
  control.connection?.close()
}

describe('[service-worker] Pending queue writer - recovery', () => {
  it('should restore stored events oldest first, deleting and counting the records it cannot read', async () => {
    // Arrange
    const factory = new IDBFactory()
    const later = eventAt('1700000002.000100')
    const earlier = eventAt('1700000001.000100')
    const unreadable = { id: 'older-format', text: 'hello' }
    await seed(factory, [later, unreadable, earlier], { id: DROPPED_EVENTS_ID, droppedEvents: 2 })
    const { writer, restored } = createWriter(factory)

    // Act
    await writer.recover()

    // Assert
    assert.deepEqual(restored, [[earlier, later]])
    assert.deepEqual(writer.pending(), [earlier, later])
    assert.deepEqual(writer.health(), { state: 'committing', droppedEvents: 3 })
    assert.deepEqual(await storedQueue(factory), {
      ids: [earlier.id, later.id],
      lossRecord: { id: DROPPED_EVENTS_ID, droppedEvents: 3 },
    })
  })

  it('should report the loss count as unavailable while no read of it ever succeeded', async () => {
    // Arrange
    const { writer, control } = createWriter(new IDBFactory())
    control.isOpeningRefused = true

    // Act
    await writer.recover()
    const admission = await writer.admit(eventAt('1700000001.000100'))

    // Assert
    assert.equal(admission, 'held')
    assert.deepEqual(writer.health(), {
      state: 'failing',
      error: DISK_FULL,
      unstoredEvents: 1,
      uncountedEvents: 0,
      loss: { kind: 'unavailable' },
    })
  })
})

describe('[service-worker] Pending queue writer - admission and acks', () => {
  it('should store a new event once and drop a late copy of an acknowledged one', async () => {
    // Arrange
    const factory = new IDBFactory()
    const event = eventAt('1700000001.000100')
    const { writer } = createWriter(factory)
    await writer.recover()

    // Act
    const first = await writer.admit(event)
    const repeat = await writer.admit(event)
    const storedBeforeAck = await storedQueue(factory)
    await writer.ack(event.id)
    const lateCopy = await writer.admit(event)

    // Assert
    assert.deepEqual([first, repeat, lateCopy], ['stored', 'duplicate', 'duplicate'])
    assert.deepEqual(storedBeforeAck.ids, [event.id])
    assert.deepEqual(await storedQueue(factory), { ids: [], lossRecord: undefined })
    assert.deepEqual(writer.pending(), [])
  })

  it('should count an event that finds the queue full, in the same transaction that refuses it', async () => {
    // Arrange
    const factory = new IDBFactory()
    await seed(factory, fullQueue())
    const { writer } = createWriter(factory)
    await writer.recover()

    // Act
    const admission = await writer.admit(eventAt('1700000099.000100'))

    // Assert
    assert.equal(admission, 'lost')
    assert.equal(writer.pending().length, EVENT_QUEUE_MAX)
    assert.deepEqual(writer.health(), { state: 'committing', droppedEvents: 1 })
    assert.deepEqual((await storedQueue(factory)).lossRecord, { id: DROPPED_EVENTS_ID, droppedEvents: 1 })
  })
})

describe('[service-worker] Pending queue writer - failures', () => {
  it('should hold events while the queue fails and store them with the next change that commits', async () => {
    // Arrange
    const factory = new IDBFactory()
    const first = eventAt('1700000001.000100')
    const second = eventAt('1700000002.000100')
    const third = eventAt('1700000003.000100')
    const { writer, control, healths } = createWriter(factory)
    await writer.recover()
    breakQueue(control)

    // Act
    const held = [await writer.admit(first), await writer.admit(second)]
    const failing = writer.health()
    control.isOpeningRefused = false
    const stored = await writer.admit(third)

    // Assert
    assert.deepEqual([...held, stored], ['held', 'held', 'stored'])
    assert.deepEqual(failing, {
      state: 'failing',
      error: DISK_FULL,
      unstoredEvents: 2,
      uncountedEvents: 0,
      loss: { kind: 'last-known', droppedEvents: 0 },
    })
    assert.deepEqual(writer.pending(), [first, second, third])
    assert.deepEqual(
      (await storedQueue(factory)).ids,
      [first, second, third].map(({ id }) => id)
    )
    assert.deepEqual(
      healths.map(({ state }) => state),
      ['committing', 'failing', 'failing', 'committing']
    )
  })

  it('should drop an acknowledged held event from memory alone, which does not end the failure', async () => {
    // Arrange
    const acknowledged = eventAt('1700000001.000100')
    const kept = eventAt('1700000002.000100')
    const { writer, control } = createWriter(new IDBFactory())
    await writer.recover()
    breakQueue(control)
    await writer.admit(acknowledged)
    await writer.admit(kept)

    // Act
    await writer.ack(acknowledged.id)

    // Assert
    assert.deepEqual(writer.pending(), [kept])
    assert.deepEqual(writer.health(), {
      state: 'failing',
      error: DISK_FULL,
      unstoredEvents: 1,
      uncountedEvents: 0,
      loss: { kind: 'last-known', droppedEvents: 0 },
    })
  })

  it('should apply an ack before admitting held events, so the room it frees counts for them', async () => {
    // Arrange
    const factory = new IDBFactory()
    const oldest = eventAt('1700000000.000001')
    const held = eventAt('1700000099.000100')
    await seed(factory, fullQueue())
    const { writer, control } = createWriter(factory)
    await writer.recover()
    breakQueue(control)
    await writer.admit(held)
    control.isOpeningRefused = false

    // Act
    await writer.ack(oldest.id)

    // Assert
    assert.deepEqual(writer.health(), { state: 'committing', droppedEvents: 0 })
    assert.equal(writer.isPending(held.id), true)
    assert.equal(writer.isPending(oldest.id), false)
    const stored = await storedQueue(factory)
    assert.deepEqual(
      [stored.ids.length, stored.ids.includes(held.id), stored.lossRecord],
      [EVENT_QUEUE_MAX, true, undefined]
    )
  })
})
