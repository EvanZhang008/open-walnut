/**
 * The versions an automatic update leaves alone (src/core/self-update/held-versions.ts):
 * one that failed to start here, and one a binary install was moved back from.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { badDirFor, clearBad, heldBack, markBad } from '../../../src/core/self-update/held-versions.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'held-versions-'))
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))

function binaryRoot(versions: string[], inUse: string) {
  const root = fs.mkdtempSync(path.join(scratch, 'root-'))
  for (const v of versions) {
    fs.mkdirSync(path.join(root, 'versions', v), { recursive: true })
    fs.writeFileSync(path.join(root, 'versions', v, 'walnut'), '')
  }
  return { kind: 'binary' as const, binary: { root, target: 'linux-x64', version: inUse } }
}

describe('held-back versions', () => {
  it('a binary install keeps its marks in its own root, an npm install in the Walnut home, others none', () => {
    const install = binaryRoot(['0.7.0'], '0.7.0')
    expect(badDirFor(install, '/home/a/.open-walnut')).toBe(path.join(install.binary.root, 'bad'))
    expect(badDirFor({ kind: 'npm', binary: null }, '/home/a/.open-walnut')).toBe('/home/a/.open-walnut/local/update-bad')
    expect(badDirFor({ kind: 'source', binary: null }, '/home/a/.open-walnut')).toBeNull()
  })

  it('a version marked bad is held back until a newer one is published, and a mark can be cleared', () => {
    const install = binaryRoot(['0.7.0'], '0.7.0')
    const dir = badDirFor(install, scratch)!
    expect(heldBack(install, '0.8.0', dir)).toBeNull()
    markBad(dir, '0.8.0', 'exited with 1 before it served')
    expect(heldBack(install, '0.8.0', dir)).toMatch(/^0\.8\.0 did not start here before/)
    expect(heldBack(install, '0.8.1', dir)).toBeNull()
    clearBad(dir, '0.8.0')
    expect(heldBack(install, '0.8.0', dir)).toBeNull()
    // Never a path out of the directory.
    markBad(dir, '../x', 'no')
    expect(fs.existsSync(path.join(dir, '..', 'x'))).toBe(false)
  })

  it('a binary install moved back from a newer version holds that one, and every release up to it', () => {
    // The link points at 0.7.0 while 0.8.0 is still installed beside it: moved back by hand.
    const install = binaryRoot(['0.7.0', '0.8.0'], '0.7.0')
    expect(heldBack(install, '0.8.0', null)).toBe('this install was moved back from 0.8.0 to 0.7.0; it updates again when a release newer than 0.8.0 is published')
    expect(heldBack(install, '0.7.5', null)).not.toBeNull()
    expect(heldBack(install, '0.9.0', null)).toBeNull()
    // The version before, kept for a rollback, holds nothing back.
    expect(heldBack(binaryRoot(['0.7.0', '0.8.0'], '0.8.0'), '0.9.0', null)).toBeNull()
    // A directory without the file, or that is no version, is not an install.
    const odd = binaryRoot(['0.7.0'], '0.7.0')
    fs.mkdirSync(path.join(odd.binary.root, 'versions', '0.9.0'))
    fs.mkdirSync(path.join(odd.binary.root, 'versions', '.download-0.9.0-ab'))
    expect(heldBack(odd, '0.9.0', null)).toBeNull()
  })

  it('an npm install is held back only by its marks', () => {
    const dir = path.join(scratch, 'home', 'local', 'update-bad')
    expect(heldBack({ kind: 'npm', binary: null }, '0.8.0', dir)).toBeNull()
    markBad(dir, '0.8.0', 'exited with 1 before it served')
    expect(heldBack({ kind: 'npm', binary: null }, '0.8.0', dir)).toMatch(/did not start here before/)
  })
})
