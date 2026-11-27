import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'

// The extension's built manifest and its Chrome Web Store archive (scripts/build-extension.js). The package.json
// version is the one version: the build writes it into the manifest, and the source manifest names none.

// Chrome's manifest contract: a description of at most 132 characters, and a version of one to four dot-separated
// integers, each from 0 to 65535, without leading zeros and not all zero.
export const MANIFEST_DESCRIPTION_MAX_LENGTH = 132
const VERSION_PARTS_MAX = 4
const VERSION_PART_MAX = 65_535
const VERSION_PART = /^(?:0|[1-9]\d*)$/u

const SourceManifestSchema = z.looseObject({
  description: z.string(),
  key: z.string(),
  version: z
    .never({ error: 'The source manifest names no version: the build writes the package.json version' })
    .optional(),
})

// What a manifest names that the extension runs or shows.
const PackagedFilesSchema = z.looseObject({
  background: z.object({ service_worker: z.string() }),
  content_scripts: z.array(z.object({ js: z.array(z.string()) })),
  icons: z.record(z.string(), z.string()),
})
const BuiltManifestSchema = PackagedFilesSchema.extend({ key: z.string() })

const PackageSchema = z.object({ version: z.string() })
// A manifest as read, every field kept in its order, for writing it back.
const JsonObjectSchema = z.record(z.string(), z.unknown())

type Manifest = Readonly<Record<string, unknown>>

// What makes version no Chrome manifest version, or null when it is one.
export const chromeVersionProblem = (version: string): string | null => {
  const parts = version.split('.')
  if (parts.length > VERSION_PARTS_MAX) {
    return `${version} has more than ${VERSION_PARTS_MAX} parts`
  }

  if (!parts.every((part) => VERSION_PART.test(part) && Number(part) <= VERSION_PART_MAX)) {
    return `${version} is not dot-separated integers from 0 to ${VERSION_PART_MAX} without leading zeros`
  }

  return parts.every((part) => part === '0') ? `${version} is all zeros` : null
}

// The manifest the build writes: the source manifest with the version of packageJson, the parsed package.json.
export const builtManifest = (source: unknown, packageJson: unknown): Manifest & { readonly version: string } => {
  const manifest = SourceManifestSchema.parse(source)
  const { version: packageVersion } = PackageSchema.parse(packageJson)
  if (manifest.description.length > MANIFEST_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `The manifest's description has ${manifest.description.length} characters, more than Chrome's ` +
        `${MANIFEST_DESCRIPTION_MAX_LENGTH}`
    )
  }

  const problem = chromeVersionProblem(packageVersion)
  if (problem !== null) {
    throw new Error(`The package.json version cannot be the extension's: ${problem}`)
  }

  return { ...JsonObjectSchema.parse(source), version: packageVersion }
}

// The files of the store archive: the manifest and exactly the scripts and icons it names, so nothing else in the
// build (the native host, the MCP server, source maps, specs) can reach it.
const storeArchiveFiles = (manifest: unknown): string[] => {
  const { background, content_scripts: contentScripts, icons } = PackagedFilesSchema.parse(manifest)

  return [
    'manifest.json',
    background.service_worker,
    ...contentScripts.flatMap(({ js }) => js),
    ...Object.values(icons),
  ]
}

// The built extension in extensionDir as a ZIP at archivePath, with manifest.json at its root, no folder entries and no
// extra file attributes. The archive's manifest leaves out the public key, which fixes the unpacked extension's id; the
// store assigns the item's own. The built manifest keeps it.
export const packStoreArchive = (extensionDir: string, archivePath: string): void => {
  // The manifest is checked, but written as it was read, since the schema drops fields it does not name.
  const built: unknown = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'))
  BuiltManifestSchema.parse(built)
  const storeManifest = Object.fromEntries(
    Object.entries(JsonObjectSchema.parse(built)).filter(([field]) => field !== 'key')
  )
  const staging = mkdtempSync(join(tmpdir(), 'misha-store-'))
  try {
    for (const file of storeArchiveFiles(storeManifest)) {
      mkdirSync(dirname(join(staging, file)), { recursive: true })
      if (file === 'manifest.json') {
        writeFileSync(join(staging, file), `${JSON.stringify(storeManifest, null, 2)}\n`)
      } else {
        cpSync(join(extensionDir, file), join(staging, file))
      }
    }

    const archive = resolve(archivePath)
    mkdirSync(dirname(archive), { recursive: true })
    rmSync(archive, { force: true })
    execFileSync('/usr/bin/zip', ['-X', '-D', '-q', '-r', archive, '.'], { cwd: staging })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
