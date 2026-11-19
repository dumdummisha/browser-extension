import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  disclosureMismatches,
  type IDisclosureInputs,
  readDisclosureInputs,
  renderStorePermissions,
  STORE_PERMISSIONS_PATH,
} from './store-disclosures.js'

describe('[disclosures] Store disclosures', () => {
  it('should disclose exactly what the manifest declares', () => {
    // Act
    const mismatches = disclosureMismatches(readDisclosureInputs())

    // Assert
    assert.deepEqual(mismatches, [])
  })

  it('should keep docs/store-permissions.md as pnpm run disclosures renders it', () => {
    // Arrange
    const committed = readFileSync(STORE_PERMISSIONS_PATH, 'utf8')

    // Act
    const rendered = renderStorePermissions(readDisclosureInputs())

    // Assert
    assert.ok(committed === rendered, 'docs/store-permissions.md is stale: run pnpm run disclosures')
  })

  it('should report a declaration with no disclosure and a disclosure the manifest lacks', () => {
    // Arrange
    const { disclosures, manifest } = readDisclosureInputs()
    const changed: IDisclosureInputs = {
      disclosures,
      manifest: {
        permissions: [...manifest.permissions.filter((permission) => permission !== 'alarms'), 'storage'],
        host_permissions: ['https://example.com/*'],
        content_scripts: manifest.content_scripts.slice(0, 1).map((script) => ({ ...script, js: ['watcher.js'] })),
      },
    }

    // Act
    const mismatches = disclosureMismatches(changed)

    // Assert
    assert.deepEqual(mismatches, [
      "The manifest's permission storage has no disclosure",
      'The disclosed permission alarms is not in the manifest',
      "The manifest's host permission https://example.com/* has no disclosure",
      'The disclosed host permission <all_urls> is not in the manifest',
      "The manifest's content script watcher.js has no disclosure",
      'The disclosed content script observer.js is not in the manifest',
      'The disclosed content script relay.js is not in the manifest',
    ])
  })

  it('should report a permission listed as not requested that the manifest requests', () => {
    // Arrange
    const { disclosures, manifest } = readDisclosureInputs()
    const changed: IDisclosureInputs = {
      disclosures,
      manifest: { ...manifest, permissions: [...manifest.permissions, 'cookies'] },
    }

    // Act
    const mismatches = disclosureMismatches(changed)

    // Assert
    assert.deepEqual(mismatches, [
      "The manifest's permission cookies has no disclosure",
      'The permission cookies is listed as not requested, but the manifest requests it',
    ])
  })

  it('should refuse to render disclosures that do not match the manifest', () => {
    // Arrange
    const { disclosures, manifest } = readDisclosureInputs()
    const changed: IDisclosureInputs = { disclosures, manifest: { ...manifest, permissions: ['storage'] } }

    // Act + Assert
    assert.throws(() => renderStorePermissions(changed), /The manifest's permission storage has no disclosure/u)
  })
})
