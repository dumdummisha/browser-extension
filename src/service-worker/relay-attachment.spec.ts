import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { attachRelay, type IProbedDocument, type IRelayScripting } from './relay-attachment.js'

const SLACK_ORIGIN = 'https://app.slack.com'
const TAB_ID = 7

const slackDocument = (documentId: string, hasRelay: boolean): IProbedDocument => ({
  documentId,
  probe: { origin: SLACK_ORIGIN, hasRelay },
})

interface IFakeScripting extends IRelayScripting {
  // Every injection asked for, as [tabId, documentId].
  readonly injections: [number, string][]
}

// chrome.scripting as the tab answers it: each probe takes the next of probes, in order, and every injection fails
// with injectionFailure when one is given.
const fakeScripting = (probes: (IProbedDocument | null)[], injectionFailure: Error | null): IFakeScripting => {
  const answers = [...probes]
  const injections: [number, string][] = []

  return {
    injections,
    probe: () => {
      const answer = answers.shift()
      assert.ok(answer !== undefined, 'the tab was probed more often than the test answers')

      return Promise.resolve(answer)
    },
    inject: (tabId, documentId) => {
      injections.push([tabId, documentId])

      return injectionFailure === null ? Promise.resolve() : Promise.reject(injectionFailure)
    },
  }
}

describe('[service-worker] Relay attachment - after an extension reload', () => {
  it('should inject the relay into the probed Slack document and no other', async () => {
    // Arrange
    const scripting = fakeScripting([slackDocument('DOC-A', false)], null)

    // Act
    await attachRelay(scripting, TAB_ID, SLACK_ORIGIN)

    // Assert
    assert.deepEqual(scripting.injections, [[TAB_ID, 'DOC-A']])
  })

  it('should give no relay to a page off Slack, a document whose relay runs, or a tab with no document', async () => {
    // Arrange
    const tabs = [
      fakeScripting([{ documentId: 'DOC-B', probe: { origin: 'https://example.com', hasRelay: false } }], null),
      fakeScripting([slackDocument('DOC-C', true)], null),
      fakeScripting([null], null),
    ]

    // Act
    for (const scripting of tabs) {
      await attachRelay(scripting, TAB_ID, SLACK_ORIGIN)
    }

    // Assert
    assert.deepEqual(
      tabs.map(({ injections }) => injections),
      [[], [], []]
    )
  })

  it('should skip a document that is gone by the time the relay goes in, and inject into no other', async () => {
    // Arrange - the tab navigated after the probe, to a page off Slack, or to one the extension cannot script
    const gone = new Error(`No document with id DOC-A in tab with id ${TAB_ID}`)
    const navigatedAway = fakeScripting(
      [
        slackDocument('DOC-A', false),
        { documentId: 'DOC-D', probe: { origin: 'https://example.com', hasRelay: false } },
      ],
      gone
    )
    const unscriptable = fakeScripting([slackDocument('DOC-A', false), null], gone)

    // Act
    await attachRelay(navigatedAway, TAB_ID, SLACK_ORIGIN)
    await attachRelay(unscriptable, TAB_ID, SLACK_ORIGIN)

    // Assert
    assert.deepEqual(navigatedAway.injections, [[TAB_ID, 'DOC-A']])
    assert.deepEqual(unscriptable.injections, [[TAB_ID, 'DOC-A']])
  })

  it('should reject an injection that failed while its document is still the one the tab shows', async () => {
    // Arrange
    const failure = new Error('Cannot access the contents of the page')
    const scripting = fakeScripting([slackDocument('DOC-A', false), slackDocument('DOC-A', false)], failure)

    // Act + Assert
    await assert.rejects(attachRelay(scripting, TAB_ID, SLACK_ORIGIN), failure)
  })
})
