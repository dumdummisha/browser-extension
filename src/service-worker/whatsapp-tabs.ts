import { type WhatsAppAccount, type WhatsAppTabStatus } from '../protocol/whatsapp.js'
import { type WhatsAppRelayAnswer, type WhatsAppRelayState, whatsappTabStatusOf } from './whatsapp-observed.js'

// What the service worker knows of each WhatsApp Web tab: a cache of what the tab's document last answered to a request
// pinned to it (U2-R40). Only such an answer makes or replaces a tab's record, since only its arrival shows that this
// document's relay was there to answer. A report, a message from a document or a tab event only makes the worker ask.
// Requests are numbered in the order they are sent, and an answer counts only when its number is higher than that of
// the request that made the tab's record, so an answer that comes late never puts an older one back. Every removal of a
// record, and every tab forgotten, raises a floor under all answers: an answer to a request sent before it is asked
// again instead of being taken, so what was removed is not put back by an answer older than its removal (U2-R46,
// U2-R50). A request Chrome rejects removes the record of the document it was pinned to, and nothing more, so the next
// answer of that document records it again. A request that never settles changes nothing. Nothing awaits a request
// here: not the status, and nothing Slack needs (U2-R30). The registry lives in the worker's memory: a worker that
// starts holds nothing and asks every WhatsApp tab (background.ts askWhatsAppTabs).
//
// The request counter and the floor are integers that stay exact up to Number.MAX_SAFE_INTEGER (2^53 - 1,
// ECMAScript). No limit is set here: a worker that sent one request every microsecond would need 285 years to reach
// it.

export interface IWhatsAppDocument {
  readonly tabId: number
  readonly documentId: string
  readonly token: string
}

// The tabs chrome.tabs.query lists on WHATSAPP_TAB_URL, and the number of the last request the registry had sent when
// that query was made (background.ts openWhatsAppTabs).
export interface IOpenWhatsAppTabs {
  readonly ids: readonly number[]
  readonly asOf: number
}

// A request pinned to one document of a tab (background.ts askWhatsAppDocument). It resolves with the relay's answer,
// read (whatsapp-observed.ts whatsappAnswerOf), rejects when Chrome rejects the request, and may never settle.
export type WhatsAppDocumentAsk = (tabId: number, documentId: string) => Promise<WhatsAppRelayAnswer>

interface IRecord {
  readonly documentId: string
  readonly answer: WhatsAppRelayState
  // The number of the request whose answer made the record.
  readonly number: number
}

type OpenRecord = IRecord & { readonly tabId: number }

// Whether two states read the same. Both are zod's output of one schema, whose keys it writes in the schema's order;
// were that order ever to differ, an equal state would read as changed and push the status once more, nothing worse.
const isSameState = (left: WhatsAppRelayState, right: WhatsAppRelayState): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

export class WhatsAppTabs {
  private readonly records = new Map<number, IRecord>()
  private sent = 0
  // The number of the last request sent when a record was last removed or a tab last forgotten. An answer to a request
  // numbered at or under it was asked before that removal, so it is asked again instead of being taken (see answered).
  private floor = 0

  // askTab: has whatever relay the tab shows now post a report (background.ts askWhatsAppTab); it never throws, and
  // nothing awaits it. onChange: what the status shows may have changed, so it is pushed (background.ts pushStatus).
  constructor(
    private readonly askDocument: WhatsAppDocumentAsk,
    private readonly askTab: (tabId: number) => void,
    private readonly onChange: () => void
  ) {}

  // The number of the last request sent. The open-tab list reads it right before it queries the tabs.
  public requestsSent(): number {
    return this.sent
  }

  // Asks the document with a request pinned to it, and takes what comes of it into the tab's record. Resolves once the
  // request settled, never rejects, and stays pending for as long as the request does.
  public ask(tabId: number, documentId: string): Promise<void> {
    this.sent += 1
    const number = this.sent

    return this.askDocument(tabId, documentId).then(
      (answer) => {
        this.answered(tabId, documentId, number, answer)
      },
      () => {
        this.removeIfMadeBy(tabId, documentId)
      }
    )
  }

  // A report from a WhatsApp tab's document: it is asked (U2-R40 point 2).
  public reported(tabId: number, documentId: string): void {
    void this.ask(tabId, documentId)
  }

  // A new message from a WhatsApp tab's document: asked when it is not the recorded one (U2-R40 point 2).
  public messaged(tabId: number, documentId: string): void {
    if (this.records.get(tabId)?.documentId !== documentId) {
      void this.ask(tabId, documentId)
    }
  }

