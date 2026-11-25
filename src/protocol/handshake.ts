import { z } from 'zod'
import {
  type BridgeIncompatible,
  type BridgeLeg,
  type BridgeRole,
  BridgeRoleSchema,
  HelloEnvelopeSchema,
  type IncompatibilityReason,
  PROTOCOL_REVISION,
  type RecoveryCode,
} from './messages.js'

// The handshake every leg opens with (messages.ts). Each end installs its listeners, then sends its hello at once, and
// reads the other end's first message:
// - awaiting-hello: only a hello, a diagnostic and the host's extension-leg state may come. A hello of the same
//   revision moves the leg to ready; anything else makes it incompatible.
// - ready: normal traffic flows. A second hello is a protocol failure, never a renegotiation.
// - incompatible: no normal traffic in either direction, and every waiting caller fails with the diagnostic. The end
//   keeps the connection, so the diagnostic stays readable, until the other end closes it.
// - closed: the transport ended. An end that learned of an incompatibility keeps it until a later complete handshake
//   agrees.
export type ConnectionState = 'awaiting-hello' | 'ready' | 'incompatible' | 'closed'

// One end of a leg, as its hello and its diagnostics name it.
export interface IHandshakeEnd {
  readonly role: BridgeRole
  readonly componentVersion: string
}

export type HelloReading<THello> =
  | { readonly kind: 'agreed'; readonly hello: THello }
  | { readonly kind: 'incompatible'; readonly diagnostic: BridgeIncompatible }

// What the user does about each recovery code, as the extension's title, the app and the tools show it.
export const RECOVERY_TEXT: Readonly<Record<RecoveryCode, string>> = {
  'update-extension':
    'Update Misha Browser in Chrome, then reload the extension. If Chrome has not received it yet, wait for the store update.',
  'update-app': 'Update Misha, then restart the browser to restart its native host.',
  'restart-browser-and-app': 'Restart the browser and Misha. If they still disagree, install the latest Misha.',
  'versions-unchecked':
    'The browser bridge versions could not be checked. Update Misha and Misha Browser, then restart the browser.',
}

const LEG_TEXT: Readonly<Record<BridgeLeg, string>> = {
  'extension-host': 'Misha Browser and its native host',
  'host-client': 'the native host and its client',
}

const REASON_TEXT: Readonly<Record<IncompatibilityReason, string>> = {
  'revision-mismatch': 'they speak different protocol revisions',
  'missing-hello': 'one of them did not say which protocol revision it speaks in time',
  'malformed-hello': 'the hello of one of them does not read',
  'unexpected-frame': 'one of them sent a message where only a hello may come',
}

const PeerFieldsSchema = z.object({
  role: z.unknown(),
  protocolRevision: z.unknown(),
  componentVersion: z.unknown(),
})

// What the other end's message said about it, each value only when it reads.
const peerOf = (raw: unknown): BridgeIncompatible['peer'] => {
  const fields = PeerFieldsSchema.partial().safeParse(raw)
  if (!fields.success) {
    return {}
  }

  const role = BridgeRoleSchema.safeParse(fields.data.role)
  const protocolRevision = z.number().int().safeParse(fields.data.protocolRevision)
  const componentVersion = z.string().safeParse(fields.data.componentVersion)

  return {
    ...(role.success ? { role: role.data } : {}),
    ...(protocolRevision.success ? { protocolRevision: protocolRevision.data } : {}),
    ...(componentVersion.success ? { componentVersion: componentVersion.data } : {}),
  }
}

// On the native leg the older end is updated: the extension through the store, the host with the app that installs
// it. On the socket leg the client and the host both come with the app, so a restart brings them to the same build.
const recoveryOf = (
  reason: IncompatibilityReason,
  leg: BridgeLeg,
  local: IHandshakeEnd,
  peerRevision: number | undefined
): RecoveryCode => {
  if (reason !== 'revision-mismatch' || peerRevision === undefined) {
    return 'versions-unchecked'
  }

  if (leg === 'host-client') {
    return 'restart-browser-and-app'
  }

  const extensionRevision = local.role === 'extension' ? PROTOCOL_REVISION : peerRevision
  const hostRevision = local.role === 'extension' ? peerRevision : PROTOCOL_REVISION

  return extensionRevision < hostRevision ? 'update-extension' : 'update-app'
}

// The diagnostic local sends and keeps when a leg fails, with what the other end's message raw said about it.
export const incompatibility = (
  reason: IncompatibilityReason,
  leg: BridgeLeg,
  local: IHandshakeEnd,
  raw: unknown
): BridgeIncompatible => {
  const peer = peerOf(raw)

  return {
    type: 'bridge-incompatible',
    reason,
    leg,
    local: { role: local.role, protocolRevision: PROTOCOL_REVISION, componentVersion: local.componentVersion },
    peer,
    recovery: recoveryOf(reason, leg, local, peer.protocolRevision),
  }
}

// Whether a message is a hello of any revision, readable or not.
export const isHello = (raw: unknown): boolean => z.object({ type: z.literal('hello') }).safeParse(raw).success

// Reads the other end's first message as its hello. The revision is read as an integer and compared before the rest,
// so a hello of another revision is a mismatch whatever its other fields; a hello with no revision, or whose fields do
// not read as schema, is malformed; anything that is not a hello is unexpected.
export const readHello = <TSchema extends z.ZodType>(
  raw: unknown,
  schema: TSchema,
  local: IHandshakeEnd,
  leg: BridgeLeg
): HelloReading<z.output<TSchema>> => {
  if (!isHello(raw)) {
    return { kind: 'incompatible', diagnostic: incompatibility('unexpected-frame', leg, local, raw) }
  }

  const envelope = HelloEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    return { kind: 'incompatible', diagnostic: incompatibility('malformed-hello', leg, local, raw) }
  }

  if (envelope.data.protocolRevision !== PROTOCOL_REVISION) {
    return { kind: 'incompatible', diagnostic: incompatibility('revision-mismatch', leg, local, raw) }
  }

  const hello = schema.safeParse(raw)

  return hello.success
    ? { kind: 'agreed', hello: hello.data }
    : { kind: 'incompatible', diagnostic: incompatibility('malformed-hello', leg, local, raw) }
}

// The diagnostic as one sentence for a person: which ends, why, and what to do.
export const incompatibilityMessage = ({ leg, reason, recovery }: BridgeIncompatible): string =>
  `The browser bridge between ${LEG_TEXT[leg]} cannot be used: ${REASON_TEXT[reason]}. ${RECOVERY_TEXT[recovery]}`
