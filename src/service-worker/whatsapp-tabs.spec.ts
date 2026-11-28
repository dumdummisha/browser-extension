import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { settled } from './testing.js'
import { type WhatsAppRelayAnswer, whatsappAnswerOf } from './whatsapp-observed.js'
import { type IOpenWhatsAppTabs, type WhatsAppDocumentAsk, WhatsAppTabs } from './whatsapp-tabs.js'

// The registry of WhatsApp tabs (whatsapp-tabs.ts), walked through the sequences of design U2 amendment 3 R-40.6 and
// amendment 4 R-46: tabs 41 and 42, documents DOC-1 to DOC-3, each request numbered in the order it was sent.

const TAB_ID = 41
const OTHER_TAB_ID = 42
const LEO_NOVAK = { wid: '100000000000001@lid' }
const EMMA_LEE = { wid: '100000000000002@lid' }
const TOKEN_1 = '00000000-0000-4000-8000-000000000001'
const TOKEN_2 = '00000000-0000-4000-8000-000000000002'
const TOKEN_3 = '00000000-0000-4000-8000-000000000003'
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.'
const NOT_SHOWN = { state: 'not-shown' } as const
const DETACHED = { state: 'detached' } as const
const FAILED = { state: 'failed', error: 'The observer sent a message that does not read' } as const

const ready = (token: string, account = LEO_NOVAK, isConnected = true): WhatsAppRelayAnswer => ({
  state: 'observed',
  token,
  capture: { state: 'ready', account, isConnected, hasSynced: true },
})

const observed = (token: string, capture: { state: 'signed-out' | 'loading' }): WhatsAppRelayAnswer => ({
  state: 'observed',
  token,
  capture,
})

const readyStatus = (tabId: number, isConnected = true): object => ({
  tabId,
  state: 'ready',
  account: LEO_NOVAK,
  isConnected,
  hasSynced: true,
})

interface IHeldAsk {
  readonly tabId: number
  readonly documentId: string
  readonly answer: (answer: WhatsAppRelayAnswer) => void
  readonly reject: () => void
}

interface IHeldRegistry {
  readonly tabs: WhatsAppTabs
  readonly asked: IHeldAsk[]
  readonly tabAsks: number[]
  readonly pushes: { count: number }
}

// A registry whose asks wait until the test answers or rejects each, whose tab asks are recorded, and whose pushes are
// counted.
const heldRegistry = (): IHeldRegistry => {
  const asked: IHeldAsk[] = []
  const tabAsks: number[] = []
  const pushes = { count: 0 }

  const ask: WhatsAppDocumentAsk = (tabId, documentId) => {
    const { promise, resolve, reject } = Promise.withResolvers<WhatsAppRelayAnswer>()
    asked.push({ tabId, documentId, answer: resolve, reject: () => reject(new Error(NO_RECEIVER)) })

    return promise
  }

  const tabs = new WhatsAppTabs(
    ask,
    (tabId) => tabAsks.push(tabId),
    () => (pushes.count += 1)
  )

  return { tabs, asked, tabAsks, pushes }
}

// The ask with that index, which the test settles.
const heldAsk = (asked: readonly IHeldAsk[], index: number): IHeldAsk => {
  const held = asked[index]
  assert.ok(held !== undefined, `the registry sent request #${index + 1}`)

  return held
}

// Tab 41 as the only open tab, listed after every request sent so far.
const openTab = (tabs: WhatsAppTabs): IOpenWhatsAppTabs => ({ ids: [TAB_ID], asOf: tabs.requestsSent() })

// The given tabs open, listed after every request sent so far.
const openTabs = (tabs: WhatsAppTabs, ids: readonly number[]): IOpenWhatsAppTabs => ({ ids, asOf: tabs.requestsSent() })

// Tab 41 recorded from DOC-1's answer to request #1, with TOKEN_1, ready as Leo Novak.
const recordedRegistry = async (): Promise<IHeldRegistry> => {
  const registry = heldRegistry()
  registry.tabs.reported(TAB_ID, 'DOC-1')
  heldAsk(registry.asked, 0).answer(ready(TOKEN_1))
  await settled()

  return registry
}

