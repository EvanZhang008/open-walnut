/**
 * A host's one Walnut service as the follower that does not come up (src/binary/service-lead-ready.ts
 * armRoleReady, role replica): not ready in time, or a crash at boot again and again once its version
 * is committed (the launcher starts it forever, the watch dies with it). Either way the fallback
 * marker, and the next start is the session daemon, which runs the follower as its child: the host
 * ends on the two programs by itself. The marker reaches the leader in hello's launcher facts
 * (service-launcher-beat.ts readLauncherFacts, launcherFactsFrom).
 * MACHINE SAFETY: temp dirs only; no process is started or signalled (leave is a spy).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { decideServiceEntry, serveWatchOn } from '../../src/binary/service-entry.js'
import { readServiceRoleFallback, writeServiceMode } from '../../src/binary/service-mode.js'
import { armRoleReady, BUSY_MARGIN_SECONDS, busyUntilMs, MAX_UNREADY_STARTS, noteRoleStart, serveReadySeconds, SERVICE_ROLE_STARTS_FILE, STARTS_WINDOW_MS } from '../../src/binary/service-lead-ready.js'
import { guardedPath } from '../setup/exec-guard.js'
import { launcherFactsFrom, readLauncherFacts } from '../../src/providers/service-launcher-beat.js'
import { cleanRoleLayouts, LEADER, roleLayout } from './fixtures/service-role-layout.js'

afterAll(cleanRoleLayouts)
afterEach(() => { vi.useRealTimers() })

function served() {
  const l = roleLayout()
  writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
  const d = decideServiceEntry(l.env, l.exe)
  expect(d.kind).toBe('serve')
  if (d.kind !== 'serve') throw new Error('not served')
  return { l, d }
}

const arm = (l: ReturnType<typeof roleLayout>, serverEnv: Record<string, string>, leave: () => void, readReady?: (file: string) => Promise<string>) =>
  armRoleReady({ role: 'replica', home: LEADER, exe: l.exe, stateDir: l.state, serverEnv }, {
    leave, pid: 4242, log: () => {}, readBeat: async () => '', ...(readReady ? { readReady } : {}),
  })

describe('the follower role\'s ready watch', () => {
  it('reads its seconds once, 600 by default', () => {
    expect(serveReadySeconds({})).toBe(600)
    expect(serveReadySeconds({ WALNUT_SERVICE_SERVE_READY_SECONDS: '7' })).toBe(7)
  })

  it('not ready in time: the marker for its home, the planned leave once; the next start is the daemon', async () => {
    const { l, d } = served()
    vi.useFakeTimers()
    const leave = vi.fn()
    const watch = arm(l, { ...d.serverEnv, WALNUT_SERVICE_SERVE_READY_SECONDS: '30' }, leave, async () => '')
    expect(watch).not.toBeNull()
    await vi.advanceTimersByTimeAsync(31_000)
    expect(leave).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    expect(readServiceRoleFallback(l.state)).toMatchObject({ role: 'replica', home: LEADER, exe: l.exe, why: expect.stringMatching(/was not ready within 30 s/) })
    expect(decideServiceEntry(l.env, l.exe)).toMatchObject({ kind: 'daemon', why: expect.stringMatching(/replica role did not get ready in time/) })
  })

  it('starts that never got ready are counted; the one past the limit falls back at once, before the server loads', () => {
    const { l, d } = served()
    const leave = vi.fn()
    for (let i = 0; i < MAX_UNREADY_STARTS; i++) {
      // Each start's process dies before its ready mark (a crash at boot): its watch never fires.
      const w = arm(l, d.serverEnv, leave, async () => '')
      expect(w).not.toBeNull()
      w!.stop()
    }
    expect(leave).not.toHaveBeenCalled()
    expect(decideServiceEntry(l.env, l.exe).kind).toBe('serve')
    expect(arm(l, d.serverEnv, leave)).toBeNull()
    expect(leave).toHaveBeenCalledTimes(1)
    expect(readServiceRoleFallback(l.state)?.why).toMatch(new RegExp(`did not get ready in its last ${MAX_UNREADY_STARTS} starts`))
    expect(fs.existsSync(path.join(l.state, SERVICE_ROLE_STARTS_FILE))).toBe(false)
    expect(decideServiceEntry(l.env, l.exe)).toMatchObject({ kind: 'daemon' })
    // The next mode write (a newer build, or the same asked again) is the next try.
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    expect(decideServiceEntry(l.env, l.exe).kind).toBe('serve')
  })

  it('a start that got ready ends the count: crashes later start counting from one', async () => {
    const { l, d } = served()
    const leave = vi.fn()
    for (let i = 0; i < MAX_UNREADY_STARTS - 1; i++) arm(l, d.serverEnv, leave, async () => '')!.stop()
    vi.useFakeTimers()
    arm(l, { ...d.serverEnv, WALNUT_SERVICE_SERVE_READY_SECONDS: '30' }, leave, async () => 'pid=4242\n')
    await vi.advanceTimersByTimeAsync(3_000)
    vi.useRealTimers()
    expect(fs.existsSync(path.join(l.state, SERVICE_ROLE_STARTS_FILE))).toBe(false)
    for (let i = 0; i < MAX_UNREADY_STARTS; i++) arm(l, d.serverEnv, leave, async () => '')!.stop()
    expect(leave).not.toHaveBeenCalled()
  })

  it('another version\'s count does not carry over', () => {
    const { l, d } = served()
    const leave = vi.fn()
    for (let i = 0; i < MAX_UNREADY_STARTS; i++) arm(l, d.serverEnv, leave, async () => '')!.stop()
    const w = armRoleReady({ role: 'replica', home: LEADER, exe: `${l.exe}-newer`, stateDir: l.state, serverEnv: d.serverEnv }, { leave, log: () => {}, readReady: async () => '' })
    expect(w).not.toBeNull()
    w!.stop()
    expect(leave).not.toHaveBeenCalled()
  })

  it('the marker reaches the leader in the launcher facts, and only one that reads whole', async () => {
    const { l, d } = served()
    const leave = vi.fn()
    for (let i = 0; i <= MAX_UNREADY_STARTS; i++) arm(l, d.serverEnv, leave, async () => '')?.stop()
    const facts = await readLauncherFacts(path.join(l.state, 'launcher'))
    expect(facts?.roleFallback).toMatchObject({ role: 'replica', home: LEADER, exe: l.exe, why: expect.stringMatching(/did not get ready/) })
    // As a leader reads hello: checked field by field.
    expect(launcherFactsFrom(JSON.parse(JSON.stringify(facts)))?.roleFallback).toEqual(facts!.roleFallback)
    expect(launcherFactsFrom({ ...facts, roleFallback: { role: 'x', home: LEADER, exe: l.exe } })?.roleFallback).toBeUndefined()
    // No marker: no fact.
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    expect((await readLauncherFacts(path.join(l.state, 'launcher')))?.roleFallback).toBeUndefined()
  })
})

describe('where the follower watch runs', () => {
  it('on a Mac only (the one service is new there, macos_one_service); a Linux host keeps today\'s start, unwatched', () => {
    expect(serveWatchOn({}, 'darwin')).toBe(true)
    expect(serveWatchOn({}, 'linux')).toBe(false)
    expect(serveWatchOn({ WALNUT_SERVICE_ROLE_WATCH: '1' }, 'linux')).toBe(true)
    expect(serveWatchOn({ WALNUT_SERVICE_ROLE_WATCH: '0' }, 'darwin')).toBe(false)
  })
})

describe('a slow but healthy follower', () => {
  it('its busy word (session adoption, 600 s from the port listening) is waited out with a margin; it gets ready near the end and is never cut', async () => {
    const { l, d } = served()
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 25) })
    const leave = vi.fn()
    let ready = ''
    let beat = ''
    const pid = 4242
    armRoleReady({ role: 'replica', home: LEADER, exe: l.exe, stateDir: l.state, serverEnv: { ...d.serverEnv, WALNUT_SERVICE_SERVE_READY_SECONDS: '60' } }, {
      leave, pid, log: () => {}, readReady: async () => ready, readBeat: async () => beat,
    })
    // The port listens at 50 s: the server beats busy for its adoption.
    await vi.advanceTimersByTimeAsync(50_000)
    beat = `${Math.floor(Date.now() / 1000)} ${Math.floor(Date.now() / 1000) + 600} ${pid}\n`
    // Past the boot budget, inside the busy word plus its margin: still waiting.
    await vi.advanceTimersByTimeAsync((600 + BUSY_MARGIN_SECONDS - 10) * 1000)
    expect(leave).not.toHaveBeenCalled()
    ready = `pid=${pid}\n`
    await vi.advanceTimersByTimeAsync(30_000)
    expect(leave).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(l.state, SERVICE_ROLE_STARTS_FILE))).toBe(false)
  })

  it('past its busy word and margin with no ready mark: the fallback', async () => {
    const { l, d } = served()
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 25) })
    const leave = vi.fn()
    const pid = 4242
    const beat = `${Math.floor(Date.now() / 1000)} ${Math.floor(Date.now() / 1000) + 100} ${pid}\n`
    armRoleReady({ role: 'replica', home: LEADER, exe: l.exe, stateDir: l.state, serverEnv: { ...d.serverEnv, WALNUT_SERVICE_SERVE_READY_SECONDS: '60' } }, {
      leave, pid, log: () => {}, readReady: async () => '', readBeat: async () => beat,
    })
    await vi.advanceTimersByTimeAsync((100 + BUSY_MARGIN_SECONDS - 5) * 1000)
    expect(leave).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('a beat of another process says nothing', () => {
    expect(busyUntilMs('1 200 4242\n', 4242)).toBe(200_000)
    expect(busyUntilMs('1 200 1\n', 4242)).toBeNull()
    expect(busyUntilMs('', 4242)).toBeNull()
  })
})

describe('the start count\'s window', () => {
  it('a start more than an hour after the one counted before begins a new count (planned stops weeks apart are no crash loop)', () => {
    const { l } = served()
    const d = { role: 'replica' as const, home: LEADER, exe: l.exe }
    const t0 = Date.UTC(2026, 10, 1)
    expect(noteRoleStart(l.state, d, t0)).toBe(1)
    expect(noteRoleStart(l.state, d, t0 + 60_000)).toBe(2)
    expect(noteRoleStart(l.state, d, t0 + 60_000 + STARTS_WINDOW_MS)).toBe(1)
  })
})

// runHostService's wiring (service-entry.ts watchServeRole), run for real in a child process: the
// start past the limit ends before the server loads (the fixture's runtime throws if it were loaded),
// with the launcher's leaving mark (a planned exit: no crash, no trial rollback), exit 0, and the marker.
describe('runHostService ends a start past the limit the planned way', () => {
  it('leaving mark, fallback marker, exit 0, no server load', async () => {
    const { l, d } = served()
    const exe = process.execPath
    fs.writeFileSync(path.join(l.state, SERVICE_ROLE_STARTS_FILE), JSON.stringify({ v: 1, role: 'replica', home: LEADER, exe, n: MAX_UNREADY_STARTS, at: Date.now() }))
    const runtimeDir = path.join(l.root, 'runtime-held-by-none')
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    const decision = {
      ...d, runtimeDir, cwd: path.join(l.root, 'data'),
      serverEnv: { PATH: guardedPath(), HOME: l.root, WALNUT_LAUNCHER_DIR: l.env.WALNUT_LAUNCHER_DIR!, WALNUT_SERVICE_ROLE_WATCH: '1' },
    }
    const runner = path.join(__dirname, 'fixtures', 'run-host-service.ts')
    const result = await promisify(execFile)(exe, [runner, JSON.stringify(decision)], { timeout: 60_000 })
      .then(() => ({ code: 0, stderr: '' }), (err: { code?: number; stderr?: string }) => ({ code: err.code, stderr: String(err.stderr ?? '') }))
    expect(result, result.stderr).toMatchObject({ code: 0 })
    const leaving = fs.readFileSync(path.join(l.env.WALNUT_LAUNCHER_DIR!, 'leaving'), 'utf8')
    expect(leaving).toMatch(/^pid=\d+\nreason=the Walnut service did not get ready in its last starts/)
    expect(readServiceRoleFallback(l.state)).toMatchObject({ role: 'replica', home: LEADER })
  }, 90_000)
})
