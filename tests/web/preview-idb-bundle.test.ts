/**
 * The IndexedDB a Files preview page gets is built from the pinned fake-indexeddb devDependency
 * (scripts/build-preview-idb.mjs). A bump of the dependency without a rebuild of the generated file
 * would ship the old one: this fails until `bun scripts/build-preview-idb.mjs` runs.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FAKE_INDEXEDDB_JS, FAKE_INDEXEDDB_VERSION } from '../../src/web/preview-runtime/fake-indexeddb.generated.js'

describe('preview IndexedDB bundle', () => {
  it('is built from the installed fake-indexeddb', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'node_modules/fake-indexeddb/package.json'), 'utf8'))
    expect(FAKE_INDEXEDDB_VERSION).toBe(pkg.version)
  })
  it('can sit in a script element and sets the classes', () => {
    expect(FAKE_INDEXEDDB_JS).not.toMatch(/<\/script|<!--/i)
    const g: Record<string, unknown> = {}
    new Function('globalThis', FAKE_INDEXEDDB_JS.replace(/\bglobalThis\b/g, 'globalThis'))(g)
    expect(Object.keys((g.__wnFakeIDB ?? (globalThis as Record<string, unknown>).__wnFakeIDB) as object).sort()).toContain('indexedDB')
  })
})
