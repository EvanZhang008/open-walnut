/**
 * Which installs may update while they serve, and so which `walnut web` supervises
 * its server from the start (src/core/self-update/live-eligible.ts).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-live-eligible'))

import { canSelfInstallLive } from '../../../src/core/self-update/live-eligible.js'
import type { InstallInfo } from '../../../src/core/self-update/install-kind.js'

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-eligible-')) })
afterEach(() => { fs.chmodSync(root, 0o755); fs.rmSync(root, { recursive: true, force: true }) })

const binary = (r: string): InstallInfo => ({ kind: 'binary', sourceDir: null, packageRoot: null, manager: null, updateCommand: 'walnut update', binary: { root: r, target: 'linux-x64', version: '0.5.1' } })
const npm = (pkg: string): InstallInfo => ({ kind: 'npm', sourceDir: null, packageRoot: pkg, manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' })

describe('canSelfInstallLive', () => {
  it('the compiled file in a layout this user can write', () => {
    for (const d of ['versions', 'bin']) fs.mkdirSync(path.join(root, d))
    expect(canSelfInstallLive({ enabled: true, install: binary(root) }, {})).toBe(true)
    // Its checker is off (opted out, a replica, a test): it never hears of a release.
    expect(canSelfInstallLive({ enabled: false, install: binary(root) }, {})).toBe(false)
    // The Mac app updates itself.
    expect(canSelfInstallLive({ enabled: true, install: binary(root) }, { WALNUT_LAUNCHER_UPDATES: '1' })).toBe(false)
    // A layout without its versions/ and bin/ (or not writable) cannot take a new version.
    expect(canSelfInstallLive({ enabled: true, install: binary(path.join(root, 'missing')) }, {})).toBe(false)
  })

  it('npm only when this process is the compiled file (a Node build loads its chunks lazily)', () => {
    const pkg = path.join(root, 'lib', 'node_modules', 'open-walnut')
    fs.mkdirSync(pkg, { recursive: true })
    expect(canSelfInstallLive({ enabled: true, install: npm(pkg) }, {}, true)).toBe(true)
    expect(canSelfInstallLive({ enabled: true, install: npm(pkg) }, {}, false)).toBe(false)
    expect(canSelfInstallLive({ enabled: true, install: { ...npm(pkg), manager: null } }, {}, true)).toBe(false)
  })

  it('never a source checkout, Homebrew, or a replica', () => {
    for (const kind of ['source', 'other', 'replica'] as const) {
      expect(canSelfInstallLive({ enabled: true, install: { ...npm(root), kind } }, {}, true)).toBe(false)
    }
  })
})
