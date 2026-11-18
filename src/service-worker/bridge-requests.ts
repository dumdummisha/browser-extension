import type { ExtensionFrame, HostFrame } from '../protocol/messages.js'

export type BridgeRequest = Extract<HostFrame, { type: 'request' }>
export type BridgeReply = Extract<ExtensionFrame, { type: 'reply' }>
export type RequestHandler = (params: unknown) => unknown

// The reply to one request, from the handler its method names: the Slack methods and the tab methods, whose names
// never overlap (protocol tab.ts). A handler that throws or rejects answers its own request with the error, so a
// failing command never reaches the rest of the service worker: the Slack observer, the pending queue and the other
// requests carry on.
export const answerRequest = async (
  handlers: Readonly<Record<string, RequestHandler>>,
  { id, method, params }: BridgeRequest
): Promise<BridgeReply> => {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined
  if (handler === undefined) {
    return {
      type: 'reply',
      id,
      error: `This extension does not know ${method}; it is older than its client. Reload it.`,
    }
  }

  try {
    return { type: 'reply', id, result: await handler(params) }
  } catch (error) {
    return { type: 'reply', id, error: error instanceof Error ? error.message : String(error) }
  }
}