describe('[service-worker] WhatsApp tabs - records', () => {
  it('should make no record from a report until the document answers, then list it with its tab id', async () => {
    // Arrange
    const { tabs, asked } = heldRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    await settled()
    const beforeAnswer = tabs.statuses(openTab(tabs))

    // Act
    heldAsk(asked, 0).answer(ready(TOKEN_1))
    await settled()

    // Assert
    assert.deepEqual(beforeAnswer, [])
    assert.deepEqual([asked.length, heldAsk(asked, 0).documentId], [1, 'DOC-1'])
    assert.deepEqual(tabs.statuses(openTab(tabs)), [readyStatus(TAB_ID)])
  })

  it('should list detached, failed and observed states as answered, and a state that does not read as failed', async () => {
    // Arrange
    const { tabs, asked } = heldRegistry()

    for (const tabId of [41, 42, 43, 44]) {
      tabs.reported(tabId, `DOC-${tabId}`)
    }

    // Act
    heldAsk(asked, 0).answer(DETACHED)
    heldAsk(asked, 1).answer(FAILED)
    heldAsk(asked, 2).answer(observed(TOKEN_3, { state: 'signed-out' }))
    heldAsk(asked, 3).answer(whatsappAnswerOf(44, { state: 'unheard-of' }))
    await settled()

    // Assert
    assert.deepEqual(tabs.statuses(openTabs(tabs, [41, 42, 43, 44])), [
      { tabId: 41, state: 'detached' },
      { tabId: 42, state: 'failed', error: 'The observer sent a message that does not read' },
      { tabId: 43, state: 'signed-out' },
      { tabId: 44, state: 'failed', error: 'The relay in tab 44 answered no state that reads' },
    ])
  })

  it('should list only the open tabs, in tab id order', async () => {
    // Arrange
    const { tabs, asked } = heldRegistry()

    for (const tabId of [43, 42, 41]) {
      tabs.reported(tabId, `DOC-${tabId}`)
    }

    for (const [index, held] of asked.entries()) {
      held.answer(ready(`00000000-0000-4000-8000-00000000004${index}`))
    }

    await settled()

    // Act
    const statuses = tabs.statuses(openTabs(tabs, [42, 41]))

    // Assert
    assert.deepEqual(
      statuses.map(({ tabId }) => tabId),
      [41, 42]
    )
  })

  it('should answer the ready document of the lowest open tab id for the account, and none for a tab signed out, broken, ready as another account, or not open', async () => {
    // Arrange - tab 40 is ready as Leo Novak but not open
    const { tabs, asked } = heldRegistry()
    const token = (tabId: number): string => `00000000-0000-4000-8000-0000000000${tabId}`

    for (const tabId of [40, 41, 42, 43, 44, 45]) {
      tabs.reported(tabId, `DOC-${tabId}`)
    }

    heldAsk(asked, 0).answer(ready(token(40)))
    heldAsk(asked, 1).answer(observed(token(41), { state: 'signed-out' }))

    heldAsk(asked, 2).answer({
      state: 'observed',
      token: token(42),
      capture: { state: 'broken', drift: 'collections' },
    })

    heldAsk(asked, 3).answer(ready(token(43), EMMA_LEE))
    heldAsk(asked, 4).answer(ready(token(44)))
    heldAsk(asked, 5).answer(ready(token(45)))
    await settled()

    // Act
    const found = tabs.readyDocument(LEO_NOVAK, openTabs(tabs, [41, 42, 43, 44, 45]))
    const none = tabs.readyDocument(LEO_NOVAK, openTabs(tabs, [41, 42, 43]))

    // Assert
    assert.deepEqual(found, { tabId: 44, documentId: 'DOC-44', token: token(44) })
    assert.equal(none, null)
  })

  it("should find the document of a token only while an open tab's record holds it", async () => {
    // Arrange
    const { tabs, asked } = await recordedRegistry()
    const whileRecorded = tabs.documentOfToken(TOKEN_1, openTab(tabs))

    // Act - DOC-2 replaces DOC-1 after a reload
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 1).answer(ready(TOKEN_2))
    await settled()

    // Assert
    assert.deepEqual(whileRecorded, { tabId: TAB_ID, documentId: 'DOC-1', token: TOKEN_1 })
    assert.equal(tabs.documentOfToken(TOKEN_1, openTab(tabs)), null)
    assert.deepEqual(tabs.documentOfToken(TOKEN_2, openTab(tabs)), {
      tabId: TAB_ID,
      documentId: 'DOC-2',
      token: TOKEN_2,
    })
    assert.equal(tabs.documentOfToken(TOKEN_2, openTabs(tabs, [])), null)
  })

  it("should hold a document as recorded only for its tab's record, its document and its observed token", async () => {
    // Arrange - tab 42 is not recorded until DOC-3 answers detached
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(OTHER_TAB_ID, 'DOC-3')
    await settled()
    const beforeRecord = tabs.isRecorded({ tabId: OTHER_TAB_ID, documentId: 'DOC-3', token: TOKEN_3 })
    heldAsk(asked, 1).answer(DETACHED)
    await settled()

    // Act
    const answers = [
      tabs.isRecorded({ tabId: TAB_ID, documentId: 'DOC-1', token: TOKEN_1 }),
      tabs.isRecorded({ tabId: TAB_ID, documentId: 'DOC-1', token: TOKEN_2 }),
      tabs.isRecorded({ tabId: TAB_ID, documentId: 'DOC-2', token: TOKEN_1 }),
      tabs.isRecorded({ tabId: OTHER_TAB_ID, documentId: 'DOC-3', token: TOKEN_3 }),
    ]

    // Assert
    assert.equal(beforeRecord, false)
    assert.deepEqual(answers, [true, false, false, false])
  })

  it('should push when a record is made, removed, or answered with another state, and not for an answer equal to the record', async () => {
    // Arrange
    const { tabs, asked, pushes } = await recordedRegistry()
    const afterMade = pushes.count

    // Act
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()
    const afterEqual = pushes.count
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).answer(ready(TOKEN_1, LEO_NOVAK, false))
    await settled()
    const afterChanged = pushes.count
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 3).reject()
    await settled()

    // Assert
    assert.deepEqual([afterMade, afterEqual, afterChanged, pushes.count], [1, 1, 2, 3])
  })
})

