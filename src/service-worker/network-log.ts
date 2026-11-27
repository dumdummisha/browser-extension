import type { NetworkRequest } from '../protocol/tab.js'
import { type IRequestHeader, redactBody, redactHeaders, redactUrl } from './request-redaction.js'

// The log keeps the latest requests of each tab, and a request body up to this many characters, so a page that polls
// or uploads cannot grow the service worker without bound.
export const NETWORK_LOG_LIMIT = 200
export const NETWORK_BODY_MAX_CHARS = 20_000

export interface IStartedRequest {
  readonly startedAt: number
  readonly method: string
  readonly url: string
  // The body as it went out, decoded to text; null when it had none.
  readonly body: string | null
}

type RequestOutcome = { readonly statusCode: number } | { readonly error: string }

// The fetch and XHR requests each tab sent, by request id in the order they started, for tab_network. Every request is
// redacted as it is recorded, so the log never holds a credential and nothing it answers carries one. A body is cut to
// NETWORK_BODY_MAX_CHARS first and redacted as far as it goes.
export class NetworkLog {
  private readonly logs = new Map<number, Map<string, NetworkRequest>>()

  public started(tabId: number, requestId: string, { startedAt, method, url, body }: IStartedRequest): void {
    const log = this.logs.get(tabId) ?? new Map<string, NetworkRequest>()
    log.delete(requestId)

    log.set(requestId, {
      startedAt,
      method,
      url: redactUrl(url),
      body: body === null ? null : redactBody(body.slice(0, NETWORK_BODY_MAX_CHARS)),
      isBodyTruncated: (body?.length ?? 0) > NETWORK_BODY_MAX_CHARS,
      headers: [],
      statusCode: null,
      error: null,
    })

    const [oldest] = log.keys()
    if (log.size > NETWORK_LOG_LIMIT && oldest !== undefined) {
      log.delete(oldest)
    }

    this.logs.set(tabId, log)
  }

  public sentHeaders(tabId: number, requestId: string, headers: readonly IRequestHeader[]): void {
    this.update(tabId, requestId, { headers: redactHeaders(headers) })
  }

  public ended(tabId: number, requestId: string, outcome: RequestOutcome): void {
    this.update(tabId, requestId, outcome)
  }

  public requests(tabId: number): NetworkRequest[] {
    return [...(this.logs.get(tabId)?.values() ?? [])]
  }

  public forget(tabId: number): void {
    this.logs.delete(tabId)
  }

  private update(tabId: number, requestId: string, change: Partial<NetworkRequest>): void {
    const log = this.logs.get(tabId)
    const request = log?.get(requestId)
    if (log !== undefined && request !== undefined) {
      log.set(requestId, { ...request, ...change })
    }
  }
}
