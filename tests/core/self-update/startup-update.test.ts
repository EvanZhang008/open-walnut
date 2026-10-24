/**
 * Update on restart: what `walnut web` does before it listens. Every side
 * effect is a stub here (the installer and the re-exec are never spawned): the
 * tests pin the decision for each state and the order of effects on the install
 * path, including every way a failure must still start the old version.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { guardedPath } from '../../setup/exec-guard.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-startup-update'))

import {
  APPLIED_ENV, LAUNCHER_UPDATES_ENV, READY_FILE_ENV, autoUpdateEnabled, binaryRootWritable, decideStartupUpdate, installDirWritable, installWritable, reexecSelf, relaunchArgv, updateOnStart, watchStop,
  type ReexecResult, type StartupUpdateDeps, type UpdateStop,
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

describe('installWritable', () => {
  // The one question the start, `walnut update` and the console's card all ask.
  const readOnly = (dirs: string[]) => (p: string) => { if (dirs.includes(p)) throw new Error('EACCES') }
  const NPM = { kind: 'npm' as const, sourceDir: null, packageRoot: NPM_ROOT, manager: 'npm' as const, updateCommand: 'npm install -g open-walnut@latest' }
  it('an npm install: its package root and the directory npm renames it in', () => {
    expect(installWritable(NPM, vi.fn())).toBe(true)
    expect(installWritable(NPM, readOnly(['/usr/local/lib/node_modules']))).toBe(false)
  })
  it('a compiled file: its versions/ and bin/', () => {
    const FILE = { kind: 'binary' as const, sourceDir: null, packageRoot: null, manager: null, updateCommand: 'walnut update', binary: { root: '/opt/walnut', target: 'linux-x64', version: '0.6.99' } }
    expect(installWritable(FILE, vi.fn())).toBe(true)
    expect(installWritable(FILE, readOnly(['/opt/walnut/bin']))).toBe(false)
  })
  it('an install Walnut never updates itself is not asked about', () => {
    const never = () => { throw new Error('EACCES') }
    expect(installWritable({ kind: 'other', sourceDir: null, packageRoot: '/opt/x', manager: null, updateCommand: 'brew upgrade open-walnut' }, never)).toBe(true)
    expect(installWritable({ kind: 'source', sourceDir: '/src', packageRoot: '/src', manager: null, updateCommand: null }, never)).toBe(true)
  })
})

describe('decideStartupUpdate', () => {
  it('installs the exact published version through the manager when everything lines up', () => {
    expect(decideStartupUpdate(BASE, ALL)).toEqual({ action: 'install', version: '0.6.0', argv: { file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0', '--allow-scripts=open-walnut'] } })
  })

  it('skips, in order: just applied, switched off, not an npm install, check disabled, registry unreachable, current, read-only prefix', () => {
    expect(decideStartupUpdate(BASE, { ...ALL, applied: true })).toEqual({ action: 'skip', reason: 'applied' })
    expect(decideStartupUpdate(BASE, { ...ALL, auto: false })).toEqual({ action: 'skip', reason: 'off' })
    expect(decideStartupUpdate({ ...BASE, install: { ...BASE.install, kind: 'source', manager: null } }, ALL)).toEqual({ action: 'skip', reason: 'not-npm' })
    expect(decideStartupUpdate({ ...BASE, enabled: false, reason: 'opted-out' }, ALL)).toEqual({ action: 'skip', reason: 'disabled', note: 'opted-out' })
    expect(decideStartupUpdate({ ...BASE, latest: null, error: 'fetch failed' }, ALL)).toEqual({ action: 'skip', reason: 'unreachable', note: 'fetch failed' })
    expect(decideStartupUpdate({ ...BASE, latest: '0.5.1', available: false }, ALL)).toEqual({ action: 'skip', reason: 'current' })
    expect(decideStartupUpdate(BASE, { ...ALL, writable: false })).toEqual({ action: 'skip', reason: 'not-writable', note: 'sudo npm install -g open-walnut@latest --allow-scripts=open-walnut' })
  })

  it('a nightly build installs the exact nightly', () => {
    const nightly: UpdateStatus = { ...BASE, current: '0.6.1-nightly.20261001.4', channel: 'nightly', latest: '0.6.1-nightly.20261002.1' }
    expect(decideStartupUpdate(nightly, ALL)).toMatchObject({ action: 'install', argv: { args: ['install', '-g', 'open-walnut@0.6.1-nightly.20261002.1', '--allow-scripts=open-walnut'] } })
  })
})

/** How a restarted server ended: by default it served, then exited 0. */
const ended = (over: Partial<ReexecResult> = {}): ReexecResult => ({ exitCode: 0, served: true, stopped: false, ms: 5_000, ...over })

