// The WhatsApp field rules the page-world observer needs, without zod, so the observer bundle carries no schema
// library. whatsapp.ts builds its schemas on them.

// A user's wid as the page serialises it: digits, then the server (probe P1). The account is always its lid wid; a
// direct chat is keyed by a lid wid or, for a few chats, by the phone-number wid (@c.us).
export const LID_USER_WID_PATTERN = /^\d+@lid$/u
export const DIRECT_CHAT_WID_PATTERN = /^\d+@(?:lid|c\.us)$/u

// A message key's own id (key.id, never the key's toString, which adds _out to an outgoing key): upper-case letters,
// digits and '-'. Probe P2: nearly every id was upper hex; P2b: a business's interactive message had digits and '-'.
// No id held '/', which separates the parts of an event id, or '_'. Ids of several lengths were seen, so the length is
// bounded by the event id's own maximum (whatsapp.ts WhatsAppMessageIdSchema), not by those.
export const MESSAGE_ID_PATTERN = /^[0-9A-Z-]+$/u

// The message types a person's message has in a direct chat (U2-R12): text (chat) and the media a person sends.
// image, video and document were seen in a real tab (probe P4); audio, ptt and sticker did not occur there and
// are WhatsApp's long-standing names for those media, an assumption until a message of each is seen. album (its items
// are messages of their own), interactive, call_log, e2e_notification, notification_template, protocol, ciphertext,
// biz_content_placeholder and every other type never leave the page.
export const WHATSAPP_MESSAGE_TYPES = ['chat', 'image', 'video', 'document', 'audio', 'ptt', 'sticker'] as const

// The one type whose text is its body. Every other reported type is media, whose text is its caption, empty when it
// has none, and never its body, which for media holds encoded data (probe P4).
export const WHATSAPP_TEXT_TYPE = 'chat'
