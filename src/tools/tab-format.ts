import { MarkdownBuilder } from '../module/markdown.js'
import { formatBytes } from '../module/support.js'
import type { Download, PageChanges, TabInfo, TabSnapshot } from '../protocol/tab.js'
import type { IActionResult } from './browser-control.js'
import { LISTED_CHANGES } from './config.js'

export const formatTab = ({ tabId, title, url, status }: TabInfo): string =>
  `tab ${tabId}: ${title === '' ? '(untitled)' : title} - ${url}${status === 'complete' ? '' : ` (still ${status})`}`

export const formatSnapshot = ({
  tabId,
  title,
  url,
  scrollY,
  scrollHeight,
  viewportWidth,
  viewportHeight,
  outline,
  isTruncated,
}: TabSnapshot): string => {
  const md = MarkdownBuilder.create()
    .heading(title === '' ? '(untitled)' : title, 2)
    .field('Tab', String(tabId))
    .field('URL', url)
    .field(
      'Scroll',
      `${scrollY} of ${Math.max(scrollHeight - viewportHeight, 0)} px, viewport ${viewportWidth}x${viewportHeight}`
    )
    .blank()
    .text(outline === '' ? '(nothing visible)' : outline)

  if (isTruncated) {
    md.blank().italic('Cut short at the character limit; scroll with tab_scroll to see the rest.')
  }

  return md.build()
}

// After a navigation the new screen is shown; otherwise only the outline lines that appeared (+) and went (-), so a
// menu a click opened or a dialog it raised needs no separate read. Downloads come last.
export const formatAction = ({ tab, changes, downloads }: IActionResult): string =>
  [formatChanges(tab, changes), ...downloads.map(formatDownload)].join('\n')

const formatChanges = (tab: TabInfo, changes: PageChanges): string => {
  if (changes.isNavigated) {
    const repeated =
      changes.repeatedLineCount === 0
        ? ''
        : `\n_${changes.repeatedLineCount} lines at the top and bottom that the previous page had too (its menus) are ` +
          'left out; tab_find gives their new refs._'

    return `Now on ${formatTab(tab)}\n\n${formatSnapshot({ ...changes.snapshot, tabId: tab.tabId })}${repeated}`
  }

  const lines = [...listed(changes.added, '+'), ...listed(changes.removed, '-')]
  const summary = lines.length === 0 ? 'Nothing changed on the page.' : 'Changes on the page:'

  return [`Still on ${formatTab(tab)}`, summary, ...lines].join('\n')
}

const formatDownload = ({ url, filename, state, bytesReceived, error }: Download): string => {
  switch (state) {
    case 'complete':
      return `Downloaded ${filename} (${formatBytes(bytesReceived)}).`
    case 'receiving':
      return `Still downloading ${filename} (${formatBytes(bytesReceived)} so far).`
    case 'interrupted':
      return `The download of ${url} failed: ${error ?? 'no reason given'}.`
    case 'choosingLocation':
      return `The download of ${url} waits for a place to save it.`
  }
}

const listed = (lines: string[], sign: string): string[] => [
  ...lines.slice(0, LISTED_CHANGES).map((line) => `${sign} ${line}`),
  ...(lines.length > LISTED_CHANGES ? [`${sign} ... and ${lines.length - LISTED_CHANGES} more lines`] : []),
]
