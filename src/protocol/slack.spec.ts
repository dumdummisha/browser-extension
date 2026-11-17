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
