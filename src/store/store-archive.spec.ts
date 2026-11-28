import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { temporaryDirectory } from '../module/testing.js'
import {
  builtManifest,
  chromeVersionProblem,
  MANIFEST_DESCRIPTION_MAX_LENGTH,
  packStoreArchive,
} from './store-archive.js'

const REPOSITORY_ROOT = new URL('../../', import.meta.url)
const EXTENSION_DIR = fileURLToPath(new URL('dist/extension', REPOSITORY_ROOT))
const JsonObjectSchema = z.record(z.string(), z.unknown())

const readJson = (path: string): Record<string, unknown> =>
  JsonObjectSchema.parse(JSON.parse(readFileSync(path, 'utf8')))

const PACKAGE_VERSION = readJson(fileURLToPath(new URL('package.json', REPOSITORY_ROOT))).version
const SOURCE_MANIFEST = readJson(fileURLToPath(new URL('src/extension/manifest.json', REPOSITORY_ROOT)))

// The store archive of the build `pnpm test` made, in a folder of the test's own.
const packedArchive = async (context: TestContext): Promise<string> => {
  const dir = await temporaryDirectory(context, 'misha-store-archive-')
  const archive = join(dir, 'misha-browser.zip')

  packStoreArchive(EXTENSION_DIR, archive)

  return archive
}

const archivedManifest = (archive: string): Record<string, unknown> =>
  JsonObjectSchema.parse(
    JSON.parse(execFileSync('/usr/bin/unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' }))
  )

describe('[store] Store archive - content', () => {
  it('should hold only the manifest at its root and the scripts and icons it names', async (context) => {
    // Act
    const archive = await packedArchive(context)

    // Assert
    const entries = execFileSync('/usr/bin/unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n')

    assert.deepEqual(entries.toSorted(), [
      'background.js',
      'icons/misha-128.png',
      'icons/misha-16.png',
      'icons/misha-32.png',
      'icons/misha-48.png',
      'manifest.json',
      'observer.js',
      'relay.js',
      'whatsapp-observer.js',
      'whatsapp-relay.js',
    ])
  })

  it("should leave the key out of the archive's manifest only, keeping it in the built extension's", async (context) => {
    // Act
    const archive = await packedArchive(context)

    // Assert
    const built = readJson(join(EXTENSION_DIR, 'manifest.json'))
    const { key, ...withoutKey } = built

    assert.deepEqual(archivedManifest(archive), withoutKey)
    assert.equal(key, SOURCE_MANIFEST.key)
  })

  it('should give the built and the archived manifest the package.json version', async (context) => {
    // Act
    const archive = await packedArchive(context)

    // Assert
    const versions = [readJson(join(EXTENSION_DIR, 'manifest.json')).version, archivedManifest(archive).version]
    assert.deepEqual(versions, [PACKAGE_VERSION, PACKAGE_VERSION])
  })
})

describe('[store] Store archive - manifest', () => {
  it("should keep the description within Chrome's limit", () => {
    // Act
    const { description } = SOURCE_MANIFEST

    // Assert
    assert.ok(typeof description === 'string' && description.length <= MANIFEST_DESCRIPTION_MAX_LENGTH)
  })

  it("should refuse a description longer than Chrome's limit", () => {
    // Arrange
    const source = { ...SOURCE_MANIFEST, description: 'x'.repeat(MANIFEST_DESCRIPTION_MAX_LENGTH + 1) }

    // Act + Assert
    assert.throws(() => builtManifest(source, { version: '1.2.3' }), {
      message: "The manifest's description has 133 characters, more than Chrome's 132",
    })
  })

  it('should refuse a source manifest that names a version of its own', () => {
    // Act + Assert
    assert.throws(() => builtManifest({ ...SOURCE_MANIFEST, version: '1.2.3' }, { version: '1.2.3' }), {
      name: 'ZodError',
    })
  })

  it("should take only versions Chrome's manifest accepts", () => {
    // Act
    const problems = ['1', '0.1.0', '1.2.3.65535', '1.2.3.4.5', '01.2', '1.65536', '0.0.0', '1.0.0-beta', '1..2'].map(
      chromeVersionProblem
    )

    // Assert
    assert.deepEqual(problems, [
      null,
      null,
      null,
      '1.2.3.4.5 has more than 4 parts',
      '01.2 is not dot-separated integers from 0 to 65535 without leading zeros',
      '1.65536 is not dot-separated integers from 0 to 65535 without leading zeros',
      '0.0.0 is all zeros',
      '1.0.0-beta is not dot-separated integers from 0 to 65535 without leading zeros',
      '1..2 is not dot-separated integers from 0 to 65535 without leading zeros',
    ])
  })
})
