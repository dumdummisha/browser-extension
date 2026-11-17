import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chunkCount,
  chunkRange,
  FILE_CHUNK_BYTES,
  parseSlackAccountId,
  SLACK_BRIDGE_METHODS,
  slackAccountId,
  slackEventKey,
  SlackEventSchema,
  SlackStatusSchema,
} from './slack.js'

const ACCOUNT = { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' }
const FRAME = { type: 'message', channel: 'C0EXAMPLE1', ts: '1700000000.000100', text: 'hello' } as const

describe('[protocol] Slack accounts and events', () => {
  it('should key an account by workspace and user and read the key back', () => {
    // Act
    const accountId = slackAccountId(ACCOUNT)

    // Assert
    assert.equal(accountId, 'slack:T0EXAMPLE1:U0EXAMPLE1')
    assert.deepEqual(parseSlackAccountId(accountId), ACCOUNT)
  })

  it('should refuse a key that is not a Slack account id', () => {
    // Act + Assert
    assert.throws(() => parseSlackAccountId('slack:T0EXAMPLE1'), /is not a Slack account id/u)
    assert.throws(() => parseSlackAccountId('teams:T0EXAMPLE1:U0EXAMPLE1'), /is not a Slack account id/u)
  })

  it('should give the same key to one message reported by two tabs, and another to the next message', () => {
    // Act
    const first = slackEventKey(ACCOUNT, FRAME)
    const again = slackEventKey(ACCOUNT, { ...FRAME })
    const next = slackEventKey(ACCOUNT, { ...FRAME, ts: '1700000000.000200' })

    // Assert
    assert.equal(first, 'slack:T0EXAMPLE1:U0EXAMPLE1/C0EXAMPLE1/1700000000.000100')
    assert.equal(again, first)
    assert.notEqual(next, first)
  })

  it('should accept an event whose id is its dedupe key and refuse any other id', () => {
    // Arrange
    const event = { type: 'event', id: slackEventKey(ACCOUNT, FRAME), account: ACCOUNT, frame: FRAME }

    // Act
    const accepted = SlackEventSchema.safeParse(event)
    const refused = SlackEventSchema.safeParse({ ...event, id: 'evt-1' })

    // Assert
    assert.equal(accepted.success, true)
    assert.equal(refused.success, false)
  })
})

describe('[protocol] Slack status', () => {
  it('should state in every snapshot whether the queue commits, with the stored count when it does', () => {
    // Arrange
    const silent = { type: 'status', identities: [], captures: [] }
    const committing = { ...silent, queue: { state: 'committing', droppedEvents: 2 } }
    const uncounted = { ...silent, queue: { state: 'committing', droppedEvents: null } }
    const unstated = { ...silent, queue: { state: 'committing' } }

    // Act
    const parsed = [committing, uncounted, unstated, silent].map(
      (status) => SlackStatusSchema.safeParse(status).success
    )

    // Assert
    assert.deepEqual(parsed, [true, false, false, false])
  })

  it('should let a failing queue report its stored count as last known or explicitly unavailable, never as null', () => {
    // Arrange
    const failingWith = (loss: unknown): unknown => ({
      type: 'status',
      identities: [],
      captures: [],
      queue: { state: 'failing', error: 'QuotaExceededError', unstoredEvents: 2, uncountedEvents: 1, loss },
    })
    const losses = [
      { kind: 'last-known', droppedEvents: 7 },
      { kind: 'unavailable' },
      { kind: 'unavailable', droppedEvents: 0 },
      { kind: 'last-known', droppedEvents: null },
      null,
    ]

    // Act
    const parsed = losses.map((loss) => SlackStatusSchema.safeParse(failingWith(loss)).success)

    // Assert
    assert.deepEqual(parsed, [true, true, false, false, false])
  })
})

describe('[protocol] Slack bridge methods', () => {
  it('should call only allowlisted Web API methods', () => {
    // Arrange
    const call = { account: ACCOUNT, method: 'chat.postMessage', params: { channel: 'C0EXAMPLE1', text: 'hi' } }

    // Act
    const allowed = SLACK_BRIDGE_METHODS.slackCall.params.safeParse(call)
    const refused = SLACK_BRIDGE_METHODS.slackCall.params.safeParse({ ...call, method: 'chat.delete' })

    // Assert
    assert.equal(allowed.success, true)
    assert.equal(refused.success, false)
  })

  it('should download only from Slack private file URLs over HTTPS', () => {
    // Arrange
    const download = (url: string): boolean =>
      SLACK_BRIDGE_METHODS.slackDownload.params.safeParse({ account: ACCOUNT, url }).success

    // Act + Assert
    assert.equal(download('https://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/report.pdf'), true)
    assert.equal(download('http://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE1/report.pdf'), false)
    assert.equal(download('https://files.slack.com.example.org/report.pdf'), false)
  })

  it("should share only a prepared file, by Slack's file id, with or without a comment", () => {
    // Arrange
    const finish = {
      account: ACCOUNT,
      fileId: 'F0EXAMPLE1',
      title: 'chart.png',
      channel: 'C0EXAMPLE1',
      threadTs: '1700000000.000100',
      initialComment: ':misha: The chart shows the fix.',
    }

    // Act
    const withComment = SLACK_BRIDGE_METHODS.slackUploadFinish.params.safeParse(finish)
    const without = SLACK_BRIDGE_METHODS.slackUploadFinish.params.safeParse({ ...finish, initialComment: null })
    const byUploadId = SLACK_BRIDGE_METHODS.slackUploadFinish.params.safeParse({
      ...finish,
      fileId: undefined,
      uploadId: '5b0d7e3a-9c41-4f2e-8a6b-1d2c3e4f5a6b',
    })
    const prepared = SLACK_BRIDGE_METHODS.slackUploadPrepare.result.safeParse({ ok: true, fileId: 'F0EXAMPLE1' })

    // Assert
    assert.deepEqual(
      [withComment.success, without.success, byUploadId.success, prepared.success],
      [true, true, false, true]
    )
  })
})

describe('[protocol] File chunks', () => {
  it('should split a file into whole chunks and a shorter last one', () => {
    // Arrange
    const byteLength = FILE_CHUNK_BYTES * 2 + 10

    // Act
    const count = chunkCount(byteLength)
    const last = chunkRange(2, byteLength)

    // Assert
    assert.equal(count, 3)
    assert.deepEqual(chunkRange(0, byteLength), { start: 0, end: FILE_CHUNK_BYTES })
    assert.deepEqual(last, { start: FILE_CHUNK_BYTES * 2, end: byteLength })
  })

  it('should have no chunks for an empty file and refuse a chunk past the end', () => {
    // Act + Assert
    assert.equal(chunkCount(0), 0)
    assert.equal(chunkCount(FILE_CHUNK_BYTES), 1)
    assert.throws(() => chunkRange(1, FILE_CHUNK_BYTES), RangeError)
    assert.throws(() => chunkRange(0, 0), RangeError)
  })
})