/** A stop that never fires unless the test fires it. */
function stopStub(): UpdateStop & { fire: (reason: Error, signal?: NodeJS.Signals) => void } {
  const controller = new AbortController()
  let received: NodeJS.Signals | null = null
  return {
    signal: controller.signal,
    received: () => received,
    done: () => {},
    fire: (reason, signal) => { received = signal ?? null; controller.abort(reason) },
  }
}

function deps(status: UpdateStatus, over: Partial<StartupUpdateDeps> = {}) {
  const err: string[] = []
  const run = vi.fn(async () => 0)
  const reexec = vi.fn(async () => ended())
  const checkNow = vi.fn(async () => status)
  const stop = stopStub()
  const d: StartupUpdateDeps = {
    checkNow, configAuto: async () => undefined, env: {}, writable: () => true, run, reexec, watch: () => stop, err: (l) => err.push(l), ...over,
  }
  return { d, err, run, reexec, checkNow, stop }
}

describe('updateOnStart', () => {
  it('installs, then starts the same command again with the applied marker, and reports the child\'s exit code', async () => {
    const reexec = vi.fn(async () => ended({ exitCode: 3 }))
    const { d, err, run } = deps(BASE, { env: { HOME: '/Users/alice' }, reexec })
    const out = await updateOnStart(d)
    expect(out).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: 3 })
    expect(run).toHaveBeenCalledWith('npm', ['install', '-g', 'open-walnut@0.6.0', '--allow-scripts=open-walnut'], expect.anything())
    expect(reexec).toHaveBeenCalledWith({ HOME: '/Users/alice', [APPLIED_ENV]: '1' }, BASE.install)
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
    expect(err[0]).toBe('Open Walnut 0.6.0 is published, but this install is not writable by this user. Run: sudo npm install -g open-walnut@latest --allow-scripts=open-walnut')
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

const ROOT = '/home/alice/.local/share/open-walnut'
const FILE: UpdateStatus = {
  ...BASE,
  install: {
    kind: 'binary', sourceDir: null, packageRoot: null, manager: null, updateCommand: 'walnut update',
    binary: { root: ROOT, target: 'linux-x64', version: '0.5.1' }, relaunch: [`${ROOT}/bin/walnut`],
  },
}

describe('the compiled file in install.sh\'s layout', () => {
  it('installs the published version into its own layout, never through a manager', () => {
    expect(decideStartupUpdate(FILE, ALL)).toEqual({ action: 'install-file', version: '0.6.0', install: FILE.install.binary })
    expect(decideStartupUpdate({ ...FILE, latest: '0.5.1', available: false }, ALL)).toEqual({ action: 'skip', reason: 'current' })
    expect(decideStartupUpdate(FILE, { ...ALL, writable: false })).toMatchObject({ action: 'skip', reason: 'not-writable' })
  })

  it('needs its versions and bin folders writable', () => {
    const seen: string[] = []
    expect(binaryRootWritable(ROOT, (p) => { seen.push(p) })).toBe(true)
    expect(seen).toEqual([`${ROOT}/versions`, `${ROOT}/bin`])
    expect(binaryRootWritable(ROOT, (p) => { if (p.endsWith('/bin')) throw new Error('EACCES') })).toBe(false)
  })

  it('installs, then starts again through its link with the applied marker', async () => {
    const installFile = vi.fn(async () => {})
    const { d, err, run, reexec } = deps(FILE, { installFile, binaryWritable: () => true, writable: () => false })
    expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: 0 })
    expect(installFile).toHaveBeenCalledWith(FILE.install.binary, '0.6.0', expect.any(AbortSignal))
    expect(run).not.toHaveBeenCalled()
    expect(reexec).toHaveBeenCalledWith({ [APPLIED_ENV]: '1' }, FILE.install)
    expect(err.at(-1)).toBe('Installed Open Walnut 0.6.0; starting it.')
  })

  it('a failed download or check starts the old version, with the reason', async () => {
    const installFile = vi.fn(async () => { throw new Error('the downloaded Walnut does not run here') })
    const { d, err, reexec } = deps(FILE, { installFile, binaryWritable: () => true })
    expect(await updateOnStart(d)).toMatchObject({ kind: 'continue', installFailed: 'the downloaded Walnut does not run here' })
    expect(reexec).not.toHaveBeenCalled()
    expect(err.at(-1)).toBe('Could not install 0.6.0 (the downloaded Walnut does not run here); starting 0.5.1 as it is.')
  })

  it('a root this user cannot write says so and starts as it is', async () => {
    const installFile = vi.fn(async () => {})
    const { d, err } = deps(FILE, { installFile, binaryWritable: () => false })
    expect((await updateOnStart(d)).decision).toMatchObject({ reason: 'not-writable' })
    expect(installFile).not.toHaveBeenCalled()
    expect(err[0]).toContain(`this install is not writable by this user. Run: sudo ${ROOT}/bin/walnut update`)
  })
})

