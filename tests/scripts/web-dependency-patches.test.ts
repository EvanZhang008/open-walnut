/**
 * web/'s dependency patches (web/patches/) are applied by every install in web/
 * and stay matched to the installed version.
 *
 * The auto-animate patch stops a closed session column from being kept alive by
 * the library's position observer (tests/e2e/browser/session-column-close-releases-dom.spec.ts).
 * Bun applies a patch named in web/package.json `patchedDependencies` and
 * recorded in web/bun.lock, so `bun install` in web/ (frozen or not) cannot
 * drop it. A web patch lives in web/patches/, beside the package.json that
 * names it, never in the root patches/.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readBunLock, splitSpec } from '../helpers/bun-lock.js'

const root = path.resolve(import.meta.dirname, '../..')
const web = path.join(root, 'web')
const pkg = JSON.parse(fs.readFileSync(path.join(web, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; patchedDependencies?: Record<string, string> }

describe('web dependency patches', () => {
  it('every web patch targets the version web/bun.lock installs, is recorded there, and exists', () => {
    const lock = readBunLock(path.join(web, 'bun.lock'))
    const entries = Object.entries(pkg.patchedDependencies ?? {})
    expect(entries.map(([key]) => key)).toContain('@formkit/auto-animate@0.9.0')
    for (const [key, file] of entries) {
      const [name, version] = splitSpec(key)
      expect(file.startsWith('patches/'), file).toBe(true)
      expect(fs.existsSync(path.join(web, file)), file).toBe(true)
      expect(lock.packages[name]?.[0], `${key}: re-make the patch after a version bump`).toBe(`${name}@${version}`)
      expect(lock.patchedDependencies?.[key], key).toBe(file)
    }
    // Every file in web/patches is one of them (a leftover would be silently ignored).
    const named = new Set(entries.map(([, file]) => path.basename(file)))
    expect(fs.readdirSync(path.join(web, 'patches')).filter((f) => !named.has(f))).toEqual([])
  })

  it('a patch is relative to its package, as bun applies it (not patch-package node_modules paths)', () => {
    for (const file of Object.values(pkg.patchedDependencies ?? {})) {
      const text = fs.readFileSync(path.join(web, file), 'utf8')
      expect(text).toMatch(/^diff --git a\//m)
      expect(text).not.toMatch(/^(---|\+\+\+) [ab]\/node_modules\//m)
    }
  })

  it('the root patches dir holds no web patch', () => {
    const stray = fs.readdirSync(path.join(root, 'patches'), { recursive: true }) as string[]
    expect(stray.filter((f) => f.includes('auto-animate'))).toEqual([])
  })

  it('no install in web/ runs node or patch-package', () => {
    expect(pkg.scripts?.postinstall).toBeUndefined()
  })
})