describe('[service-worker] WhatsApp tabs - numbering', () => {
  it('should ignore an answer numbered below the request that made the record, from the same document', async () => {
    // Arrange - the page's connection drops, then comes back, and DOC-1 reports each time
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).answer(ready(TOKEN_1))
    await settled()

    // Act - the answer to the earlier report is delivered now
    heldAsk(asked, 1).answer(ready(TOKEN_1, LEO_NOVAK, false))
    await settled()

    // Assert
    assert.deepEqual(tabs.statuses(openTab(tabs)), [readyStatus(TAB_ID)])
  })

  it("should ignore an older request's answer from the old document after the new document's answer made the record", async () => {
    // Arrange - a reload: the tab event asks DOC-1, then DOC-2 reports and answers
    const { tabs, asked } = await recordedRegistry()
    tabs.tabChanged(TAB_ID, true)
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 2).answer(ready(TOKEN_2))
    await settled()

    // Act
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()

    // Assert
    assert.equal(tabs.documentOfToken(TOKEN_1, openTab(tabs)), null)
    assert.deepEqual(tabs.documentOfToken(TOKEN_2, openTab(tabs)), {
      tabId: TAB_ID,
      documentId: 'DOC-2',
      token: TOKEN_2,
    })
  })

  it('should replace the record with a newer answer from another document', async () => {
    // Arrange
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 1).answer(ready(TOKEN_2))
    await settled()
    const afterNewDocument = tabs.documentOfToken(TOKEN_2, openTab(tabs))

    // Act - DOC-1, still answering while it is being replaced, answers a newer request
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).answer(ready(TOKEN_1))
    await settled()

    // Assert
    assert.deepEqual(afterNewDocument, { tabId: TAB_ID, documentId: 'DOC-2', token: TOKEN_2 })
    assert.deepEqual(tabs.documentOfToken(TOKEN_1, openTab(tabs)), {
      tabId: TAB_ID,
      documentId: 'DOC-1',
      token: TOKEN_1,
    })
  })

  it("should number the requests of all tabs from one counter, so a record of one tab never stops another tab's answer", async () => {
    // Arrange - tab 42's request is sent first, and tab 41 is recorded from a later one
    const { tabs, asked } = heldRegistry()
    tabs.reported(OTHER_TAB_ID, 'DOC-3')
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()

    // Act
    heldAsk(asked, 0).answer(ready(TOKEN_3))
    await settled()

    // Assert
    assert.equal(tabs.requestsSent(), 2)

    assert.deepEqual(tabs.statuses(openTabs(tabs, [TAB_ID, OTHER_TAB_ID])), [
      readyStatus(TAB_ID),
      readyStatus(OTHER_TAB_ID),
    ])
  })
})

