import type {
  Download,
  FieldContent,
  PageFind,
  PageFindMatch,
  PageSnapshot,
  TabBridgeMethod,
  TabBridgeResult,
  TabInfo,
} from '../protocol/tab.js'
import { redactLines, redactText, redactUrl } from './request-redaction.js'

// What each tab command answers, redacted at the one place it leaves the service worker: every URL as a URL, and every
// page-derived text (titles, outlines, matches, changed lines, field values, element briefs, option labels, download
// names) by the known credential shapes (request-redaction.ts). The commands work on the raw page: a change report
// compares raw lines and a search matches the raw outline, and they hand over the whole outlines they selected lines
// from, so a line is redacted with the context a shape spans, such as the BEGIN line above a private key's body line.
// Every method needs an entry; one with no page text in its answer passes it on, and screenshots stay as captured.
// The table covers a new method, not a new text field in an existing answer: that needs its entry changed too.

// A change report before redaction: the outlines whose lines it reports, with the places of the lines that appeared
// (in after) and went (in before); or, after a navigation, the new screen and the range of its lines that are new.
type RawChanges =
  | {
      readonly isNavigated: false
      readonly before: readonly string[]
      readonly after: readonly string[]
      readonly added: readonly number[]
      readonly removed: readonly number[]
    }
  | {
      readonly isNavigated: true
      readonly snapshot: PageSnapshot
      readonly freshStart: number
      readonly freshEnd: number
    }

// What a tab command hands the boundary: its answer, or for changes and find the raw page it is redacted from.
export type RawTabResult<TMethod extends TabBridgeMethod> = TMethod extends 'changes'
  ? RawChanges
  : TMethod extends 'find'
    ? PageFind
    : TabBridgeResult<TMethod>

type TabResultRedactions = {
  readonly [TMethod in TabBridgeMethod]: (raw: RawTabResult<TMethod>) => TabBridgeResult<TMethod>
}

const LINE_SEPARATOR = '\n'
const SECTION_INDENT = '  '

const unchanged = <TResult>(result: TResult): TResult => result

// The places a command hands over come from the same read as the lines, so one that is not there is a broken read.
const itemAt = <TItem>(items: readonly TItem[], index: number): TItem => {
  const item = items[index]
  if (item === undefined) {
    throw new Error(`The page answered item ${index} of a list of ${items.length}.`)
  }

  return item
}

const redactTab = <TTab extends Pick<TabInfo, 'title' | 'url'>>(tab: TTab): TTab => ({
  ...tab,
  title: redactText(tab.title),
  url: redactUrl(tab.url),
})

const redactSnapshot = <TSnapshot extends PageSnapshot>(snapshot: TSnapshot): TSnapshot => ({
  ...snapshot,
  title: redactText(snapshot.title),
  url: redactUrl(snapshot.url),
  outline: redactText(snapshot.outline),
})

const redactContent = (content: FieldContent): FieldContent =>
  content.isMasked ? content : { ...content, value: redactText(content.value) }

const redactDownload = (download: Download): Download => ({
  ...download,
  url: redactUrl(download.url),
  filename: redactText(download.filename),
})

const redactChanges = (raw: RawChanges): TabBridgeResult<'changes'> => {
  if (!raw.isNavigated) {
    const before = redactLines(raw.before)
    const after = redactLines(raw.after)

    return {
      isNavigated: false,
      added: raw.added.map((line) => itemAt(after, line)),
      removed: raw.removed.map((line) => itemAt(before, line)),
    }
  }

  const lines = redactText(raw.snapshot.outline).split(LINE_SEPARATOR)
  const fresh = lines.slice(raw.freshStart, raw.freshEnd)

  return {
    isNavigated: true,
    snapshot: { ...redactSnapshot(raw.snapshot), outline: fresh.join(LINE_SEPARATOR) },
    repeatedLineCount: lines.length - fresh.length,
  }
}

const redactFind = ({ outline, sections, matches, isTruncated }: PageFind): TabBridgeResult<'find'> => {
  const lines = redactLines(outline)
  const sectionLines = sections.map(redactLines)

  const answered = (match: PageFindMatch): string => {
    switch (match.kind) {
      case 'line':
        return itemAt(lines, match.line)
      case 'sectionLine':
        return `${SECTION_INDENT}${itemAt(itemAt(sectionLines, match.section), match.line)}`
      case 'moreLines':
        return `${SECTION_INDENT}... and ${match.count} more lines`
    }
  }

  return { matches: matches.map(answered), isTruncated }
}

export const TAB_RESULT_REDACTIONS: TabResultRedactions = {
  listTabs: (windows) => windows.map((window) => ({ ...window, tabs: window.tabs.map(redactTab) })),
  focusTab: redactTab,
  openTab: redactTab,
  closeTab: unchanged,
  mark: unchanged,
  settle: redactTab,
  changes: redactChanges,
  downloads: (downloads) => downloads.map(redactDownload),
  // A screenshot is the page's pixels as captured: no text to redact, and it shows any credential the page shows.
  screenshot: unchanged,
  // The network log redacts each request as it records it (network-log.ts).
  network: unchanged,
  snapshot: redactSnapshot,
  find: redactFind,
  locate: unchanged,
  pointer: (pointer) => ({ ...pointer, under: redactText(pointer.under) }),
  field: (field) => ({
    ...field,
    focusedElement: redactText(field.focusedElement),
    content: redactContent(field.content),
  }),
  selectOption: ({ label }) => ({ label: redactText(label) }),
  selectContent: unchanged,
  hasFocus: unchanged,
}