describe('a new version that does not start', () => {
  const failed = ended({ exitCode: 1, served: false, ms: 800 })

  it('one that exits non-zero before it serves is gone back from, and the version before starts', async () => {
    const installFile = vi.fn(async () => ({ from: '0.5.1' }))
    const rollBack = vi.fn(async () => {})
    const undoRollBack = vi.fn(async () => {})
    const reexec = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(ended({ exitCode: 0 }))
    const { d, err } = deps(FILE, { installFile, rollBack, undoRollBack, reexec, binaryWritable: () => true })
    expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.5.1', exitCode: 0, rolledBackFrom: '0.6.0' })
    expect(rollBack).toHaveBeenCalledWith(FILE, '0.5.1', '0.6.0', 'exited with 1 before it served')
    expect(rollBack.mock.invocationCallOrder[0]).toBeLessThan(reexec.mock.invocationCallOrder[1]!)
    expect(reexec).toHaveBeenNthCalledWith(2, { [APPLIED_ENV]: '1' }, FILE.install)
    expect(undoRollBack).not.toHaveBeenCalled()
    expect(err).toContain('Open Walnut 0.6.0 exited with 1 before it served; going back to 0.5.1. 0.6.0 is skipped until a newer release is published.')
  })

  it('one that served, or was stopped by a signal, is no failed start', async () => {
    for (const end of [ended({ exitCode: 1, served: true }), ended({ exitCode: 143, served: false, stopped: true })]) {
      const rollBack = vi.fn(async () => {})
      const { d } = deps(FILE, { installFile: async () => ({ from: '0.5.1' }), rollBack, reexec: vi.fn(async () => end), binaryWritable: () => true })
      expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: end.exitCode })
      expect(rollBack).not.toHaveBeenCalled()
    }
  })

  it('when the version gone back to fails to start as well, the new one was not the cause: that is undone', async () => {
    const rollBack = vi.fn(async () => {})
    const undoRollBack = vi.fn(async () => {})
    const reexec = vi.fn(async () => failed)
    const { d, err } = deps(FILE, { installFile: async () => ({ from: '0.5.1' }), rollBack, undoRollBack, reexec, binaryWritable: () => true })
    expect(await updateOnStart(d)).toMatchObject({ kind: 'reexeced', version: '0.5.1', exitCode: 1 })
    expect(undoRollBack).toHaveBeenCalledWith(FILE, '0.6.0')
    expect(err.at(-1)).toBe('Open Walnut 0.5.1 did not start either, so 0.6.0 was not the cause; the next start runs 0.6.0 again.')
  })

  it('an npm install goes back the same way', async () => {
    const rollBack = vi.fn(async () => {})
    const reexec = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(ended())
    const { d } = deps(BASE, { rollBack, reexec })
    expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.5.1', exitCode: 0, rolledBackFrom: '0.6.0' })
    expect(rollBack).toHaveBeenCalledWith(BASE, '0.5.1', '0.6.0', 'exited with 1 before it served')
  })

  it('a version held back (it failed here before, or the install was moved back from it) is not installed', async () => {
    const installFile = vi.fn(async () => {})
    const { d, err } = deps(FILE, { installFile, binaryWritable: () => true, held: () => '0.6.0 did not start here before (x); it is skipped until a newer release is published' })
    expect((await updateOnStart(d)).decision).toMatchObject({ action: 'skip', reason: 'held' })
    expect(installFile).not.toHaveBeenCalled()
    expect(err).toEqual(['Open Walnut 0.6.0 is published, but 0.6.0 did not start here before (x); it is skipped until a newer release is published. Starting 0.5.1.'])
  })
})

