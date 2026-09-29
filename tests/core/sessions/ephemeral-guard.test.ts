/**
 * An ephemeral server must never run on the production Walnut's own data dir
 * (src/core/sessions/ephemeral-guard.ts): it clears every session pid at boot
 * and treats its data as a disposable copy.
 *
 * Only temp dirs are used as stand-in "production homes"; the real one is only
 * ever compared as a path, never opened or written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertEphemeralHomeIsNotProduction,
  isProductionWalnutHome,
  productionWalnutHomes,
} from '../../../src/core/sessions/ephemeral-guard.js'

const REPO_ROOT = path.resolve(__dirname, '../../..')
let tmp: string
let prodHome: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ephemeral-guard-'))
  prodHome = path.join(tmp, 'home', '.open-walnut')
  fs.mkdirSync(prodHome, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('isProductionWalnutHome', () => {
  it('matches the production dir however it is spelled', () => {
    fs.symlinkSync(prodHome, path.join(tmp, 'alias'))
    for (const spelling of [prodHome, prodHome + '/', path.join(prodHome, 'x', '..'), path.join(tmp, 'alias')]) {
      expect(isProductionWalnutHome(spelling, [prodHome]), spelling).toBe(true)
    }
  })

  it('does not match a snapshot copy, a child dir or a sibling', () => {
    const snapshot = path.join(tmp, 'open-walnut-eph-1')
    fs.mkdirSync(snapshot)
    for (const other of [snapshot, path.join(prodHome, 'local'), path.join(tmp, 'home', '.open-walnut-copy')]) {
      expect(isProductionWalnutHome(other, [prodHome]), other).toBe(false)
    }
  })

  it('the default production homes are ~/.open-walnut under the account home', () => {
    expect(productionWalnutHomes()).toContain(path.join(os.homedir(), '.open-walnut')) // safe: production-path
    expect(productionWalnutHomes()).toContain(path.join(os.userInfo().homedir, '.open-walnut'))
  })
})

describe('assertEphemeralHomeIsNotProduction', () => {
  it('throws a clear error for the production dir', () => {
    expect(() => assertEphemeralHomeIsNotProduction(prodHome, [prodHome]))
      .toThrow(`Ephemeral server refused to start: its data dir ${prodHome} is the production Walnut's own.`)
  })

  it('passes a snapshot copy', () => {
    expect(() => assertEphemeralHomeIsNotProduction(path.join(tmp, 'snapshot'), [prodHome])).not.toThrow()
  })
})

describe('startServer checks the home before it touches anything', () => {
  it('an ephemeral boot asserts the home before the instance lock, init and the pid scrub', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'src/web/server.ts'), 'utf-8')
    const guard = src.indexOf('assertEphemeralHomeIsNotProduction(WALNUT_HOME)')
    expect(guard, 'startServer must assert the ephemeral home').toBeGreaterThan(-1)
    expect(src.slice(src.lastIndexOf('if (IS_EPHEMERAL)', guard), guard), 'the check runs only on an ephemeral server').toMatch(/^if \(IS_EPHEMERAL\) \{\s*const \{ assertEphemeralHomeIsNotProduction \}/)
    for (const later of ['acquireInstanceLock(port)', 'await initDirectories()', 'await scrubInheritedSessionPids()']) {
      const at = src.indexOf(later)
      expect(at, later).toBeGreaterThan(guard)
    }
  })
})
