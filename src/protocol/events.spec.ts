import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { platformOfEventId } from './events.js'
import { slackEventKey } from './slack.js'

describe('[protocol] Events - platform', () => {
  it("should name the platform of a Slack event id by its scheme, and none for an id no platform's event carries", () => {
    // Arrange
    const slackId = slackEventKey(
      { teamId: 'T0EXAMPLE1', userId: 'U0EXAMPLE1' },
      { channel: 'C0EXAMPLE1', ts: '1700000001.000100' }
    )

    // Act
    const platforms = [slackId, '', 'no-scheme', 'teams:T1/C1/1'].map(platformOfEventId)

    // Assert
    assert.deepEqual(platforms, ['slack', null, null, null])
  })
})
