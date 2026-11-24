import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  disclosureMismatches,
  ExtensionManifestSchema,
  type IDisclosureInputs,
  MANIFEST_PATH,
  readDisclosureInputs,
  renderStorePermissions,
  STORE_PERMISSIONS_PATH,
} from './store-disclosures.js'

interface IRawManifest {
  readonly content_scripts: readonly Record<string, unknown>[]
  readonly [field: string]: unknown
}

const readRawManifest = (): IRawManifest => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as IRawManifest

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

  it('should disclose the client query where the observer keeps it, and no longer under webRequest', () => {
    // Arrange
    const kept = [
      "It also receives the page's resource timing entries and reads each one's initiator type. It reads the address only of the XHR requests Slack's web client sends, keeps per workspace API the listed session fields of the client's latest Web API call (such as `_x_csid`, `slack_route` and `_x_version_ts`), and drops the rest of the address as it reads it.",
      "Only those session fields leave the page, and only to the relay. They stay in the page's memory for the document's lifetime, also while the extension is off and across service worker and extension restarts, and are never written to disk.",
      'It receives those fields automatically, and the service worker reads them only for a Slack Web API call the Misha app asks for.',
    ]
    const dropped = [
      "The Slack transport sends its Web API calls with the query of Slack's client's own latest Web API call in the page",
      "per page the query of the client's latest Web API call cut down to its listed session fields",
    ]

    // Act
    const rendered = renderStorePermissions(readDisclosureInputs())

    // Assert
    assert.deepEqual(
      [
        kept.filter((sentence) => !rendered.includes(sentence)),
        dropped.filter((sentence) => rendered.includes(sentence)),
      ],
      [[], []]
    )
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

  for (const [field, value] of [
    ['optional_permissions', ['cookies']],
    ['optional_host_permissions', ['https://example.com/*']],
  ] as const) {
    it(`should reject a manifest that declares ${field}`, () => {
      // Arrange
      const manifest = { ...readRawManifest(), [field]: value }

      // Act
      const parsed = ExtensionManifestSchema.safeParse(manifest)

      // Assert
      assert.deepEqual(parsed.error?.issues, [
        {
          expected: 'never',
          code: 'invalid_type',
          path: [field],
          message: `The disclosures cover no ${field}; disclose them before declaring them`,
        },
      ])
    })
  }

  for (const [field, value] of [
    ['match_about_blank', true],
    ['match_origin_as_fallback', true],
    ['exclude_matches', ['https://app.slack.com/admin/*']],
    ['include_globs', ['*client*']],
    ['exclude_globs', ['*admin*']],
  ] as const) {
    it(`should reject a content script that declares ${field}`, () => {
      // Arrange
      const raw = readRawManifest()
      const [first, ...rest] = raw.content_scripts
      const manifest = { ...raw, content_scripts: [{ ...first, [field]: value }, ...rest] }

      // Act
      const parsed = ExtensionManifestSchema.safeParse(manifest)

      // Assert
      assert.deepEqual(parsed.error?.issues, [
        {
          code: 'unrecognized_keys',
          keys: [field],
          path: ['content_scripts', 0],
          message: `Unrecognized key: "${field}"`,
        },
      ])
    })
  }

  it('should disclose a content script declared in every frame', () => {
    // Arrange
    const { disclosures, manifest } = readDisclosureInputs()
    const changed: IDisclosureInputs = {
      disclosures,
      manifest: {
        ...manifest,
        content_scripts: manifest.content_scripts.map((script) => ({ ...script, all_frames: true })),
      },
    }

    // Act
    const rendered = renderStorePermissions(changed)

    // Assert
    assert.ok(
      rendered.includes(
        "Declared on `https://app.slack.com/*`, from `document_start`, in the page's own world, in every frame."
      )
    )
    assert.ok(!rendered.includes('in the top frame only'))
  })

  it('should refuse to render disclosures that do not match the manifest', () => {
    // Arrange
    const { disclosures, manifest } = readDisclosureInputs()
    const changed: IDisclosureInputs = { disclosures, manifest: { ...manifest, permissions: ['storage'] } }

    // Act + Assert
    assert.throws(() => renderStorePermissions(changed), /The manifest's permission storage has no disclosure/u)
  })
})