describe('[service-worker] WhatsApp tabs - rejections and not-shown', () => {
  it('should remove a record when a request pinned to its document is rejected, and record that document again at its next answer', async () => {
    // Arrange
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 1).reject()
    await settled()
    const afterRejection = tabs.statuses(openTab(tabs))

    // Act
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).answer(ready(TOKEN_1))
    await settled()

    // Assert
    assert.deepEqual(afterRejection, [])
    assert.deepEqual(tabs.statuses(openTab(tabs)), [readyStatus(TAB_ID)])
  })

  it("should remove the record when an older request to its document is rejected after a newer one's answer made it", async () => {
    // Arrange - DOC-1 is asked twice and tab 42's DOC-3 once; the second answer records DOC-1 again
    const { tabs, asked, pushes } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.reported(OTHER_TAB_ID, 'DOC-3')
    heldAsk(asked, 2).answer(ready(TOKEN_1, LEO_NOVAK, false))
    await settled()
    const pushesBefore = pushes.count

    // Act - the older request is rejected, which carries no request number; DOC-3 then answers a request sent before
    // that removal, and DOC-1 reports and answers a fresh one
    heldAsk(asked, 1).reject()
    await settled()
    const afterRejection = tabs.statuses(openTabs(tabs, [TAB_ID, OTHER_TAB_ID]))
    const pushesAfterRejection = pushes.count
    heldAsk(asked, 3).answer(ready(TOKEN_3))
    await settled()
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, asked.length - 1).answer(ready(TOKEN_1))
    await settled()

    // Assert - DOC-3 is asked again under the risen floor, and DOC-1 is recorded from the fresh answer
    assert.deepEqual(afterRejection, [])
    assert.equal(pushesAfterRejection, pushesBefore + 1)

    assert.deepEqual(
      asked.map(({ tabId, documentId }) => [tabId, documentId]),
      [
        [TAB_ID, 'DOC-1'],
        [TAB_ID, 'DOC-1'],
        [TAB_ID, 'DOC-1'],
        [OTHER_TAB_ID, 'DOC-3'],
        [OTHER_TAB_ID, 'DOC-3'],
        [TAB_ID, 'DOC-1'],
      ]
    )

    assert.deepEqual(tabs.statuses(openTabs(tabs, [TAB_ID, OTHER_TAB_ID])), [readyStatus(TAB_ID)])
  })

  it('should change nothing when a request pinned to a document other than the recorded one is rejected', async () => {
    // Arrange - DOC-2 replaced DOC-1
    const { tabs, asked, pushes } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 1).answer(ready(TOKEN_2))
    await settled()
    const pushesBefore = pushes.count

    // Act - DOC-1's late report raises a request that Chrome rejects
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).reject()
    await settled()

    // Assert
    assert.deepEqual(tabs.documentOfToken(TOKEN_2, openTab(tabs)), {
      tabId: TAB_ID,
      documentId: 'DOC-2',
      token: TOKEN_2,
    })
    assert.equal(pushes.count, pushesBefore)
  })

  it('should change nothing while a request never settles, and keep listing the tab', async () => {
    // Arrange - a URL change of the same document raises a request that never settles
    const { tabs, asked } = await recordedRegistry()
    tabs.tabChanged(TAB_ID, true)
    await settled()
    const whilePending = tabs.readyDocument(LEO_NOVAK, openTab(tabs))

    // Act
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).answer(ready(TOKEN_1))
    await settled()

    // Assert
    assert.deepEqual(whilePending, { tabId: TAB_ID, documentId: 'DOC-1', token: TOKEN_1 })
    assert.deepEqual(tabs.statuses(openTab(tabs)), [readyStatus(TAB_ID)])
  })

  it('should remove the record when its document answers not-shown, and change nothing when another document does', async () => {
    // Arrange - a prerendered DOC-2 sends a message, and answers not-shown
    const { tabs, asked } = await recordedRegistry()
    tabs.messaged(TAB_ID, 'DOC-2')
    heldAsk(asked, 1).answer(NOT_SHOWN)
    await settled()
    const afterOtherDocument = tabs.statuses(openTab(tabs))

    // Act - DOC-1 went into the back/forward cache
    tabs.tabChanged(TAB_ID, false)
    heldAsk(asked, 2).answer(NOT_SHOWN)
    await settled()

    // Assert
    assert.deepEqual(afterOtherDocument, [readyStatus(TAB_ID)])
    assert.deepEqual(tabs.statuses(openTab(tabs)), [])
  })

  it('should ask the tab again when a command missed the recorded document, and not after a rejection of its own ask', async () => {
    // Arrange - a rejection of the registry's own ask removes the record and asks nothing more
    const { tabs, asked, tabAsks } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 1).reject()
    await settled()
    const afterOwnRejection = [...tabAsks]
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).answer(ready(TOKEN_1))
    await settled()

    // Act
    tabs.missed({ tabId: TAB_ID, documentId: 'DOC-1', token: TOKEN_1 })

    // Assert
    assert.deepEqual(afterOwnRejection, [])
    assert.deepEqual(tabAsks, [TAB_ID])
    assert.deepEqual(tabs.statuses(openTab(tabs)), [])
  })
})

