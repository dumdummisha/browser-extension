import type { OperationParity, SlackOperation } from '../protocol/slack.js'
import {
  headerFieldsOf,
  type IRequestBody,
  type IRequestHeader,
  type IRequestShape,
  type IStartedShape,
  parityOf,
  requestKeyOf,
  startedShapeOf,
} from './slack-request-shape.js'

// A Slack page's top document, where a page command of the transport runs and where Slack's client sends its own
// requests from.
export interface ISlackPage {
  readonly tabId: number
  readonly documentId: string
}

// A request as webRequest's onBeforeRequest reports it, in the fields the observer reads.
export interface IStartedRequest {
  readonly requestId: string
  readonly tabId: number
  readonly frameId: number
  readonly documentId?: string
  readonly initiator?: string
  readonly method: string
  readonly url: string
  readonly requestBody?: IRequestBody
}

// A request as webRequest's onSendHeaders reports it.
export interface ISentRequest {
  readonly requestId: string
  readonly requestHeaders?: readonly IRequestHeader[]
}

// A request of Misha's the observer is told about before it leaves: the page it runs in and what it is known by
// (slack-request-shape.ts requestKeyOf), for as long as the command that sends it runs, and after that until every
// request that carried its key in that page has ended.
interface IExclusion extends ISlackPage {
  readonly key: string
  // Whether only Misha's request can carry the key: a Web API call's fresh request id, unlike a file's address, which
  // the client may fetch too.
  readonly isKeyUnique: boolean
  // Requests that carried the key, counted as they start: a second one makes the command's request ambiguous for good.
  starts: number
  // The shape of the request that carried the key, once its headers were sent.
  shape: IRequestShape | null
  // Requests that carried the key and have not sent their headers or ended yet.
  inFlight: number
  isReleased: boolean
  // Whether the command's result proves its request reached Slack (slack-page.ts isAnsweredBySlack).
  isAnswered: boolean
}

// A request between its start and its headers: what the rules keep of it, and the command of Misha's it belongs to.
interface IPendingRequest {
  readonly started: IStartedShape | null
  readonly exclusion: IExclusion | null
}

// Where the check of an operation stands: the client's latest request while Misha has sent none (reference), Misha's
// first request while the client has sent none (waiting), or the result, which no later request changes (checked).
type OperationCheck =
  | { readonly state: 'reference'; readonly client: IRequestShape }
  | { readonly state: 'waiting'; readonly misha: IRequestShape }
  | { readonly state: 'checked'; readonly parity: OperationParity }

// What Slack's client sends from its own pages, as the service worker observes it, beside Misha's requests, which run
// in the same pages, for the transport check: the client's latest request of each operation is its reference, and
// Misha's first request of each operation since the service worker started is compared with it once, as soon as both
// are known. The result per operation is a status of names only (protocol slack.ts OperationParitySchema). The query
// a call of Misha's borrows comes from the page's own observer, not from here (client-query-keeper.ts).
// A request is Misha's when it carries the key of a command of Misha's running in that same page. A command whose
// request cannot be told apart (a second request carried its key, whether or not either sent its headers, or it did
// not reach Slack while one did) supplies no shape: neither those requests nor the command count as the client's or as
// Misha's.
export class SlackClientObserver {
  private readonly exclusions = new Set<IExclusion>()
  private readonly pending = new Map<string, IPendingRequest>()
  private readonly checks = new Map<SlackOperation, OperationCheck>()

  // pageOrigin: where the Slack pages are (config.ts SLACK_ORIGIN); a request any other page sends is not the client's.
  // onChange: called each time the check's status changes.
  constructor(
    private readonly pageOrigin: string,
    private readonly onChange: () => void
  ) {}

  // Takes the requests carrying key in page as Misha's until the returned function runs, which the command that sends
  // them calls once it settled, with whether its result proves Slack answered its request.
  public exclude(page: ISlackPage, key: string, isKeyUnique: boolean): (isAnswered: boolean) => void {
    const exclusion: IExclusion = {
      ...page,
      key,
      isKeyUnique,
      starts: 0,
      shape: null,
      inFlight: 0,
      isReleased: false,
      isAnswered: false,
    }
    this.exclusions.add(exclusion)

    return (isAnswered) => {
      this.exclusions.delete(exclusion)
      exclusion.isReleased = true
      exclusion.isAnswered = isAnswered
      this.settleIfDone(exclusion)
    }
  }