describe('an npm install that did not bring its file', () => {
  it('installs once more when the launcher does not start the new version, then starts it', async () => {
    const versionOf = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('0.6.0 (abc12345, 2026-10-22)')
    const { d, run, reexec, err } = deps(BASE, { versionOf })
    expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: 0 })
    expect(run).toHaveBeenCalledTimes(2)
    expect(reexec).toHaveBeenCalledTimes(1)
    expect(err).toContain('The installed launcher does not start 0.6.0 (it printed: nothing); installing it once more.')
  })

  it('still not: the version before goes back, and it starts as it was', async () => {
    const versionOf = vi.fn(async () => null)
    const { d, run, reexec, err } = deps(BASE, { versionOf })
    expect(await updateOnStart(d)).toMatchObject({ kind: 'continue', installFailed: 'it still starts nothing' })
    expect(run.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      ['install', '-g', 'open-walnut@0.6.0', '--allow-scripts=open-walnut'], ['install', '-g', 'open-walnut@0.6.0', '--allow-scripts=open-walnut'], ['install', '-g', 'open-walnut@0.5.1', '--allow-scripts=open-walnut'],
    ])
    expect(reexec).not.toHaveBeenCalled()
    expect(err.at(-1)).toBe('Open Walnut 0.6.0 did not install its file for this machine (it still starts nothing); 0.5.1 is back.')
  })
})

