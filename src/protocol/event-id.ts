import { z } from 'zod'

// The longest event id the extension admits, for every platform: far longer than any real key (an account id, a
// conversation id and a message id come to under 100 characters), and short enough that the ack naming it always fits
// a native message (framing.ts HOST_MESSAGE_MAX_BYTES).
export const EVENT_ID_MAX_LENGTH = 1024

export const EventIdSchema = z.string().max(EVENT_ID_MAX_LENGTH)