  // Only a Slack page's top document is read; a request with no document (a worker's) is not one of the page's. A
  // request id seen again (a redirect) keeps what its start was.
  public requestStarted(request: IStartedRequest): void {
    const { requestId, tabId, frameId, documentId, initiator, method, url, requestBody } = request
    const parsed = URL.parse(url)
    const isPageRequest = initiator === this.pageOrigin && frameId === 0 && documentId !== undefined
    if (parsed === null || !isPageRequest || this.pending.has(requestId)) {
      return
    }

    const key = requestKeyOf(parsed)
    const exclusion = key === null ? undefined : this.exclusionOf({ tabId, documentId }, key)
    const started = startedShapeOf(method, parsed, requestBody)
    if (exclusion !== undefined) {
      exclusion.starts += 1
      exclusion.inFlight += 1
      this.pending.set(requestId, { started, exclusion })
      return
    }

    if (started !== null) {
      this.pending.set(requestId, { started, exclusion: null })
    }
  }

  public headersSent({ requestId, requestHeaders = [] }: ISentRequest): void {
    const request = this.pending.get(requestId)
    this.pending.delete(requestId)
    if (request === undefined) {
      return
    }

    const shape = request.started === null ? null : { ...request.started, headers: headerFieldsOf(requestHeaders) }
    if (request.exclusion !== null) {
      request.exclusion.shape = shape ?? request.exclusion.shape
      this.leave(request.exclusion)
      return
    }

    if (shape !== null) {
      this.clientSent(shape)
    }
  }

  // A request that completed or failed: one that never sent its headers (a failure, a response from the cache)
  // supplies no shape.
  public requestEnded(requestId: string): void {
    const exclusion = this.pending.get(requestId)?.exclusion
    this.pending.delete(requestId)
    if (exclusion !== undefined && exclusion !== null) {
      this.leave(exclusion)
    }
  }

  // The check per operation Misha sent, in the operations' order: unchecked while the client has not sent it.
  public parity(): OperationParity[] {
    return [...this.checks]
      .flatMap(([operation, check]): OperationParity[] => {
        if (check.state === 'reference') {
          return []
        }

        return [check.state === 'waiting' ? { operation, state: 'unchecked' } : check.parity]
      })
      .toSorted((first, second) => (first.operation < second.operation ? -1 : 1))
  }

  private exclusionOf(page: ISlackPage, key: string): IExclusion | undefined {
    return [...this.exclusions].find(
      (exclusion) => exclusion.tabId === page.tabId && exclusion.documentId === page.documentId && exclusion.key === key
    )
  }

  private leave(exclusion: IExclusion): void {
    exclusion.inFlight -= 1
    this.settleIfDone(exclusion)
  }

  // Once the command settled and its requests ended, its request's shape is Misha's only when exactly one request
  // carried its key, and either only Misha's request can carry it, so the shape counts whatever Slack answered (a call
  // CORS refused or answered 429 included), or Slack answered the command.
  private settleIfDone({ isReleased, inFlight, isKeyUnique, isAnswered, starts, shape }: IExclusion): void {
    if (!isReleased || inFlight > 0 || !(isKeyUnique || isAnswered) || starts !== 1 || shape === null) {
      return
    }

    this.mishaSent(shape)
  }

  private clientSent(client: IRequestShape): void {
    const check = this.checks.get(client.operation)
    if (check?.state === 'checked') {
      return
    }

    if (check?.state === 'waiting') {
      this.check(client, check.misha)
      return
    }

    this.checks.set(client.operation, { state: 'reference', client })
  }

  private mishaSent(misha: IRequestShape): void {
    const check = this.checks.get(misha.operation)
    if (check?.state === 'reference') {
      this.check(check.client, misha)
      return
    }

    if (check === undefined) {
      this.checks.set(misha.operation, { state: 'waiting', misha })
      this.onChange()
    }
  }

  private check(client: IRequestShape, misha: IRequestShape): void {
    this.checks.set(misha.operation, { state: 'checked', parity: parityOf(client, misha) })
    this.onChange()
  }
}
