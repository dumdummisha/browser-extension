import { writeFileSync } from 'node:fs'
import { readDisclosureInputs, renderStorePermissions, STORE_PERMISSIONS_PATH } from './store-disclosures.js'

// pnpm run disclosures: writes docs/store-permissions.md from docs/store-disclosures.json and the manifest.
writeFileSync(STORE_PERMISSIONS_PATH, renderStorePermissions(readDisclosureInputs()))
process.stdout.write(`Wrote ${STORE_PERMISSIONS_PATH}\n`)
