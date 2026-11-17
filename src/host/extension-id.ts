import { createHash } from 'node:crypto'

const ID_LENGTH = 32
const HEX_DIGITS = '0123456789abcdef'
const ID_ALPHABET = 'abcdefghijklmnop'

// Chrome derives an unpacked extension's id from the manifest's public key: the first 32 hex digits of the SHA-256 of
// the DER key, each digit 0-f spelled as a letter a-p.
export const extensionIdFromKey = (base64Key: string): string =>
  Array.from(createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, ID_LENGTH), (digit) =>
    ID_ALPHABET.charAt(HEX_DIGITS.indexOf(digit))
  ).join('')
