import { readFileSync } from 'node:fs'
import { z } from 'zod'

// The package's version, which the native host and the client name in their hellos (protocol messages.ts). The
// extension names its manifest's, which the build sets from the same field (scripts/build-extension.js).
const PackageSchema = z.object({ version: z.string().min(1) })

export const COMPONENT_VERSION = PackageSchema.parse(
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
).version
