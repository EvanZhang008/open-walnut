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
import fs from 'node:fs'
import path from 'node:path'
import { decideServiceEntry } from '../../src/binary/service-entry.js'
import { readServiceRoleFallback, writeServiceMode } from '../../src/binary/service-mode.js'
import { armRoleReady, MAX_UNREADY_STARTS, serveReadySeconds, SERVICE_ROLE_STARTS_FILE } from '../../src/binary/service-lead-ready.js'
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
    leave, pid: 4242, now: () => Date.UTC(2026, 10, 25), log: () => {}, ...(readReady ? { readReady } : {}),
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
