import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { platformOfEventId } from './events.js'
import { slackEventKey } from './slack.js'
import { whatsappEventKey } from './whatsapp.js'

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

  it('should name the platform of a WhatsApp event id', () => {
    // Arrange
    const whatsappId = whatsappEventKey(
      { wid: '100000000000001@lid' },
      { chat: '100000000000002@lid', id: '3EB0A1B2C3D4E5F60718' }
    )

    // Act
    const platform = platformOfEventId(whatsappId)

    // Assert
    assert.equal(platform, 'whatsapp')
  })
})
