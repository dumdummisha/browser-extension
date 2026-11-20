import type { ExtensionFrame, HostFrame } from '../protocol/messages.js'

export type BridgeRequest = Extract<HostFrame, { type: 'request' }>
export type BridgeReply = Extract<ExtensionFrame, { type: 'reply' }>

// How a handler learns its caller has given up: the caller's deadline, in milliseconds since the epoch, and a signal
// that aborts when the caller cancelled the request or can no longer take its reply.
export interface IAbandonment {
  readonly deadline: number
  readonly signal: AbortSignal
}

export type RequestHandler = (params: unknown, abandonment: IAbandonment) => unknown

// Throws once the caller has given up, so nothing more of the request is sent.
export const throwIfAbandoned = ({ deadline, signal }: IAbandonment): void => {
  if (signal.aborted || Date.now() >= deadline) {
    throw new Error('The caller gave up on the request before it was sent, so it was not sent')
  }
}

// The reply to one request, from the handler its method names: the Slack methods and the tab methods, whose names
// never overlap (protocol tab.ts). A handler that throws or rejects answers its own request with the error, so a
// failing command never reaches the rest of the service worker: the Slack observer, the pending queue and the other
// requests carry on.
export const answerRequest = async (
  handlers: Readonly<Record<string, RequestHandler>>,
  { id, method, params, deadline }: BridgeRequest,
  signal: AbortSignal
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
    return { type: 'reply', id, result: await handler(params, { deadline, signal }) }
  } catch (error) {
    return { type: 'reply', id, error: error instanceof Error ? error.message : String(error) }
  }
}
