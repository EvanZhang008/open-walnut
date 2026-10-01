/**
 * Update on restart: what `walnut web` does before it listens. Every side
 * effect is a stub here (the installer and the re-exec are never spawned): the
 * tests pin the decision for each state and the order of effects on the install
 * path, including every way a failure must still start the old version.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-startup-update'))

import {
  APPLIED_ENV, autoUpdateEnabled, decideStartupUpdate, installDirWritable, updateOnStart, type StartupUpdateDeps,
} from '../../../src/core/self-update/startup-update.js'
import type { UpdateStatus } from '../../../src/core/self-update/update-check.js'

const NPM_ROOT = '/usr/local/lib/node_modules/open-walnut'
const BASE: UpdateStatus = {
  enabled: true,
  install: { kind: 'npm', sourceDir: null, packageRoot: NPM_ROOT, manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' },
  current: '0.5.1', channel: 'stable', latest: '0.6.0', tags: { latest: '0.6.0', nightly: null }, available: true,
  checkedAt: '2026-09-30T10:00:00.000Z', error: null, checking: false, packageUrl: 'https://www.npmjs.com/package/open-walnut',
}
const ALL = { auto: true, applied: false, writable: true }

describe('autoUpdateEnabled', () => {
  it('is on by default, off by config or the env override', () => {
    expect(autoUpdateEnabled(undefined, {})).toBe(true)
    expect(autoUpdateEnabled(true, {})).toBe(true)
    expect(autoUpdateEnabled(false, {})).toBe(false)
    expect(autoUpdateEnabled(true, { WALNUT_NO_AUTO_UPDATE: '1' })).toBe(false)
    expect(autoUpdateEnabled(true, { WALNUT_NO_AUTO_UPDATE: '0' })).toBe(true)
    expect(autoUpdateEnabled(true, { WALNUT_NO_AUTO_UPDATE: '' })).toBe(true)
  })
})

describe('installDirWritable', () => {
  it('needs the package root and its parent writable; no root means no', () => {
    const ok = vi.fn()
    expect(installDirWritable(NPM_ROOT, ok)).toBe(true)
    expect(ok.mock.calls.map((c) => c[0])).toEqual([NPM_ROOT, '/usr/local/lib/node_modules'])
    const parentReadOnly = (p: string) => { if (p === '/usr/local/lib/node_modules') throw new Error('EACCES') }
    expect(installDirWritable(NPM_ROOT, parentReadOnly)).toBe(false)
    expect(installDirWritable(null, ok)).toBe(false)
  })
})

describe('decideStartupUpdate', () => {
  it('installs the exact published version through the manager when everything lines up', () => {
    expect(decideStartupUpdate(BASE, ALL)).toEqual({ action: 'install', version: '0.6.0', argv: { file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0'] } })
  })

  it('skips, in order: just applied, switched off, not an npm install, check disabled, registry unreachable, current, read-only prefix', () => {
    expect(decideStartupUpdate(BASE, { ...ALL, applied: true })).toEqual({ action: 'skip', reason: 'applied' })
    expect(decideStartupUpdate(BASE, { ...ALL, auto: false })).toEqual({ action: 'skip', reason: 'off' })
    expect(decideStartupUpdate({ ...BASE, install: { ...BASE.install, kind: 'source', manager: null } }, ALL)).toEqual({ action: 'skip', reason: 'not-npm' })
    expect(decideStartupUpdate({ ...BASE, enabled: false, reason: 'opted-out' }, ALL)).toEqual({ action: 'skip', reason: 'disabled', note: 'opted-out' })
    expect(decideStartupUpdate({ ...BASE, latest: null, error: 'fetch failed' }, ALL)).toEqual({ action: 'skip', reason: 'unreachable', note: 'fetch failed' })
    expect(decideStartupUpdate({ ...BASE, latest: '0.5.1', available: false }, ALL)).toEqual({ action: 'skip', reason: 'current' })
    expect(decideStartupUpdate(BASE, { ...ALL, writable: false })).toEqual({ action: 'skip', reason: 'not-writable', note: 'sudo npm install -g open-walnut@latest' })
  })

  it('a nightly build installs the exact nightly', () => {
    const nightly: UpdateStatus = { ...BASE, current: '0.6.1-nightly.20261001.4', channel: 'nightly', latest: '0.6.1-nightly.20261002.1' }
    expect(decideStartupUpdate(nightly, ALL)).toMatchObject({ action: 'install', argv: { args: ['install', '-g', 'open-walnut@0.6.1-nightly.20261002.1'] } })
  })
})

function deps(status: UpdateStatus, over: Partial<StartupUpdateDeps> = {}) {
  const err: string[] = []
  const run = vi.fn(async () => 0)
  const reexec = vi.fn(async () => 0)
  const checkNow = vi.fn(async () => status)
  const d: StartupUpdateDeps = {
    checkNow, configAuto: async () => undefined, env: {}, writable: () => true, run, reexec, err: (l) => err.push(l), ...over,
  }
  return { d, err, run, reexec, checkNow }
}

describe('updateOnStart', () => {
  it('installs, then starts the same command again with the applied marker, and reports the child\'s exit code', async () => {
    const reexec = vi.fn(async () => 3)
    const { d, err, run } = deps(BASE, { env: { HOME: '/Users/alice' }, reexec })
    const out = await updateOnStart(d)
    expect(out).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: 3 })
    expect(run).toHaveBeenCalledWith('npm', ['install', '-g', 'open-walnut@0.6.0'])
    expect(reexec).toHaveBeenCalledWith({ HOME: '/Users/alice', [APPLIED_ENV]: '1' })
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(reexec.mock.invocationCallOrder[0]!)
    expect(err[0]).toContain('0.6.0 is published (this is 0.5.1); installing it before starting')
    expect(err[1]).toBe('Installed Open Walnut 0.6.0; starting it.')
  })

  it('the restarted process never asks the registry again', async () => {
    const { d, checkNow, run } = deps(BASE, { env: { [APPLIED_ENV]: '1' } })
    expect(await updateOnStart(d)).toEqual({ kind: 'continue', decision: { action: 'skip', reason: 'applied' } })
    expect(checkNow).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('switched off in config or by env: no registry call, starts as it is', async () => {
    const off = deps(BASE, { configAuto: async () => false })
    expect(await updateOnStart(off.d)).toEqual({ kind: 'continue', decision: { action: 'skip', reason: 'off' } })
    expect(off.checkNow).not.toHaveBeenCalled()
    const env = deps(BASE, { env: { WALNUT_NO_AUTO_UPDATE: '1' } })
    expect((await updateOnStart(env.d)).kind).toBe('continue')
    expect(env.checkNow).not.toHaveBeenCalled()
  })

  it('an unreadable config counts as the default (on)', async () => {
    const { d, checkNow } = deps({ ...BASE, available: false, latest: '0.5.1' }, { configAuto: async () => { throw new Error('yaml') } })
    expect((await updateOnStart(d)).decision).toEqual({ action: 'skip', reason: 'current' })
    expect(checkNow).toHaveBeenCalledTimes(1)
  })

  it('a read-only prefix prints the sudo line and starts the old version', async () => {
    const { d, err, run } = deps(BASE, { writable: () => false })
    expect((await updateOnStart(d)).decision).toMatchObject({ action: 'skip', reason: 'not-writable' })
    expect(run).not.toHaveBeenCalled()
    expect(err[0]).toBe('Open Walnut 0.6.0 is published, but this install is not writable by this user. Run: sudo npm install -g open-walnut@latest')
  })

  it('a failing installer, or one that cannot start, still starts the old version', async () => {
    const failed = deps(BASE, { run: vi.fn(async () => 1) })
    expect(await updateOnStart(failed.d)).toMatchObject({ kind: 'continue', installFailed: 'exit 1' })
    expect(failed.reexec).not.toHaveBeenCalled()
    expect(failed.err[1]).toBe('npm exited with 1; starting 0.5.1 as it is.')
    const missing = deps(BASE, { run: vi.fn(async () => { throw new Error('spawn npm ENOENT') }) })
    expect(await updateOnStart(missing.d)).toMatchObject({ kind: 'continue', installFailed: 'spawn npm ENOENT' })
    expect(missing.err[1]).toBe('Could not run npm (spawn npm ENOENT); starting 0.5.1 as it is.')
  })

  it('a source checkout and an unreachable registry are quiet and start as they are', async () => {
    const source = deps({ ...BASE, enabled: false, reason: 'source', latest: null, available: false, install: { ...BASE.install, kind: 'source', manager: null, updateCommand: null } })
    expect(await updateOnStart(source.d)).toEqual({ kind: 'continue', decision: { action: 'skip', reason: 'not-npm' } })
    expect(source.err).toEqual([])
    const down = deps({ ...BASE, latest: null, available: false, error: 'fetch failed' })
    expect((await updateOnStart(down.d)).decision).toEqual({ action: 'skip', reason: 'unreachable', note: 'fetch failed' })
    expect(down.err).toEqual([])
  })
})
