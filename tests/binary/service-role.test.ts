/**
 * The service mode's role (src/binary/service-mode.ts) and what the `--service` entry makes of it
 * (service-entry.ts decideServiceEntry): the format and its defaults, the one writer setServiceRole
 * (idempotent, ownership by Walnut, never by path; the checks it makes at write time; the version it
 * names; the fallback marker it clears; no signal), the update path's nextServiceMode (it keeps the
 * role and never changes a leading machine's), the `lead` decision and its env, and the fallback
 * marker that turns the next start into the daemon.
 * MACHINE SAFETY: temp dirs only; no process is started or signalled.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { decideServiceEntry } from '../../src/binary/service-entry.js'
import {
  nextServiceMode, readServiceMode, readServiceRoleFallback, serviceRoleOf, setServiceRole, writeServiceMode, writeServiceRoleFallback,
  ServiceRoleError, SERVICE_MODE_FILE, SERVICE_ROLE_FALLBACK_FILE,
} from '../../src/binary/service-mode.js'
import { cleanRoleLayouts, LEADER, modeText, roleLayout, TOKEN } from './fixtures/service-role-layout.js'

afterAll(cleanRoleLayouts)
afterEach(() => { vi.restoreAllMocks() })

const codeOf = (fn: () => unknown): string => {
  try { fn() } catch (err) { return err instanceof ServiceRoleError ? err.code : `not a ServiceRoleError: ${String(err)}` }
  return 'no throw'
}

describe('the format: role absent is replica', () => {
  it('a mode with no role reads as it was written, a replica', () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    const read = readServiceMode(l.state)
    expect(read).toEqual({ mode: { v: 1, home: LEADER, exe: l.exe } })
    expect('mode' in read && serviceRoleOf(read.mode)).toBe('replica')
  })

  it('a leader mode reads its role and its Walnut', () => {
    const l = roleLayout()
    fs.writeFileSync(path.join(l.state, SERVICE_MODE_FILE), JSON.stringify({ v: 1, home: l.promoted, exe: l.exe, role: 'leader', walnutId: 'w1' }))
    expect(readServiceMode(l.state)).toEqual({ mode: { v: 1, home: l.promoted, exe: l.exe, role: 'leader', walnutId: 'w1' } })
  })

  it('a role that is neither is a doubt: the daemon runs', () => {
    const l = roleLayout()
    fs.writeFileSync(path.join(l.state, SERVICE_MODE_FILE), JSON.stringify({ v: 1, home: LEADER, exe: l.exe, role: 'boss' }))
    expect(readServiceMode(l.state)).toMatchObject({ why: expect.stringMatching(/neither replica nor leader/) })
    const d = decideServiceEntry(l.env, l.exe)
    expect(d.kind === 'daemon' && d.why).toMatch(/neither replica nor leader/)
  })
})

describe('setServiceRole: the one writer', () => {
  it('writes a replica role for the one follower spec, naming the launcher\'s version, and is idempotent', () => {
    const l = roleLayout()
    const first = setServiceRole(l.state, { role: 'replica', home: LEADER, walnutId: 'w1' })
    expect(first).toEqual({ previous: null, changed: true })
    expect(JSON.parse(modeText(l.state))).toEqual({ v: 1, home: LEADER, exe: l.exe, walnutId: 'w1' })
    expect(fs.statSync(path.join(l.state, SERVICE_MODE_FILE)).mode & 0o777).toBe(0o600)
    const writes = vi.spyOn(fs, 'writeFileSync')
    const again = setServiceRole(l.state, { role: 'replica', home: LEADER, walnutId: 'w1' })
    expect(again).toEqual({ previous: { v: 1, home: LEADER, exe: l.exe, walnutId: 'w1' }, changed: false })
    expect(writes).not.toHaveBeenCalled()
  })

  it('makes a machine lead on its promoted home, keeping the mode\'s version, and back', () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: '/versions/older/walnut' })
    expect(setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }).changed).toBe(true)
    expect(JSON.parse(modeText(l.state))).toEqual({ v: 1, home: l.promoted, exe: '/versions/older/walnut', role: 'leader', walnutId: 'w1' })
    expect(setServiceRole(l.state, { role: 'replica', home: LEADER, walnutId: 'w1' })).toMatchObject({ changed: true, previous: { role: 'leader' } })
  })

  it('ownership is by Walnut, never by path: another Walnut\'s mode is refused, in either role', () => {
    const l = roleLayout()
    // A replica mode with no walnutId of its own: its follower spec says whose it is.
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w2' }))).toBe('not_service_owner')
    // Another home, the same Walnut: allowed (the switch writes the promoted home over the old leader's).
    expect(setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }).changed).toBe(true)
    // A leader mode names its Walnut itself.
    expect(codeOf(() => setServiceRole(l.state, { role: 'replica', home: LEADER, walnutId: 'w2' }))).toBe('not_service_owner')
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w2' }))).toBe('not_service_owner')
  })

  // Review point 6: the spec's Walnut is its validated top-level walnutId (host-server-core.ts validate),
  // never the env value the follower is started with.
  it('the follower spec\'s Walnut is its top-level walnutId, never its env', () => {
    const noEnv = roleLayout({ envWalnutId: null })
    writeServiceMode(noEnv.state, { v: 1, home: LEADER, exe: noEnv.exe })
    expect(codeOf(() => setServiceRole(noEnv.state, { role: 'leader', home: noEnv.promoted, walnutId: 'w2' }))).toBe('not_service_owner')
    expect(setServiceRole(noEnv.state, { role: 'leader', home: noEnv.promoted, walnutId: 'w1' }).changed).toBe(true)
    // An env that names another Walnut does not decide it.
    const otherEnv = roleLayout({ envWalnutId: 'w9' })
    expect(setServiceRole(otherEnv.state, { role: 'replica', home: LEADER, walnutId: 'w1' }).changed).toBe(true)
  })

  it('a replica role needs exactly one follower spec for its home, of the same Walnut, at write time', () => {
    expect(codeOf(() => setServiceRole(roleLayout({ specs: 0 }).state, { role: 'replica', home: LEADER, walnutId: 'w1' }))).toBe('no_follower_spec')
    expect(codeOf(() => setServiceRole(roleLayout({ specs: 2 }).state, { role: 'replica', home: LEADER, walnutId: 'w1' }))).toBe('no_follower_spec')
    expect(codeOf(() => setServiceRole(roleLayout({ walnutId: 'w9' }).state, { role: 'replica', home: LEADER, walnutId: 'w1' }))).toBe('not_service_owner')
  })

  it('a leader role needs an existing absolute data dir', () => {
    const l = roleLayout()
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: path.join(l.root, 'missing'), walnutId: 'w1' }))).toBe('no_leader_home')
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: 'relative/home', walnutId: 'w1' }))).toBe('no_leader_home')
    fs.writeFileSync(path.join(l.root, 'a-file'), '')
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: path.join(l.root, 'a-file'), walnutId: 'w1' }))).toBe('no_leader_home')
    expect(fs.existsSync(path.join(l.state, SERVICE_MODE_FILE))).toBe(false)
  })

  it('no mode and no launcher state: no version to name, refused', () => {
    const l = roleLayout({ launcher: false })
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' }))).toBe('no_launcher')
  })

  it('a bad request is refused before anything is read', () => {
    const l = roleLayout()
    expect(codeOf(() => setServiceRole(l.state, { role: 'boss' as 'leader', home: l.promoted, walnutId: 'w1' }))).toBe('bad_request')
    expect(codeOf(() => setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: '' }))).toBe('bad_request')
    expect(codeOf(() => setServiceRole('relative', { role: 'leader', home: l.promoted, walnutId: 'w1' }))).toBe('bad_request')
  })

  it('a write clears the fallback marker and signals nothing', () => {
    const l = roleLayout()
    writeServiceRoleFallback(l.state, { role: 'leader', home: l.promoted, exe: l.exe, at: 1, why: 'late' })
    const kill = vi.spyOn(process, 'kill')
    setServiceRole(l.state, { role: 'leader', home: l.promoted, walnutId: 'w1' })
    expect(fs.existsSync(path.join(l.state, SERVICE_ROLE_FALLBACK_FILE))).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})

describe('nextServiceMode: the update keeps the role', () => {
  const lead = { v: 1 as const, home: '/data/promoted', exe: '/old', role: 'leader' as const, walnutId: 'w1' }

  it('carries the role and the Walnut over to the new version', () => {
    expect(nextServiceMode(lead, undefined, '/new')).toEqual({ mode: { ...lead, exe: '/new' } })
    const rep = { v: 1 as const, home: LEADER, exe: '/old', walnutId: 'w1' }
    expect(nextServiceMode(rep, undefined, '/new')).toEqual({ mode: { ...rep, exe: '/new' } })
    expect(nextServiceMode(rep, { home: LEADER, on: true }, '/new')).toEqual({ mode: { ...rep, exe: '/new' } })
  })

  it('a leading machine\'s role is the leader switch\'s alone: --serve and --no-serve leave it as it is', () => {
    for (const ask of [{ home: lead.home, on: false }, { home: lead.home, on: true }, { home: LEADER, on: false }, { home: LEADER, on: true }]) {
      const next = nextServiceMode(lead, ask, '/new')
      expect(next.mode).toEqual({ ...lead, exe: '/new' })
      expect(next.note).toMatch(/^service_leads: only the leader switch changes a leading machine's role/)
    }
  })

  it('the update\'s mode write clears the fallback marker too', () => {
    const l = roleLayout()
    writeServiceRoleFallback(l.state, { role: 'leader', home: l.promoted, exe: l.exe, at: 1, why: 'late' })
    writeServiceMode(l.state, { ...lead, exe: l.exe })
    expect(readServiceRoleFallback(l.state)).toBeNull()
  })
})

describe('decideServiceEntry: lead', () => {
  function leading() {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: l.promoted, exe: l.exe, role: 'leader', walnutId: 'w1' })
    return l
  }

  it('runs the leader on the promoted home with the launcher\'s env and nothing that makes a follower', () => {
    const l = leading()
    // The placement key comes only from a follower spec's env, which a leading service never reads.
    const env = { ...l.env, WALNUT_ROLE: 'replica', WALNUT_HOST_SERVER: '1', WALNUT_FOLLOWER_TOKEN: TOKEN }
    const d = decideServiceEntry(env, l.exe)
    expect(d.kind).toBe('lead')
    if (d.kind !== 'lead') return
    expect(d).toMatchObject({ home: l.promoted, exe: l.exe, cwd: l.promoted, runtimeDir: l.env.WALNUT_DAEMON_DIR, stateDir: l.state })
    expect(d.serverEnv).toMatchObject({
      OPEN_WALNUT_HOME: l.promoted, WALNUT_LAUNCHER_DIR: l.env.WALNUT_LAUNCHER_DIR, WALNUT_DAEMON_DIR: l.env.WALNUT_DAEMON_DIR,
      HOME: l.root, WALNUT_NO_AUTO_UPDATE: '1', WALNUT_LAUNCHER_UPDATES: '1',
    })
    for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_SERVER', 'WALNUT_FOLLOWER_TOKEN', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_SUPERVISOR']) {
      expect(d.serverEnv[k], k).toBeUndefined()
    }
    // The runtime: the launcher's env minus its marks, as the follower's runtime gets it.
    expect(d.runtimeEnv.WALNUT_DAEMON_STATE_DIR).toBe(l.state)
    expect(d.runtimeEnv.WALNUT_LAUNCHER_DIR).toBeUndefined()
  })

  it('names the pid files of this Walnut\'s followers, whatever home they follow, to stop them first', () => {
    const l = leading()
    const d = decideServiceEntry(l.env, l.exe)
    expect(d.kind === 'lead' && d.followerPidFiles).toEqual([path.join(l.state, 'host-server', 'server-0000000000000000.pid')])
    const other = roleLayout({ walnutId: 'w2' })
    writeServiceMode(other.state, { v: 1, home: other.promoted, exe: other.exe, role: 'leader', walnutId: 'w1' })
    const none = decideServiceEntry(other.env, other.exe)
    expect(none.kind === 'lead' && none.followerPidFiles).toEqual([])
  })

  it('needs no follower spec', () => {
    const l = roleLayout({ specs: 0 })
    writeServiceMode(l.state, { v: 1, home: l.promoted, exe: l.exe, role: 'leader', walnutId: 'w1' })
    expect(decideServiceEntry(l.env, l.exe).kind).toBe('lead')
  })

  it('the checks that apply stay: another version, no launcher, a home that is not a directory', () => {
    const l = leading()
    expect(decideServiceEntry(l.env, '/versions/other/walnut')).toMatchObject({ kind: 'daemon', why: expect.stringMatching(/is for/) })
    const { WALNUT_LAUNCHER_DIR: _gone, ...noLauncher } = l.env
    expect(decideServiceEntry(noLauncher, l.exe)).toMatchObject({ kind: 'daemon', why: expect.stringMatching(/service launcher/) })
    fs.rmSync(l.promoted, { recursive: true })
    expect(decideServiceEntry(l.env, l.exe)).toMatchObject({ kind: 'daemon', why: expect.stringMatching(/is not a directory/) })
  })

  it('a fallback marker for this mode runs the daemon; one for another version or home does not', () => {
    const l = leading()
    const at = Date.UTC(2026, 10, 23, 12, 0, 0)
    writeServiceRoleFallback(l.state, { role: 'leader', home: l.promoted, exe: l.exe, at, why: 'late' })
    expect(decideServiceEntry(l.env, l.exe)).toEqual({
      kind: 'daemon', why: 'the leader role did not get ready in time at 2026-11-23T12:00:00.000Z; the next mode write or version tries it again',
    })
    writeServiceRoleFallback(l.state, { role: 'leader', home: l.promoted, exe: '/versions/older/walnut', at, why: 'late' })
    expect(decideServiceEntry(l.env, l.exe).kind).toBe('lead')
    writeServiceRoleFallback(l.state, { role: 'leader', home: '/another/home', exe: l.exe, at, why: 'late' })
    expect(decideServiceEntry(l.env, l.exe).kind).toBe('lead')
    // The marker never touched the mode.
    expect(readServiceMode(l.state)).toMatchObject({ mode: { role: 'leader', home: l.promoted } })
  })

  it('a replica mode is decided as before (the follower), the marker of a leader aside', () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    writeServiceRoleFallback(l.state, { role: 'leader', home: LEADER, exe: l.exe, at: 1, why: 'late' })
    expect(decideServiceEntry(l.env, l.exe)).toMatchObject({ kind: 'serve', home: LEADER })
  })
})
