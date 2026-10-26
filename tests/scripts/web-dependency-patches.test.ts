/**
 * web/'s dependency patches (web/patches/) are applied by the dev install and
 * stay matched to the installed version.
 *
 * The auto-animate patch stops a closed session column from being kept alive by
 * the library's position observer (tests/e2e/browser/session-column-close-releases-dom.spec.ts).
 * A patch lives in web/patches/, not the root patches/: patch-package reads its
 * dir recursively and would apply a web patch to the root node_modules, where
 * the package does not exist, failing every install.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')

describe('web dependency patches', () => {
  it('every web patch names the version web/package-lock.json installs', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'web/package-lock.json'), 'utf8'))
    const patches = fs.readdirSync(path.join(root, 'web/patches')).filter((f) => f.endsWith('.patch'))
    expect(patches).toContain('@formkit+auto-animate+0.9.0.patch')
    for (const file of patches) {
      const m = /^(.+)\+([^+]+)\.patch$/.exec(file)!
      const name = m[1].replace(/\+/g, '/')
      expect(lock.packages[`node_modules/${name}`]?.version, `${file}: re-make the patch after a version bump`).toBe(m[2])
    }
  })

  it('the root patches dir holds no web patch', () => {
    const stray = fs.readdirSync(path.join(root, 'patches'), { recursive: true }) as string[]
    expect(stray.filter((f) => f.includes('auto-animate'))).toEqual([])
  })

  it('every install in web/ applies them (its own postinstall, so a plain npm install there cannot drop one)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'web/package.json'), 'utf8'))
    expect(pkg.scripts.postinstall).toBe('node ../node_modules/patch-package/index.js')
  })
})