describe('[service-worker] WhatsApp tabs - tab events', () => {
  it('should ask the recorded document and the tab on any change of a tab that has a record', async () => {
    // Arrange
    const { tabs, asked, tabAsks } = await recordedRegistry()

    // Act - the tab's URL left the origin, so only its record makes the change count
    tabs.tabChanged(TAB_ID, false)

    // Assert
    assert.deepEqual([asked.length, heldAsk(asked, 1).documentId, tabAsks], [2, 'DOC-1', [TAB_ID]])
  })

  it('should ask only the tab on a change of a tab on the origin without a record, and nothing for a tab off the origin without one', () => {
    // Arrange
    const { tabs, asked, tabAsks } = heldRegistry()

    // Act
    tabs.tabChanged(TAB_ID, true)
    tabs.tabChanged(OTHER_TAB_ID, false)

    // Assert
    assert.deepEqual([asked.length, tabAsks], [0, [TAB_ID]])
  })

  it('should keep the document that answered after a discard event that came late, and record no state from the event', async () => {
    // Arrange - DOC-2 replaced DOC-1 after a discard, and its report was answered before the discard event came
    const { tabs, asked } = heldRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 0).answer(ready(TOKEN_1))
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 1).answer(ready(TOKEN_2))
    await settled()

    // Act - the late discard event asks the recorded document, which answers
    tabs.tabChanged(TAB_ID, true)
    heldAsk(asked, 2).answer(ready(TOKEN_2))
    await settled()

    // Assert
    assert.deepEqual(
      [heldAsk(asked, 2).documentId, tabs.documentOfToken(TOKEN_2, openTab(tabs))],
      ['DOC-2', { tabId: TAB_ID, documentId: 'DOC-2', token: TOKEN_2 }]
    )
  })

  it("should remove a closed or replaced tab's record, and make none from a later report whose request is rejected", async () => {
    // Arrange - tab 42 recorded too
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(OTHER_TAB_ID, 'DOC-3')
    heldAsk(asked, 1).answer(ready(TOKEN_3))
    await settled()

    // Act - tab 41 closes, Chrome replaces tab 42, and DOC-1's report is delivered after the close
    tabs.forget(TAB_ID)
    tabs.forget(OTHER_TAB_ID)
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).reject()
    await settled()

    // Assert
    assert.deepEqual(tabs.statuses(openTabs(tabs, [TAB_ID, OTHER_TAB_ID])), [])
  })

  it('should leave a record of a tab that is no longer open out of the status and of every command, and remove it when a request sent before the listing made it', async () => {
    // Arrange - tab 41 left the origin, and tab 42's record is made by a request sent after the listing
    const { tabs, asked } = await recordedRegistry()
    const listing = openTabs(tabs, [])
    tabs.reported(OTHER_TAB_ID, 'DOC-3')
    heldAsk(asked, 1).answer(ready(TOKEN_3))
    await settled()

    // Act
    const listed = [
      tabs.statuses(listing),
      tabs.readyDocument(LEO_NOVAK, listing),
      tabs.documentOfToken(TOKEN_1, listing),
      tabs.documentOfToken(TOKEN_3, listing),
    ]

    // Assert - tab 41's record went with that listing; tab 42's stayed for the next one
    assert.deepEqual(listed, [[], null, null, null])
    assert.deepEqual(tabs.statuses(openTabs(tabs, [TAB_ID, OTHER_TAB_ID])), [readyStatus(OTHER_TAB_ID)])
  })
})