  // A tab changed (tabs.onUpdated, any field). For a tab that has a record or whose committed URL is on
  // web.whatsapp.com, the recorded document is asked, pinned, and the tab is asked to have whatever relay it shows now
  // report (U2-R40 point 2).
  public tabChanged(tabId: number, isOnOrigin: boolean): void {
    const record = this.records.get(tabId)
    if (record === undefined && !isOnOrigin) {
      return
    }

    if (record !== undefined) {
      void this.ask(tabId, record.documentId)
    }

    this.askTab(tabId)
  }

  // Chrome rejected a command pinned to the document: its record goes if the document made it, and the tab is asked
  // again, so a page that is there is recorded for the next command (U2-R40 point 7).
  public missed({ tabId, documentId }: IWhatsAppDocument): void {
    this.removeIfMadeBy(tabId, documentId)
    this.askTab(tabId)
  }

  // The tab closed, or Chrome replaced it with another (U2-R40 point 5). The caller pushes the status, as onRemoved does
  // for every tab. The floor rises whether or not the tab had a record: an answer of its document that is still on its
  // way must not make one.
  public forget(tabId: number): void {
    this.drop(tabId)
  }

  // The status entries of the open tabs that have a record, in tab id order (U2-R40 point 6).
  public statuses(open: IOpenWhatsAppTabs): WhatsAppTabStatus[] {
    return this.openRecords(open).map(({ tabId, answer }) => whatsappTabStatusOf(tabId, answer))
  }

  // The recorded document of the open tab with the lowest id whose observer answered ready as the account, or null.
  public readyDocument(account: WhatsAppAccount, open: IOpenWhatsAppTabs): IWhatsAppDocument | null {
    for (const { tabId, documentId, answer } of this.openRecords(open)) {
      if (
        answer.state === 'observed' &&
        answer.capture.state === 'ready' &&
        answer.capture.account.wid === account.wid
      ) {
        return { tabId, documentId, token: answer.token }
      }
    }

    return null
  }

  // The recorded document of an open tab whose observer answered the token, or null.
  public documentOfToken(token: string, open: IOpenWhatsAppTabs): IWhatsAppDocument | null {
    for (const { tabId, documentId, answer } of this.openRecords(open)) {
      if (answer.state === 'observed' && answer.token === token) {
        return { tabId, documentId, token }
      }
    }

    return null
  }

  // Whether the tab's record still names the document with that token: a command reads it right before its hand-off.
  public isRecorded({ tabId, documentId, token }: IWhatsAppDocument): boolean {
    const record = this.records.get(tabId)

    return record?.documentId === documentId && record.answer.state === 'observed' && record.answer.token === token
  }

  // An answer to a request sent before the last removal says what was true before it, so the document is asked again
  // and its new answer decides (a document that is gone rejects that request, and nothing is recorded). Otherwise an
  // answer counts only when its number is higher than that of the request that made the tab's record (U2-R40 point 3).
  // not-shown removes the record of the document that answered it and makes none (point 4); any other answer makes or
  // replaces the record.
  private answered(tabId: number, documentId: string, number: number, answer: WhatsAppRelayAnswer): void {
    if (number <= this.floor) {
      void this.ask(tabId, documentId)
      return
    }

    const record = this.records.get(tabId)
    if (record !== undefined && number <= record.number) {
      return
    }

    if (answer.state === 'not-shown') {
      this.removeIfMadeBy(tabId, documentId)
      return
    }

    this.records.set(tabId, { documentId, answer, number })

    if (record?.documentId !== documentId || !isSameState(record.answer, answer)) {
      this.onChange()
    }
  }

  private removeIfMadeBy(tabId: number, documentId: string): void {
    if (this.records.get(tabId)?.documentId !== documentId) {
      return
    }

    this.drop(tabId)
    this.onChange()
  }

  // Removes the tab's record. Every removal raises the floor, so an answer that was asked before it is asked again
  // instead of being taken (see answered).
  private drop(tabId: number): void {
    this.records.delete(tabId)
    this.floor = this.sent
  }

  // The records of the open tabs, in tab id order. A record of a tab not among them that a request sent before the
  // tabs were listed made is removed: its tab closed, or its committed URL left web.whatsapp.com, so its document is
  // not the page its tab shows. A record made after the listing waits for the next one. Removing it changes nothing
  // the status shows, so it pushes nothing; it raises the floor like every removal (U2-R50).
  private openRecords({ ids, asOf }: IOpenWhatsAppTabs): OpenRecord[] {
    const open = new Set(ids)

    for (const [tabId, { number }] of this.records) {
      if (!open.has(tabId) && number <= asOf) {
        this.drop(tabId)
      }
    }

    return [...this.records]
      .filter(([tabId]) => open.has(tabId))
      .toSorted(([left], [right]) => left - right)
      .map(([tabId, record]) => ({ tabId, ...record }))
  }
}
