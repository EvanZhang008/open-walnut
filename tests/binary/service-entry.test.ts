/**
 * What the launcher's `--service` runs (src/binary/service-entry.ts): the host's one Walnut service
 * only when the mode file names this very version and the follower spec it names is a sound replica
 * spec; every doubt answers `daemon`, with the reason. And the mode file's rules: only the Walnut
 * it names changes it; every other update carries it over to the version it stages.
 * MACHINE SAFETY: temp dirs only; the only processes started are this test's own children (a
 * `sleep` in its own group standing for a follower, and the fixture runner), stopped by their pid.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { decideServiceEntry, pinRuntimePlace, stopOldFollowers } from '../../src/binary/service-entry.js'
import { nextServiceMode, readServiceMode, writeServiceMode, SERVICE_MODE_FILE } from '../../src/binary/service-mode.js'
import { RUNTIME_PLACE_ENV, runtimeRootsFor } from '../../src/binary/runtime-tree.js'
import { defaultReadStartTime } from '../../src/providers/daemon-core.js'
import { acquireDaemonInstanceLock } from '../../src/providers/daemon-instance-lock.js'
import { guardedPath } from '../setup/exec-guard.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

const HOME = '/leader/walnut-home'
const TOKEN = 'a'.repeat(64)

function layout(opts: { mode?: unknown; spec?: Record<string, unknown> | null; saved?: Record<string, unknown>; extraSpec?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-entry-'))
  roots.push(root)
  const state = path.join(root, 'state')
  const exe = path.join(state, 'versions', 'abc', 'daemon')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, '')
  fs.mkdirSync(path.join(state, 'host-server'), { recursive: true })
  const spec = {
    v: 1, home: HOME, walnutId: 'w1', command: '/usr/bin/node', args: ['cli.js', 'web', '--replica'],
    cwd: path.join(root, 'data'), log: path.join(root, 'out.log'), port: 4567, settings: {},
    env: {
      OPEN_WALNUT_HOME: path.join(root, 'data'), WALNUT_DAEMON_DIR: path.join(root, 'run'), WALNUT_HOST_SERVER: '1',
      WALNUT_HOST_SERVER_PORT: '4567', WALNUT_LEADER_HOME: HOME, WALNUT_WALNUT_ID: 'w1', WALNUT_ROLE: 'replica',
      WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: 'dev',
    },
    ...(opts.spec ?? {}),
  }
  if (opts.spec !== null) {
    fs.writeFileSync(path.join(state, 'host-server', 'server-0123456789abcdef.json'), JSON.stringify({ spec, token: TOKEN, ...(opts.saved ?? {}) }))
  }
  if (opts.extraSpec) fs.writeFileSync(path.join(state, 'host-server', 'server-fedcba9876543210.json'), JSON.stringify({ spec, token: TOKEN }))
  if (opts.mode !== undefined) fs.writeFileSync(path.join(state, SERVICE_MODE_FILE), typeof opts.mode === 'string' ? opts.mode : JSON.stringify(opts.mode))
  const env: NodeJS.ProcessEnv = {
    HOME: root, PATH: guardedPath(), WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_DAEMON_STATE_DIR: state,
    WALNUT_DAEMON_SUPERVISOR: 'launcher', WALNUT_LAUNCHER_DIR: path.join(state, 'launcher'),
  }
  return { root, state, exe, env }
}

describe('decideServiceEntry: every doubt is the daemon', () => {
  it('no mode file is the daemon, quietly (every host before the switch)', () => {
    const l = layout()
    expect(decideServiceEntry(l.env, l.exe)).toEqual({ kind: 'daemon', why: 'no service-mode.json', quiet: true })
  })

  const cases: Array<[string, () => { env: NodeJS.ProcessEnv; exe: string }, RegExp]> = [
    ['an unreadable mode file', () => layout({ mode: '{not json' }), /not JSON/],
    ['a mode of another shape', () => layout({ mode: { v: 2, home: HOME, exe: '/x' } }), /not a v1 mode/],
    ['a mode for another version', () => { const l = layout(); fs.writeFileSync(path.join(l.state, SERVICE_MODE_FILE), JSON.stringify({ v: 1, home: HOME, exe: '/other/daemon' })); return l }, /is for \/other\/daemon/],
    ['no launcher', () => { const l = withMode(layout()); delete l.env.WALNUT_LAUNCHER_DIR; return l }, /service launcher/],
    ['no spec for the home', () => withMode(layout({ spec: null })), /no follower spec/],
    ['two specs for the home', () => withMode(layout({ extraSpec: true })), /2 follower specs/],
    ['a spec with no token', () => withMode(layout({ saved: { token: 'short' } })), /no token/],
    ['a spec in its fallback hour', () => withMode(layout({ saved: { fallback: { since: 1, until: 2 } } })), /fallback/],
    ['the plain host server, not the replica', () => withMode(layout({ spec: { env: { OPEN_WALNUT_HOME: '/d', WALNUT_DAEMON_DIR: '/r' } } })), /not the replica/],
    ['a spec with no run dir of its own', () => withMode(layout({ spec: { env: { WALNUT_ROLE: 'replica', OPEN_WALNUT_HOME: '/d' } } })), /data dir and run dir/],
  ]
  for (const [name, make, why] of cases) {
    it(name, () => {
      const l = make()
      const d = decideServiceEntry(l.env, l.exe)
      expect(d.kind).toBe('daemon')
      expect(d.kind === 'daemon' && d.why).toMatch(why)
      expect(d.kind === 'daemon' && d.quiet).toBeFalsy()
    })
  }

  it('a run dir that is the daemon dir', () => {
    const l = layout()
    const spec = JSON.parse(fs.readFileSync(path.join(l.state, 'host-server', 'server-0123456789abcdef.json'), 'utf8'))
    spec.spec.env.WALNUT_DAEMON_DIR = l.env.WALNUT_DAEMON_DIR
    fs.writeFileSync(path.join(l.state, 'host-server', 'server-0123456789abcdef.json'), JSON.stringify(spec))
    const d = decideServiceEntry(withMode(l).env, l.exe)
    expect(d.kind === 'daemon' && d.why).toMatch(/run dir is the daemon dir/)
  })
})

function withMode<T extends { state: string; exe: string }>(l: T): T {
  writeServiceMode(l.state, { v: 1, home: HOME, exe: l.exe })
  return l
}

describe('decideServiceEntry: the service', () => {
  it('runs the follower of the home the mode names, with the runtime env kept apart', () => {
    const l = withMode(layout())
    const d = decideServiceEntry(l.env, l.exe)
    expect(d.kind).toBe('serve')
    if (d.kind !== 'serve') return
    expect(d.home).toBe(HOME)
    expect(d.pidFile).toBe(path.join(l.state, 'host-server', 'server-0123456789abcdef.pid'))
    expect(d.runtimeDir).toBe(l.env.WALNUT_DAEMON_DIR)
    expect(d.cwd).toBe(path.join(l.root, 'data'))
    // The server: the spec's env, its token, the runtime's dir to dial, its launcher; never the runtime's state.
    expect(d.serverEnv).toMatchObject({
      OPEN_WALNUT_HOME: path.join(l.root, 'data'), WALNUT_DAEMON_DIR: path.join(l.root, 'run'), WALNUT_ROLE: 'replica',
      WALNUT_FOLLOWER_TOKEN: TOKEN, WALNUT_HOST_DAEMON_DIR: l.env.WALNUT_DAEMON_DIR, WALNUT_NO_AUTO_UPDATE: '1',
      WALNUT_LAUNCHER_DIR: l.env.WALNUT_LAUNCHER_DIR, HOME: l.root,
    })
    expect(d.serverEnv.WALNUT_DAEMON_STATE_DIR).toBeUndefined()
    expect(d.serverEnv.WALNUT_DAEMON_SUPERVISOR).toBeUndefined()
    // The runtime: exactly what the launcher exported for the daemon, minus the launcher's marks.
    const { WALNUT_LAUNCHER_DIR: _l, ...launcherRest } = l.env
    expect(d.runtimeEnv).toEqual(launcherRest)
  })
})

describe('the mode file', () => {
  it('reads what it writes, and null removes it', () => {
    const l = layout()
    writeServiceMode(l.state, { v: 1, home: HOME, exe: l.exe })
    expect(readServiceMode(l.state)).toEqual({ mode: { v: 1, home: HOME, exe: l.exe } })
    expect(fs.statSync(path.join(l.state, SERVICE_MODE_FILE)).mode & 0o777).toBe(0o600)
    writeServiceMode(l.state, null)
    expect(readServiceMode(l.state)).toEqual({ why: 'no service-mode.json', missing: true })
  })

  it('only the Walnut it names changes it; any other update carries it to the new version', () => {
    const cur = { v: 1 as const, home: HOME, exe: '/old' }
    expect(nextServiceMode(null, { home: HOME, on: true }, '/new')).toEqual({ mode: { v: 1, home: HOME, exe: '/new' } })
    expect(nextServiceMode(cur, { home: HOME, on: false }, '/new')).toEqual({ mode: null })
    expect(nextServiceMode(cur, undefined, '/new')).toEqual({ mode: { v: 1, home: HOME, exe: '/new' } })
    expect(nextServiceMode(null, undefined, '/new')).toEqual({ mode: null })
    const other = nextServiceMode(cur, { home: '/another/home', on: false }, '/new')
    expect(other.mode).toEqual({ v: 1, home: HOME, exe: '/new' })
    expect(other.note).toMatch(/^not_service_owner/)
    expect(nextServiceMode(cur, { home: '/another/home', on: true }, '/new').mode).toEqual({ v: 1, home: HOME, exe: '/new' })
  })
})

// Review A3b S34-L2: the service stopped the old follower before its runtime refused the dir a
// daemon still held, so each launcher restart stopped a follower that daemon started again.
describe('runHostService while a daemon still holds the runtime dir', () => {
  it('leaves the follower that daemon keeps running, keeps its pid file, and ends with exit 1', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-held-'))
    roots.push(root)
    const runtimeDir = path.join(root, 'daemon')
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    const uid = process.getuid!()
    // This test process holds the lock, as the daemon would (another pid than the runner's).
    const lock = await acquireDaemonInstanceLock({ runtimeDir, uid, pid: process.pid, instanceId: crypto.randomUUID() })
    expect(lock.kind).toBe('owner')
    const follower = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    const pid = follower.pid!
    try {
      const pidFile = path.join(root, 'server-0123456789abcdef.pid')
      fs.writeFileSync(pidFile, JSON.stringify({ pid, startTime: defaultReadStartTime(fs, pid) }))
      const decision = {
        kind: 'serve', home: HOME, specFile: pidFile.replace(/\.pid$/, '.json'), pidFile,
        serverEnv: { PATH: guardedPath(), HOME: root }, runtimeEnv: {},
        runtimeDir, stateDir: root, cwd: path.join(root, 'data'),
      }
      const runner = path.join(__dirname, 'fixtures', 'run-host-service.ts')
      const result = await promisify(execFile)(process.execPath, [runner, JSON.stringify(decision)], { timeout: 60_000 })
        .then(() => ({ code: 0, stderr: '' }), (err: { code?: number; stderr?: string }) => ({ code: err.code, stderr: String(err.stderr ?? '') }))
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`daemon ${process.pid} still holds ${runtimeDir}`)
      expect(() => process.kill(pid, 0), 'the follower runs on').not.toThrow()
      expect(fs.existsSync(pidFile)).toBe(true)
    } finally {
      try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ }
      if (lock.kind === 'owner') await lock.release()
    }
  }, 90_000)
})

// Review point 7: both roles stop the follower child an older daemon started before they serve
// (runHostService for its spec, runLeaderService for every spec of the Walnut it leads), and end
// when one does not stop or may still run.
describe('stopOldFollowers, the one stop of an older daemon\'s follower', () => {
  it('refuses to go on while one may still run, keeping its pid file; stops it for real otherwise', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-old-follower-'))
    roots.push(root)
    const follower = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
    const pid = follower.pid!
    const gone = new Promise((r) => follower.once('exit', r))
    try {
      const pidFile = path.join(root, 'server-0123456789abcdef.pid')
      fs.writeFileSync(pidFile, JSON.stringify({ pid, startTime: defaultReadStartTime(fs, pid) }))
      // Its start time does not read: it may still be the follower, so the start ends.
      expect(await stopOldFollowers([pidFile], { startTimeOf: () => null, exists: () => true, killGroup: () => {}, unknownRetryMs: 10 })).toBe(false)
      expect(fs.existsSync(pidFile)).toBe(true)
      expect(() => process.kill(pid, 0)).not.toThrow()
      // Read for real: stopped (its group), the pid file gone.
      expect(await stopOldFollowers([pidFile])).toBe(true)
      await gone
      expect(fs.existsSync(pidFile)).toBe(false)
      // Nothing recorded: nothing to stop.
      expect(await stopOldFollowers([pidFile, path.join(root, 'none.pid')])).toBe(true)
    } finally {
      try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ }
    }
  }, 30_000)
})

// 2026-11-22, a real host: the service unpacked its tree under the launcher's env, then took the
// follower's OPEN_WALNUT_HOME; the search embed worker it started from its own file looked for its
// script under the follower's data dir and the file answered "Unknown command".
describe('a program the service starts from its own file finds the tree the service runs from', () => {
  const ID = '0.0.0-abc123'
  const launcherEnv = { HOME: '/home/u' } as NodeJS.ProcessEnv
  const root = runtimeRootsFor(launcherEnv, ID)[0]!
  const follower = { OPEN_WALNUT_HOME: '/home/u/.open-walnut-host/walnuts/0123/data', WALNUT_ROLE: 'replica' }

  it('without the pin the follower env looks elsewhere (the bug)', () => {
    expect(runtimeRootsFor(follower, ID)[0]).not.toBe(root)
  })

  it('pinned, the follower env resolves the same tree, whatever it says of every key that moves the tree', () => {
    expect(runtimeRootsFor(pinRuntimePlace(follower, root), ID)[0]).toBe(root)
    // Every key runtime-tree.ts reads, set to another place by the follower's spec, still loses to the pin.
    for (const key of RUNTIME_PLACE_ENV) {
      const pinned = pinRuntimePlace({ ...follower, [key]: '/elsewhere' }, root)
      expect(runtimeRootsFor(pinned, ID)[0], key).toBe(root)
    }
    expect(pinRuntimePlace(follower, root)).toMatchObject(follower)
  })
})
