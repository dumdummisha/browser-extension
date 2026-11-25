import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { builtManifest, packStoreArchive } from '../dist/store/store-archive.js'

const SOURCE_DIR = 'src/extension'
const EXTENSION_DIR = 'dist/extension'
const STORE_ARCHIVE_DIR = 'dist/store-archive'

// tsc compiles the extension's modules for the type check, and the build helpers this script imports; Chrome loads
// bundles instead, since its service worker cannot resolve the packages they import and content scripts cannot be
// modules. The folder holds only what the manifest names, next to the manifest itself, which gets the package.json
// version (store-archive.ts builtManifest). Nothing is minified, so the function the service worker injects into
// Slack's page stays the self-contained source it was written as. With --store, the built extension is also packed as
// the Chrome Web Store archive (store-archive.ts packStoreArchive); nothing is uploaded.
/** @type {boolean} */
const isStore = process.argv.includes('--store')

rmSync(EXTENSION_DIR, { recursive: true, force: true })

const options = { bundle: true, target: 'chrome140', outdir: EXTENSION_DIR, logLevel: 'warning' }
await build({ ...options, entryPoints: [`${SOURCE_DIR}/background.ts`], format: 'esm' })
await build({ ...options, entryPoints: [`${SOURCE_DIR}/observer.ts`, `${SOURCE_DIR}/relay.ts`], format: 'iife' })
/** @type {string} */
const packageText = readFileSync('package.json', 'utf8')
/** @type {string} */
const sourceManifestText = readFileSync(`${SOURCE_DIR}/manifest.json`, 'utf8')
const manifest = builtManifest(JSON.parse(sourceManifestText), JSON.parse(packageText))
writeFileSync(`${EXTENSION_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
// The manifest names the icon folder's PNGs; the SVG they are rendered from stays out of the extension.
cpSync(`${SOURCE_DIR}/icons`, `${EXTENSION_DIR}/icons`, {
  recursive: true,
  filter: (/** @type {string} */ source) => !source.endsWith('.svg'),
})

process.stdout.write(`Built the unpacked extension in ${EXTENSION_DIR}/\n`)

if (isStore) {
  const archive = `${STORE_ARCHIVE_DIR}/misha-browser-${manifest.version}.zip`
  packStoreArchive(EXTENSION_DIR, archive)
  process.stdout.write(`Packed the Chrome Web Store archive ${archive}\n`)
}
