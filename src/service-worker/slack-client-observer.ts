import { type BorrowedQuery, borrowedQueryOf, requestKeyOf } from './slack-request-shape.js'

// A Slack page's top document, where a page command of the transport runs and where Slack's client sends its own
// requests from.
export interface ISlackPage {
  readonly tabId: number
  readonly documentId: string
}

// A request as webRequest's onBeforeRequest reports it, in the fields the observer reads.
export interface IStartedRequest {
  readonly tabId: number
  readonly frameId: number
  readonly documentId?: string
  readonly initiator?: string
  readonly url: string
}

// A request of Misha's the observer is told about before it leaves: the page it runs in and what it is known by
// (slack-request-shape.ts requestKeyOf), for as long as the command that sends it runs.
interface IExclusion extends ISlackPage {
  readonly key: string
}

interface IPageQueries {
  readonly documentId: string
  // By the origin of the workspace API the client called.
  readonly byOrigin: Map<string, BorrowedQuery>
}

// What Slack's client sends from its own pages, as the service worker observes it, never Misha's requests, which run
// in the same pages: each page's latest Web API call lends the transport its query (slack-request-shape.ts). A request
// is the client's unless it carries the key of a command of Misha's running in that same page.
export class SlackClientObserver {
  private readonly exclusions = new Set<IExclusion>()
  private readonly queries = new Map<number, IPageQueries>()

  // pageOrigin: where the Slack pages are (config.ts SLACK_ORIGIN); a request any other page sends is not the client's.
  constructor(private readonly pageOrigin: string) {}

  // Takes a request carrying key in page as Misha's until the returned function runs, which the command that sends it
  // calls once it settled, whether it succeeded or failed.
  public exclude(page: ISlackPage, key: string): () => void {
    const exclusion = { ...page, key }
    this.exclusions.add(exclusion)

    return () => {
      this.exclusions.delete(exclusion)
    }
  }

  // Only a Slack page's top document is read; a request with no document (a worker's) is not one of the page's.
  public requestStarted({ tabId, frameId, documentId, initiator, url }: IStartedRequest): void {
    const parsed = URL.parse(url)
    if (parsed === null || initiator !== this.pageOrigin || frameId !== 0 || documentId === undefined) {
      return
    }

    const key = requestKeyOf(parsed)
    if (key !== null && this.isMisha({ tabId, documentId }, key)) {
      return
    }

    const borrowed = borrowedQueryOf(parsed)
    if (borrowed !== null) {
      const known = this.queries.get(tabId)
      const page = known?.documentId === documentId ? known : { documentId, byOrigin: new Map<string, BorrowedQuery>() }
      page.byOrigin.set(parsed.origin, borrowed)
      this.queries.set(tabId, page)
    }
  }

  // The query each workspace API's latest client call in the page lent, by the API's origin; none for a page whose
  // client the observer has not seen call the Web API since the service worker started.
  public clientQueries({ tabId, documentId }: ISlackPage): ReadonlyMap<string, BorrowedQuery> {
    const known = this.queries.get(tabId)

    return known?.documentId === documentId ? known.byOrigin : new Map()
  }

  public forget(tabId: number): void {
    this.queries.delete(tabId)
  }

  private isMisha(page: ISlackPage, key: string): boolean {
    return [...this.exclusions].some(
      (exclusion) => exclusion.tabId === page.tabId && exclusion.documentId === page.documentId && exclusion.key === key
    )
  }
}