describe('the start\'s own end', () => {
  it('a download longer than the budget goes on: the version in use starts now, and the card says a restart runs the new one', async () => {
    const installedLater = vi.fn()
    const markUnverified = vi.fn()
    const { d, err, reexec, stop } = deps(FILE, { binaryWritable: () => true, installedLater, markUnverified })
    let finish!: () => void
    let seen: AbortSignal | null = null
    d.installFile = (_install, _version, signal) => new Promise((resolve, reject) => {
      seen = signal
      signal.addEventListener('abort', () => reject(signal.reason))
      finish = () => resolve({ from: '0.5.1' })
      stop.fire(new Error('it took longer than 60 s'))
    })
    const out = await updateOnStart(d)
    expect(out).toMatchObject({ kind: 'continue', decision: { action: 'install-file' } })
    // Out of time is no reason to stop the download.
    expect(seen!.aborted).toBe(false)
    expect(reexec).not.toHaveBeenCalled()
    expect(err.at(-1)).toBe('Open Walnut 0.6.0 is still installing; starting 0.5.1 now. The install goes on, and the next start runs 0.6.0.')
    // Its first start is watched, whichever process makes it.
    expect(markUnverified).toHaveBeenLastCalledWith({ version: '0.6.0', from: '0.5.1' })
    finish()
    expect(await (out as { later: Promise<boolean> }).later).toBe(true)
    expect(installedLater).toHaveBeenCalledWith('0.6.0')
    expect(err.at(-1)).toBe('Installed Open Walnut 0.6.0; restart Walnut to use it.')
  })

  it('a signal while it installs stops it: nothing starts', async () => {
    const { d, reexec, stop } = deps(FILE, { binaryWritable: () => true })
    d.installFile = (_install, _version, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason))
      stop.fire(new Error('stopped by SIGTERM'), 'SIGTERM')
    })
    expect(await updateOnStart(d)).toEqual({ kind: 'stopped', signal: 'SIGTERM' })
    expect(reexec).not.toHaveBeenCalled()
    // npm's install the same: its own run ends, then nothing starts.
    const npm = deps(BASE)
    npm.d.run = vi.fn(async () => { npm.stop.fire(new Error('stopped by SIGINT'), 'SIGINT'); return 130 })
    expect(await updateOnStart(npm.d)).toEqual({ kind: 'stopped', signal: 'SIGINT' })
  })

  it('an npm install that outlives the budget goes on by itself, and the version in use starts now', async () => {
    const installedLater = vi.fn()
    let exit!: (code: number) => void
    const job = { done: new Promise<number>((resolve) => { exit = resolve }), quiet: vi.fn() }
    const startInstall = vi.fn(() => job)
    const { d, err, run, reexec, stop } = deps(BASE, { startInstall, installedLater, versionOf: async () => '0.6.0 (abc1234, 2026-10-24)' })
    const pending = updateOnStart(d)
    await Promise.resolve()
    stop.fire(new Error('it took longer than 60 s'))
    const out = await pending
    expect(out).toMatchObject({ kind: 'continue', decision: { action: 'install' } })
    expect(startInstall).toHaveBeenCalledWith('npm', ['install', '-g', 'open-walnut@0.6.0', '--allow-scripts=open-walnut'], '0.6.0')
    expect(run).not.toHaveBeenCalled()
    expect(reexec).not.toHaveBeenCalled()
    expect(job.quiet).toHaveBeenCalled()
    expect(err.at(-1)).toContain('is still installing; starting 0.5.1 now')
    exit(0)
    expect(await (out as { later: Promise<boolean> }).later).toBe(true)
    expect(installedLater).toHaveBeenCalledWith('0.6.0')
  })

  it('in time, the same install restarts into the new version as before', async () => {
    const startInstall = vi.fn(() => ({ done: Promise.resolve(0), quiet: vi.fn() }))
    const { d, reexec } = deps(BASE, { startInstall })
    expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: 0 })
    expect(reexec).toHaveBeenCalledTimes(1)
  })

  it('a background install that fails, or brings no file, leaves the version in use and says the next start tries again', async () => {
    for (const [code, printed, line] of [[1, '0.6.0', 'npm exited with 1'], [0, '0.5.1', 'does not start 0.6.0 (it printed: 0.5.1)']] as const) {
      const installedLater = vi.fn()
      const { d, err, stop } = deps(BASE, { startInstall: () => ({ done: new Promise((r) => setTimeout(() => r(code), 5)), quiet: () => {} }), installedLater, versionOf: async () => printed })
      const pending = updateOnStart(d)
      await Promise.resolve()
      stop.fire(new Error('it took longer than 60 s'))
      const out = await pending
      expect(await (out as { later: Promise<boolean> }).later).toBe(false)
      expect(installedLater).not.toHaveBeenCalled()
      expect(err.at(-1)).toContain(line)
    }
  })

  it('a signal while npm installs starts nothing, and npm finishes by itself', async () => {
    const job = { done: new Promise<number>(() => {}), quiet: vi.fn() }
    const markUnverified = vi.fn()
    const { d, err, reexec, stop } = deps(BASE, { startInstall: () => job, markUnverified })
    const pending = updateOnStart(d)
    await Promise.resolve()
    stop.fire(new Error('stopped by SIGTERM'), 'SIGTERM')
    expect(await pending).toEqual({ kind: 'stopped', signal: 'SIGTERM' })
    expect(reexec).not.toHaveBeenCalled()
    expect(err.at(-1)).toBe('Stopped by SIGTERM; the install of 0.6.0 finishes by itself, and the next start runs it.')
    expect(markUnverified).toHaveBeenCalledWith({ version: '0.6.0', from: '0.5.1' })
  })

  it('the first start of a version that went in after the budget is watched: one that exits before it serves is gone back from', async () => {
    const markUnverified = vi.fn()
    const rollBack = vi.fn(async () => {})
    const reexec = vi.fn().mockResolvedValueOnce(ended({ exitCode: 1, served: false, ms: 800 })).mockResolvedValueOnce(ended())
    const now = { ...BASE, current: '0.6.0', available: false }
    const { d, err, run } = deps(now, { unverified: async () => ({ version: '0.6.0', from: '0.5.1' }), markUnverified, rollBack, reexec })
    expect(await updateOnStart(d)).toEqual({ kind: 'reexeced', version: '0.5.1', exitCode: 0, rolledBackFrom: '0.6.0' })
    expect(err[0]).toBe('Open Walnut 0.6.0 went in while 0.5.1 served; starting it.')
    expect(reexec).toHaveBeenCalledWith({ [APPLIED_ENV]: '1' }, now.install)
    expect(rollBack).toHaveBeenCalledWith(now, '0.5.1', '0.6.0', 'exited with 1 before it served')
    expect(markUnverified).toHaveBeenCalledWith(null)
    expect(run).not.toHaveBeenCalled()
    // One that serves is simply running.
    const ok = deps(now, { unverified: async () => ({ version: '0.6.0', from: '0.5.1' }), markUnverified: vi.fn() })
    expect(await updateOnStart(ok.d)).toEqual({ kind: 'reexeced', version: '0.6.0', exitCode: 0 })
  })

  it('a pending version that is not in yet: kept while its install runs, forgotten when it failed', async () => {
    const pending = async () => ({ version: '0.6.0', from: '0.5.1' })
    const running = vi.fn()
    const a = deps(BASE, { unverified: pending, markUnverified: running, busy: async () => 'the install of 0.6.0 an earlier start began still runs (pid 7)' })
    expect(await updateOnStart(a.d)).toMatchObject({ kind: 'continue', decision: { action: 'skip', reason: 'installing' } })
    expect(running).not.toHaveBeenCalled()
    expect(a.checkNow).toHaveBeenCalledTimes(1)
    const failedInstall = vi.fn()
    const b = deps(BASE, { unverified: pending, markUnverified: failedInstall })
    expect(await updateOnStart(b.d)).toMatchObject({ kind: 'reexeced', version: '0.6.0' })
    expect(failedInstall).toHaveBeenCalledWith(null)
  })

  it('a background install that fails forgets the pending version', async () => {
    const markUnverified = vi.fn()
    const { d, stop } = deps(BASE, { startInstall: () => ({ done: new Promise((r) => setTimeout(() => r(1), 5)), quiet: () => {} }), markUnverified })
    const pending = updateOnStart(d)
    await Promise.resolve()
    stop.fire(new Error('it took longer than 60 s'))
    const out = await pending
    expect(await (out as { later: Promise<boolean> }).later).toBe(false)
    expect(markUnverified.mock.calls).toEqual([[{ version: '0.6.0', from: '0.5.1' }], [null]])
  })

  it('an install an earlier start began and that still runs: no second npm into the same prefix', async () => {
    const startInstall = vi.fn()
    const { d, err, run } = deps(BASE, { startInstall, busy: async () => 'the install of 0.6.0 an earlier start began still runs (pid 4242)' })
    expect(await updateOnStart(d)).toMatchObject({ kind: 'continue', decision: { action: 'skip', reason: 'installing' } })
    expect(startInstall).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(err.at(-1)).toBe('Open Walnut 0.6.0 is published, but the install of 0.6.0 an earlier start began still runs (pid 4242); starting 0.5.1 as it is.')
  })

  it('a launcher that updates the install itself starts the server without asking the registry', async () => {
    const { d, checkNow } = deps(FILE, { env: { [LAUNCHER_UPDATES_ENV]: '1' } })
    expect(await updateOnStart(d)).toEqual({ kind: 'continue', decision: { action: 'skip', reason: 'launcher' } })
    expect(checkNow).not.toHaveBeenCalled()
  })

  it('watchStop hears SIGINT, SIGTERM and SIGHUP while it watches, and lets go of them after', () => {
    const before = process.listenerCount('SIGHUP')
    const stop = watchStop(60_000)
    expect(process.listenerCount('SIGHUP')).toBe(before + 1)
    process.emit('SIGHUP', 'SIGHUP')
    expect(stop.received()).toBe('SIGHUP')
    expect(stop.signal.aborted).toBe(true)
    stop.done()
    expect(process.listenerCount('SIGHUP')).toBe(before)
  })
})

