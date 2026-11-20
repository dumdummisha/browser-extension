import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type IStartedRequest, SlackClientObserver } from './slack-client-observer.js'

const SLACK_ORIGIN = 'https://app.slack.com'
const PAGE = { tabId: 7, documentId: 'DOC-A' }
const API_ORIGIN = 'https://example.slack.com'
// Web API calls of Slack's client, with made-up values.
const CLIENT_COUNTS = `${API_ORIGIN}/api/client.counts?_x_id=0f1e2d3c-1794900000.100&_x_csid=example-csid&slack_route=T0EXAMPLE1&_x_num_retries=0`
const CLIENT_HISTORY = `${API_ORIGIN}/api/conversations.history?_x_id=1a2b3c4d-1794900002.000&_x_csid=other-csid&slack_route=T0EXAMPLE1`

const started = (url: string, request: Partial<IStartedRequest> = {}): IStartedRequest => ({
  tabId: PAGE.tabId,
  frameId: 0,
  documentId: PAGE.documentId,
  initiator: SLACK_ORIGIN,
  url,
  ...request,
})

describe('[service-worker] Slack client observer - borrowed query', () => {
  it("should lend the query of the page client's latest Web API call, by the API's origin", () => {
    // Arrange
    const observer = new SlackClientObserver(SLACK_ORIGIN)
    const otherApi = 'https://other.slack.com/api/client.counts?_x_id=2b3c4d5e-1794900003.000&slack_route=T0OTHER001'

    // Act
    observer.requestStarted(started(CLIENT_COUNTS))
    observer.requestStarted(started(otherApi))
    observer.requestStarted(started(CLIENT_HISTORY))

    // Assert
    assert.deepEqual(
      [...observer.clientQueries(PAGE)],
      [
        [
          API_ORIGIN,
          [
            ['_x_id', null],
            ['_x_csid', 'other-csid'],
            ['slack_route', 'T0EXAMPLE1'],
          ],
        ],
        [
          'https://other.slack.com',
          [
            ['_x_id', null],
            ['slack_route', 'T0OTHER001'],
          ],
        ],
      ]
    )
  })

  it('should lend nothing from a request another site, a subframe or a worker sent', () => {
    // Arrange
    const observer = new SlackClientObserver(SLACK_ORIGIN)

    // Act
    observer.requestStarted(started(CLIENT_COUNTS, { initiator: 'https://attacker.example' }))
    observer.requestStarted(started(CLIENT_COUNTS, { frameId: 3 }))
    observer.requestStarted(started(CLIENT_COUNTS, { documentId: undefined }))

    // Assert
    assert.equal(observer.clientQueries(PAGE).size, 0)
  })

  it("should take a request carrying a running command's key in that page as Misha's, and lend nothing from it", () => {
    // Arrange
    const observer = new SlackClientObserver(SLACK_ORIGIN)
    const otherPage = { tabId: 8, documentId: 'DOC-B' }
    observer.exclude(PAGE, '0f1e2d3c-1794900000.100')

    // Act
    observer.requestStarted(started(CLIENT_COUNTS))
    observer.requestStarted(started(CLIENT_COUNTS, otherPage))

    // Assert
    assert.deepEqual([observer.clientQueries(PAGE).size, observer.clientQueries(otherPage).size], [0, 1])
  })

  it("should take a request as the client's again once the command released its key", () => {
    // Arrange
    const observer = new SlackClientObserver(SLACK_ORIGIN)
    const release = observer.exclude(PAGE, '0f1e2d3c-1794900000.100')

    // Act
    release()
    observer.requestStarted(started(CLIENT_COUNTS))

    // Assert
    assert.equal(observer.clientQueries(PAGE).size, 1)
  })

  it("should keep a page's queries to its document, and drop them with the tab", () => {
    // Arrange
    const observer = new SlackClientObserver(SLACK_ORIGIN)
    const reloaded = { ...PAGE, documentId: 'DOC-A2' }
    observer.requestStarted(started(CLIENT_COUNTS))

    // Act
    const beforeReload = observer.clientQueries(reloaded).size
    observer.requestStarted(started(CLIENT_HISTORY, reloaded))
    const afterReload = [observer.clientQueries(PAGE).size, observer.clientQueries(reloaded).size]
    observer.forget(PAGE.tabId)

    // Assert
    assert.deepEqual([beforeReload, afterReload, observer.clientQueries(reloaded).size], [0, [0, 1], 0])
  })
})
