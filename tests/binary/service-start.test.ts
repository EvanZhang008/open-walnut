/**
 * The `--service` start around the decision: the start hooks (src/binary/service-start-hooks.ts:
 * order, one deadline, a throw, a setRole that changes the mode and so a second decision, env for
 * this start only, a run also when the start will be the daemon) and the leader's ready watch
 * (src/binary/service-lead-ready.ts: a ready mark naming this pid in time, or the fallback marker
 * and the planned stop, through an injected leave).
 * MACHINE SAFETY: temp dirs only; no process is started or signalled (leave is a spy).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { decideServiceEntry } from '../../src/binary/service-entry.js'
import { readServiceMode, readServiceRoleFallback, writeServiceMode } from '../../src/binary/service-mode.js'
import { prepareServiceStart, runServiceStartHooks, type ServiceStartContext, type ServiceStartHook } from '../../src/binary/service-start-hooks.js'
import { armLeadReady, leadReadySeconds, readyNames, watchLeadReady } from '../../src/binary/service-lead-ready.js'
import { cleanRoleLayouts, LEADER, roleLayout } from './fixtures/service-role-layout.js'

afterAll(cleanRoleLayouts)
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

const hook = (fn: ServiceStartHook) => async () => fn

function ctxFor(over: Partial<ServiceStartContext> = {}): ServiceStartContext & { logs: string[] } {
  const logs: string[] = []
  return {
    installRoot: '/state', runtimeDir: '/run', mode: { role: 'replica', home: LEADER, exe: '/exe' }, decision: 'serve',
    setRole: () => ({ previous: null, changed: false }),
    log: (level, msg) => { logs.push(`${level}: ${msg}`) },
    logs, ...over,
  }
}

describe('runServiceStartHooks', () => {
  it('runs the hooks in order and merges their env, a later one winning', async () => {
    const seen: number[] = []
    const r = await runServiceStartHooks(ctxFor(), [
      hook(async () => { seen.push(1); return { env: { A: '1', B: '1' }, note: 'first' } }),
      hook(async () => { seen.push(2); return { env: { B: '2' } } }),
    ])
    expect(seen).toEqual([1, 2])
    expect(r).toEqual({ env: { A: '1', B: '2' }, changed: false, notes: ['first'] })
  })

  it('a hook that throws is logged and the next one still runs', async () => {
    const ctx = ctxFor()
    const r = await runServiceStartHooks(ctx, [
      hook(async () => { throw new Error('records unreadable') }),
      hook(async () => ({ env: { C: '3' } })),
    ])
    expect(r.env).toEqual({ C: '3' })
    expect(ctx.logs.join('\n')).toMatch(/hook 0 failed/)
  })

  it('one deadline for all: a hook that hangs is no longer waited for, and its late setRole is refused', async () => {
    const ctx = ctxFor({ setRole: () => ({ previous: null, changed: true }) })
    let late: (() => void) | null = null
    let lateResult: unknown = null
    const r = await runServiceStartHooks(ctx, [
      hook(async () => ({ env: { D: '4' } })),
      hook((c) => new Promise<void>((resolve) => { late = () => { try { c.setRole({ role: 'leader', home: '/h', walnutId: 'w1' }) } catch (err) { lateResult = err } resolve() } })),
    ], 50)
    expect(r).toEqual({ env: { D: '4' }, changed: false, notes: [] })
    expect(ctx.logs.join('\n')).toMatch(/did not finish within 50 ms/)
    late!()
    expect(String(lateResult)).toMatch(/past their deadline/)
  })

  it('a setRole that changed the mode says so', async () => {
    const r = await runServiceStartHooks(ctxFor({ setRole: () => ({ previous: null, changed: true }) }), [
      hook(async (c) => { c.setRole({ role: 'leader', home: '/h', walnutId: 'w1' }) }),
    ])
    expect(r.changed).toBe(true)
  })
})

describe('prepareServiceStart', () => {
  it('a hook that makes the machine lead: the entry decides again and leads, the hook env in this start only', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    const seen: Array<Pick<ServiceStartContext, 'decision' | 'mode' | 'installRoot' | 'runtimeDir'>> = []
    const d = await prepareServiceStart(l.env, l.exe, {
      hooks: [hook(async (c) => {
        seen.push({ decision: c.decision, mode: c.mode, installRoot: c.installRoot, runtimeDir: c.runtimeDir })
        c.setRole({ role: 'leader', home: l.promoted, walnutId: 'w1' })
        return { env: { WALNUT_LEADER_SWITCH_COMMIT: '7' } }
      })],
    })
    expect(seen).toEqual([{ decision: 'serve', mode: { role: 'replica', home: LEADER, exe: l.exe }, installRoot: l.state, runtimeDir: l.env.WALNUT_DAEMON_DIR }])
    expect(d.kind).toBe('lead')
    expect(d.kind === 'lead' && d.serverEnv.WALNUT_LEADER_SWITCH_COMMIT).toBe('7')
    // Not in the file and not in the next start.
    expect(JSON.stringify(readServiceMode(l.state))).not.toContain('WALNUT_LEADER_SWITCH_COMMIT')
    const next = decideServiceEntry(l.env, l.exe)
    expect(next.kind === 'lead' && next.serverEnv.WALNUT_LEADER_SWITCH_COMMIT).toBeUndefined()
  })

  it('runs also when the start will be the daemon (another version), and the env goes nowhere', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: l.promoted, exe: '/versions/newer/walnut', role: 'leader', walnutId: 'w1' })
    const decisions: string[] = []
    const d = await prepareServiceStart(l.env, l.exe, { hooks: [hook(async (c) => { decisions.push(c.decision); return { env: { X: '1' } } })] })
    expect(decisions).toEqual(['daemon'])
    expect(d).toMatchObject({ kind: 'daemon', why: expect.stringMatching(/is for \/versions\/newer\/walnut/) })
  })

  it('no mode file: no hook is loaded', async () => {
    const l = roleLayout()
    const load = vi.fn(async () => (async () => {}) as ServiceStartHook)
    const d = await prepareServiceStart(l.env, l.exe, { hooks: [load] })
    expect(load).not.toHaveBeenCalled()
    expect(d).toMatchObject({ kind: 'daemon', quiet: true })
  })

  it('a hook that throws leaves the start as the file says', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: LEADER, exe: l.exe })
    const logs: string[] = []
    const d = await prepareServiceStart(l.env, l.exe, { hooks: [hook(async () => { throw new Error('boom') })], log: (_lv, msg) => { logs.push(msg) } })
    expect(d).toMatchObject({ kind: 'serve', home: LEADER })
    expect(logs.join('\n')).toMatch(/failed; the start goes on as the mode file says/)
  })
})

describe('the leader\'s ready watch', () => {
  it('reads the seconds once from its value, 180 by default', () => {
    expect(leadReadySeconds({})).toBe(180)
    expect(leadReadySeconds({ WALNUT_SERVICE_LEAD_READY_SECONDS: '5' })).toBe(5)
    expect(leadReadySeconds({ WALNUT_SERVICE_LEAD_READY_SECONDS: 'x' })).toBe(180)
  })

  it('a ready mark counts only when it names this pid', () => {
    expect(readyNames('pid=42\nexe=/x\nserves=walnut-serve\n', 42)).toBe(true)
    expect(readyNames('pid=420\nexe=/x\n', 42)).toBe(false)
    expect(readyNames('', 42)).toBe(false)
  })

  it('ready in time: no marker, no leave', async () => {
    vi.useFakeTimers()
    let text = ''
    const onLate = vi.fn()
    watchLeadReady({ launcherDir: '/l', pid: 42, seconds: 10, onLate, readReady: async () => text })
    await vi.advanceTimersByTimeAsync(4_000)
    text = 'pid=42\n'
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onLate).not.toHaveBeenCalled()
  })

  it('a mark written in the last interval still counts', async () => {
    vi.useFakeTimers()
    let text = ''
    const onLate = vi.fn()
    watchLeadReady({ launcherDir: '/l', pid: 42, seconds: 10, onLate, readReady: async () => text, pollMs: 60_000 })
    await vi.advanceTimersByTimeAsync(9_000)
    text = 'pid=42\n'
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onLate).not.toHaveBeenCalled()
  })

  it('not ready in time: the marker for this mode, the planned leave once, the mode untouched; the next start is the daemon', async () => {
    const l = roleLayout()
    writeServiceMode(l.state, { v: 1, home: l.promoted, exe: l.exe, role: 'leader', walnutId: 'w1' })
    const d = decideServiceEntry(l.env, l.exe)
    expect(d.kind).toBe('lead')
    if (d.kind !== 'lead') return
    // Another process's mark (the one before) does not count.
    fs.mkdirSync(l.env.WALNUT_LAUNCHER_DIR!, { recursive: true })
    fs.writeFileSync(path.join(l.env.WALNUT_LAUNCHER_DIR!, 'ready'), 'pid=1\n')
    vi.useFakeTimers()
    const leave = vi.fn()
    const logs: string[] = []
    const watch = armLeadReady({ ...d, serverEnv: { ...d.serverEnv, WALNUT_SERVICE_LEAD_READY_SECONDS: '30' } }, {
      leave, pid: 4242, now: () => Date.UTC(2026, 10, 23), log: (line) => { logs.push(line) },
      // The mark on disk, read at once, so the fake clock alone decides.
      readReady: async (file) => fs.readFileSync(file, 'utf8'),
    })
    expect(watch).not.toBeNull()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(leave).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(leave).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(leave).toHaveBeenCalledTimes(1)
    expect(readServiceRoleFallback(l.state)).toMatchObject({ v: 1, role: 'leader', home: l.promoted, exe: l.exe, at: Date.UTC(2026, 10, 23) })
    expect(logs.join('\n')).toMatch(/was not ready within 30 s/)
    expect(readServiceMode(l.state)).toMatchObject({ mode: { role: 'leader', home: l.promoted } })
    vi.useRealTimers()
    expect(decideServiceEntry(l.env, l.exe)).toMatchObject({ kind: 'daemon', why: expect.stringMatching(/did not get ready in time/) })
  })

  it('no launcher dir known: nothing to watch', () => {
    expect(armLeadReady({ home: '/h', exe: '/e', stateDir: '/s', serverEnv: {} }, { leave: () => {} })).toBeNull()
  })
})