describe('reexecSelf', () => {
  const as = (script: string) => ({ relaunch: ['/bin/sh', '-c', script, 'walnut'], binary: null }) as unknown as Parameters<typeof reexecSelf>[1]

  it('says whether the restarted server wrote its ready file before it exited, and with what code', async () => {
    const served = await reexecSelf({ PATH: guardedPath([], '/usr/bin:/bin') }, as(`echo $$ > "$${READY_FILE_ENV}"; exit 3`))
    expect(served).toMatchObject({ exitCode: 3, served: true, stopped: false })
    const crashed = await reexecSelf({ PATH: guardedPath([], '/usr/bin:/bin') }, as('exit 1'))
    expect(crashed).toMatchObject({ exitCode: 1, served: false, stopped: false })
    // Killed by a signal nobody here sent: a crash, with the shell's code for it.
    const killed = await reexecSelf({ PATH: guardedPath([], '/usr/bin:/bin') }, as('kill -TERM $$'))
    expect(killed).toMatchObject({ exitCode: 143, served: false, stopped: false })
  })
})

describe('relaunchArgv', () => {
  it('runs the install\'s own relaunch with this process\'s arguments, else this process again', () => {
    const fileArgv = ['bun', '/$bunfs/root/walnut', 'web', '--port', '3456']
    expect(relaunchArgv(FILE.install, fileArgv)).toEqual({ file: `${ROOT}/bin/walnut`, args: ['web', '--port', '3456'] })
    const viaLauncher = { relaunch: ['/usr/bin/node', '/usr/lib/node_modules/open-walnut/bin/open-walnut.js'], binary: null }
    expect(relaunchArgv(viaLauncher, fileArgv)).toEqual({ file: '/usr/bin/node', args: ['/usr/lib/node_modules/open-walnut/bin/open-walnut.js', 'web', '--port', '3456'] })
    const nodeArgv = ['/usr/bin/node', '/usr/lib/node_modules/open-walnut/bin/open-walnut.js', 'web']
    expect(relaunchArgv(null, nodeArgv, '/usr/bin/node')).toEqual({ file: '/usr/bin/node', args: ['/usr/lib/node_modules/open-walnut/bin/open-walnut.js', 'web'] })
    // The compiled file with no relaunch: itself again, without its own entry (it adds that itself).
    const npmFile = '/usr/lib/node_modules/open-walnut/node_modules/@open-walnut/linux-x64/walnut'
    expect(relaunchArgv({ relaunch: null, binary: null }, fileArgv, npmFile)).toEqual({ file: npmFile, args: ['web', '--port', '3456'] })
  })
})
