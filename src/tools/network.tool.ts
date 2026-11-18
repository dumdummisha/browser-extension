import { z } from 'zod'
import { MarkdownBuilder } from '../module/markdown.js'
import type { IToolDefinition } from '../module/tool.js'
import type { NetworkRequest } from '../protocol/tab.js'
import type { BrowserControlService } from './browser-control.js'
import { NETWORK_DEFAULT_LAST, TAB_ID_ARG_DESCRIPTION } from './config.js'

const input = z.object({
  tabId: z.number().int().optional().describe(TAB_ID_ARG_DESCRIPTION),
  urlContains: z
    .string()
    .min(1)
    .optional()
    .describe('Keep only the requests whose URL contains this text, such as an API host or path. Defaults to all.'),
  includeHeaders: z
    .boolean()
    .optional()
    .describe(
      'Also list each request header. Cookie, Authorization and every other credential header show as [redacted]. ' +
        'Defaults to false.'
    ),
  last: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`How many of the latest matching requests to list. Defaults to ${NETWORK_DEFAULT_LAST}.`),
})

export const createNetworkTool = (browser: Pick<BrowserControlService, 'network'>): IToolDefinition<typeof input> => ({
  description:
    "List the fetch and XHR requests a tab in the user's browser sent, oldest first: method, URL, status and request " +
    'body, and with includeHeaders the request headers. The response body is not recorded. Use it to learn the API ' +
    'a web app calls: act on the page with tab_click, tab_fill or tab_type, then read what that sent. Credentials ' +
    'are redacted in the browser before a request leaves it: a body field (form, JSON or multipart), query parameter ' +
    'or header named like a token, password, secret, API key or authorization, and any value shaped like a known ' +
    'token, key or Bearer value, shows as [redacted] with its name kept. The extension keeps the latest 200 requests ' +
    'of each tab since it started; a request sent before that, or by a page load rather than a script, is not listed.',
  input,
  execute: async ({ tabId, urlContains, includeHeaders = false, last = NETWORK_DEFAULT_LAST }) => {
    const { tabId: loggedTabId, requests } = await browser.network(tabId)
    const matching = requests.filter(({ url }) => urlContains === undefined || url.includes(urlContains))
    if (matching.length === 0) {
      return `Tab ${loggedTabId} has no recorded requests${urlContains === undefined ? '' : ` whose URL contains "${urlContains}"`}.`
    }

    const md = MarkdownBuilder.create().text(
      `Tab ${loggedTabId}: the last ${Math.min(last, matching.length)} of ${matching.length} matching requests.`
    )
    for (const request of matching.slice(-last)) {
      appendRequest(md, request, includeHeaders)
    }

    return md.build()
  },
})

const appendRequest = (md: MarkdownBuilder, request: NetworkRequest, includeHeaders: boolean): void => {
  md.heading(`${request.method} ${request.url}`, 3)
    .field('Sent', new Date(request.startedAt).toISOString())
    .field('Outcome', outcome(request))
  if (request.body !== null) {
    md.text(request.isBodyTruncated ? 'Body (truncated):' : 'Body:').codeBlock(request.body)
  }

  if (includeHeaders) {
    md.text('Headers:').codeBlock(request.headers.map(({ name, value }) => `${name}: ${value}`).join('\n'))
  }
}

const outcome = ({ statusCode, error }: NetworkRequest): string => {
  if (error !== null) {
    return `failed (${error})`
  }

  return statusCode === null ? 'still in flight' : String(statusCode)
}