describe('[service-worker] WhatsApp tabs - the floor', () => {
  it('should not record a tab from an answer that arrives after the tab closed, and ask its document again', async () => {
    // Arrange - DOC-1 answered request #2 while it lived, and the answer is still on its way
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.forget(TAB_ID)

    // Act
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()
    heldAsk(asked, 2).reject()
    await settled()

    // Assert
    assert.deepEqual(tabs.statuses(openTab(tabs)), [])
    assert.deepEqual([asked.length, heldAsk(asked, 2).tabId, heldAsk(asked, 2).documentId], [3, TAB_ID, 'DOC-1'])
  })

  it('should not put a document back from an answer that was asked before its record was removed', async () => {
    // Arrange - #2 to DOC-1 is held; DOC-2 replaces DOC-1 (#3); DOC-1's late report is rejected (#4); a request to the
    // live DOC-2 is rejected (#5), which removes its record
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 2).answer(ready(TOKEN_2))
    await settled()
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 3).reject()
    tabs.reported(TAB_ID, 'DOC-2')
    heldAsk(asked, 4).reject()
    await settled()

    // Act
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()
    heldAsk(asked, 5).reject()
    await settled()

    // Assert
    assert.deepEqual(tabs.statuses(openTab(tabs)), [])
    assert.deepEqual([asked.length, heldAsk(asked, 5).documentId], [6, 'DOC-1'])
  })

  it('should record a document again from the answer to the request a stale answer caused', async () => {
    // Arrange - #2 to DOC-1 is held; #3 to DOC-1 is rejected, which removes the record; #4 to DOC-1 is sent after it
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).reject()
    await settled()
    tabs.reported(TAB_ID, 'DOC-1')

    // Act - #2 arrives and is asked again as #5, which DOC-1 answers disconnected
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()
    heldAsk(asked, 4).answer(ready(TOKEN_1, LEO_NOVAK, false))
    await settled()
    heldAsk(asked, 3).answer(ready(TOKEN_1))
    await settled()

    // Assert - the record carries #5: #4's answer, numbered below it, is not taken
    assert.equal(heldAsk(asked, 4).documentId, 'DOC-1')
    assert.deepEqual(tabs.statuses(openTab(tabs)), [readyStatus(TAB_ID, false)])
  })

  it('should ask an answering document of another tab again when a removal came between its request and its answer, and record it then', async () => {
    // Arrange - tab 42's request #2 is held while tab 41's record is removed by a rejection (#3)
    const { tabs, asked } = await recordedRegistry()
    const open = (): IOpenWhatsAppTabs => openTabs(tabs, [TAB_ID, OTHER_TAB_ID])
    tabs.reported(OTHER_TAB_ID, 'DOC-3')
    tabs.reported(TAB_ID, 'DOC-1')
    heldAsk(asked, 2).reject()
    await settled()

    // Act
    heldAsk(asked, 1).answer(ready(TOKEN_3))
    await settled()
    const afterStaleAnswer = tabs.statuses(open())
    heldAsk(asked, 3).answer(ready(TOKEN_3))
    await settled()

    // Assert
    assert.deepEqual(afterStaleAnswer, [])
    assert.deepEqual([heldAsk(asked, 3).tabId, heldAsk(asked, 3).documentId], [OTHER_TAB_ID, 'DOC-3'])
    assert.deepEqual(tabs.statuses(open()), [readyStatus(OTHER_TAB_ID)])
  })

  it('should leave a record alone when the floor rises', async () => {
    // Arrange - tab 41's request #2 is held while another tab is forgotten
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.forget(OTHER_TAB_ID)

    // Act - #2 arrives with another state, and is asked again rather than taken
    heldAsk(asked, 1).answer(ready(TOKEN_1, LEO_NOVAK, false))
    await settled()

    // Assert - tab 41 stays recorded and listed as it was
    assert.deepEqual(tabs.statuses(openTab(tabs)), [readyStatus(TAB_ID)])
    assert.deepEqual(tabs.readyDocument(LEO_NOVAK, openTab(tabs)), {
      tabId: TAB_ID,
      documentId: 'DOC-1',
      token: TOKEN_1,
    })
    assert.deepEqual([asked.length, heldAsk(asked, 2).documentId], [3, 'DOC-1'])
  })

  it("should not record a tab that closed before its document's first answer arrived", async () => {
    // Arrange - DOC-1's first report raised #1, whose answer is held, and the tab closes with no record
    const { tabs, asked } = heldRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.forget(TAB_ID)

    // Act
    heldAsk(asked, 0).answer(ready(TOKEN_1))
    await settled()
    heldAsk(asked, 1).reject()
    await settled()

    // Assert
    assert.deepEqual(tabs.statuses(openTab(tabs)), [])
    assert.deepEqual([asked.length, heldAsk(asked, 1).documentId], [2, 'DOC-1'])
  })

  it("should not put a pruned record's document back from an answer asked before the pruning", async () => {
    // Arrange - #2 to DOC-1 is held; tab 41 navigates off the origin (#3 to DOC-1, held), a status lists no WhatsApp tab
    // and prunes the record, #3 is rejected, and the tab returns showing DOC-2, whose report raises #4
    const { tabs, asked } = await recordedRegistry()
    tabs.reported(TAB_ID, 'DOC-1')
    tabs.tabChanged(TAB_ID, false)
    tabs.statuses(openTabs(tabs, []))
    heldAsk(asked, 2).reject()
    await settled()
    tabs.reported(TAB_ID, 'DOC-2')

    // Act - DOC-1's old answer to #2 is delivered
    heldAsk(asked, 1).answer(ready(TOKEN_1))
    await settled()
    const afterStaleAnswer = tabs.documentOfToken(TOKEN_1, openTab(tabs))
    heldAsk(asked, 4).reject()
    heldAsk(asked, 3).answer(ready(TOKEN_2))
    await settled()

    // Assert
    assert.equal(afterStaleAnswer, null)
    assert.equal(heldAsk(asked, 4).documentId, 'DOC-1')
    assert.deepEqual(tabs.documentOfToken(TOKEN_2, openTab(tabs)), {
      tabId: TAB_ID,
      documentId: 'DOC-2',
      token: TOKEN_2,
    })
  })
})
