import { type BorrowedQuery, borrowedQueryOf } from './borrowed-query.js'

// The client query a Slack page's observer keeps (extension/observer.ts): per workspace API, the borrowed fields of the
// latest Web API call of Slack's own client the page's resource timing reported, cut down by borrowedQueryOf as each
// entry is read. The observer runs from document_start for the document's lifetime, so what it keeps survives a service
// worker restart and an extension reload, and a relay asks it for a channel of its own (capture-handshake.ts). It lives
// with the extension's modules the tests load, since the build replaces the compiled extension folder with its bundles.
//
// An entry exists once its response has ended, and reaches the observer in a queued callback, so the kept query is that
// of the latest client call the observer has been told of, which can lag a call that is still running. Slack's client
// sends its Web API calls with XMLHttpRequest and Misha's page command with fetch (slack-page.ts), so only XHR entries
// count: should Slack's client move its calls to fetch, nothing would be kept, and Misha's calls would fail with
// no-client-query. borrowedQueryOf runs on the page's built-ins as they are when an entry comes, which a page script
// could replace; page scripts are out of scope (observer.ts), and the relay checks every query it brings with the same
// rules in its own world (observed-message.ts).
const { create, hasOwn, keys } = Object
const parseUrl = URL.parse
const CLIENT_INITIATOR = 'xmlhttprequest'

// One resource timing entry as the observer reads it: its initiator type and start time, and its URL (its name), which
// is read only for an entry of the client's XHR.
export interface IResourceEntry {
  readonly initiatorType: string
  readonly startTime: number
  readonly url: () => unknown
}

// A kept query whose values changed, which the observer posts to its relays.
export interface IClientQueryChange {
  readonly origin: string
  readonly query: BorrowedQuery
}

export interface IClientQueryKeeper {
  // Reads an entry, and answers the change it made to the query kept for its API, or null when it changed no value.
  readonly take: (entry: IResourceEntry) => IClientQueryChange | null
  // Every kept query, by the API's origin.
  readonly queries: () => Readonly<Record<string, BorrowedQuery>>
}

const isSameQuery = (kept: BorrowedQuery, query: BorrowedQuery): boolean =>
  kept.length === query.length &&
  kept.every(([name, value], index) => query[index]?.[0] === name && query[index][1] === value)

// The API origin and borrowed query of an entry of a client's Web API call; null for any other entry.
const clientCallOf = ({ initiatorType, url }: IResourceEntry): IClientQueryChange | null => {
  if (initiatorType !== CLIENT_INITIATOR) {
    return null
  }

  const name = url()
  const parsed = typeof name === 'string' ? parseUrl(name) : null
  const query = parsed === null ? null : borrowedQueryOf(parsed)

  return parsed === null || query === null ? null : { origin: parsed.origin, query }
}

// An entry replaces the kept query of its API when it started no earlier than the call the kept one came from: a call
// that started earlier but ended later never replaces a newer one, and of two that started at the same (coarsened) time
// the one delivered later wins. The kept start time moves on with every entry that replaces it, even when the values
// stay the same, so a call that started in between is no newer than what is kept. What is kept is kept in objects
// without a prototype, where no setter a page script defined can run.
export const keepClientQueries = (): IClientQueryKeeper => {
  const kept = create(null) as Record<string, { readonly startTime: number; readonly query: BorrowedQuery }>

  return {
    take: (entry) => {
      const call = clientCallOf(entry)
      if (call === null) {
        return null
      }

      const { origin, query } = call
      const { startTime } = entry
      const previous = hasOwn(kept, origin) ? kept[origin] : undefined
      if (previous !== undefined && startTime < previous.startTime) {
        return null
      }

      kept[origin] = { startTime, query }

      return previous !== undefined && isSameQuery(previous.query, query) ? null : call
    },
    queries: () => {
      const queries = create(null) as Record<string, BorrowedQuery>
      for (const origin of keys(kept)) {
        const known = kept[origin]
        if (known !== undefined) {
          queries[origin] = known.query
        }
      }

      return queries
    },
  }
}
