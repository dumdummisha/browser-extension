import { cpSync, rmSync } from 'node:fs'
import { build } from 'esbuild'

const SOURCE_DIR = 'src/extension'
const EXTENSION_DIR = 'dist/extension'

// tsc compiles the extension's modules for the type check; Chrome loads bundles instead, since its service worker cannot
// resolve the packages they import and content scripts cannot be modules. The folder holds only what the manifest
// names, next to the manifest itself. Nothing is minified, so the function the service worker injects into Slack's page
// stays the self-contained source it was written as.
rmSync(EXTENSION_DIR, { recursive: true, force: true })

const options = { bundle: true, target: 'chrome140', outdir: EXTENSION_DIR, logLevel: 'warning' }
await build({ ...options, entryPoints: [`${SOURCE_DIR}/background.ts`], format: 'esm' })
await build({ ...options, entryPoints: [`${SOURCE_DIR}/observer.ts`, `${SOURCE_DIR}/relay.ts`], format: 'iife' })
cpSync(`${SOURCE_DIR}/manifest.json`, `${EXTENSION_DIR}/manifest.json`)
// The manifest names the icon folder's PNGs; the SVG they are rendered from stays out of the extension.
cpSync(`${SOURCE_DIR}/icons`, `${EXTENSION_DIR}/icons`, {
  recursive: true,
  filter: (/** @type {string} */ source) => !source.endsWith('.svg'),
})

process.stdout.write(`Built the unpacked extension in ${EXTENSION_DIR}/\n`)
