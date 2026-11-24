/**
 * The old leader's switch stop (final-stop.ts) against a fake copy link: batches until one finds nothing
 * changed, a writer after the first batch carried by the next, a writer that never stops refused at the
 * deadline, a signal that stops it before its mark; the wait for the stop and its own cancel; and the
 * trust rule of a begin. Real batches into a real standby folder in the last case.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { abandonSwitchStop, beginRefusal, beginSwitchStop, beginTakeBack, endTakeBack, finishSwitchStop, forgetHandedOver, noteHandedOver, runFinalBatch, type HandedOverSwitch } from '../../../../src/core/leader/switch/final-stop.js'
import { DaemonPeer, LocalPeer, peerFor, type SwitchPeer } from '../../../../src/core/leader/switch/peer.js'
import { readFinalStopResult } from '../../../../src/core/leader/switch/records.js'
import { finalMarkName, readSwitchFile, validFinalMark } from '../../../../src/core/leader/switch/ticket.js'
import { parseSwitchSettings } from '../../../../src/core/leader/switch/settings.js'
import type { BatchOutcome } from '../../../../src/core/standby/index.js'

const tmp: string[] = []
/** The standby copy is read only by design: open it again before removing it. */
function rmAll(d: string): void {
  const open = (p: string) => {
    try { fs.chmodSync(p, 0o700) } catch { return }
    for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) open(path.join(p, e.name))
  }
  open(d)
  fs.rmSync(d, { recursive: true, force: true })
}
afterEach(() => { forgetHandedOver(); vi.useRealTimers(); for (const d of tmp.splice(0)) rmAll(d) })
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'final-stop-')); tmp.push(d); return d }

/** A copy link whose batches report what `changes` says, one entry per batch (true: something changed, 'void': a void batch). */
function fakePeer(changes: Array<boolean | 'void'>, files: Map<string, unknown> = new Map()): SwitchPeer & { batches: number; verified: number } {
  let n = 0
  const p = {
    kind: 'local' as const, machine: { id: 'machine-b', home: '/x/b', standbyDir: '/x/b/standby', port: 1 }, standbyDir: '/x/b/standby',
    batches: 0, verified: 0,
    async batch(): Promise<BatchOutcome> {
      const c = changes[Math.min(n, changes.length - 1)]
      n++
      p.batches = n
      if (c === 'void') return { ok: false, reason: 'a write at the wrong instant', stats: {} as never }
      return { ok: true, manifest: {} as never, commit: { batch: 10 + n, unchanged: !c, written: c ? 3 : 0, deleted: 0 } as never, stats: {} as never }
    },
    async verify() { p.verified++; return { drift: 0 } },
    async ready() { return null },
    async writeFile(name: string, v: unknown) { files.set(name, v) },
    async readFile<T>(name: string) { return (files.get(name) ?? null) as T | null },
    async startTargetJob() { return { ok: true } },
    async hold() {},
    unhold() {},
    close() {},
  }
  return p
}

const live = () => new AbortController().signal

describe('the final batch', () => {
  it('sends until a batch finds nothing changed, then verifies; a void batch is tried again', async () => {
    const peer = fakePeer([true, 'void', true, false])
    const r = await runFinalBatch({ home: '/x/a', peer, deadlineAt: Date.now() + 60_000, signal: live() })
    expect(r).toEqual({ ok: true, batch: 14, batches: 4 })
    expect(peer.verified).toBe(1)
  })

  it('a writer that lands after the first batch is in the next one, and the mark follows only the unchanged one', async () => {
    const peer = fakePeer([true, true, false])
    const r = await runFinalBatch({ home: '/x/a', peer, deadlineAt: Date.now() + 60_000, signal: live(), test: { pauseAfterFirstBatchMs: 5 } })
    expect(r.ok && r.batches).toBe(3)
  })

  it('a writer that never stops: refused at the commit deadline, no mark', async () => {
    const home = dir()
    const peer = fakePeer([true])
    const files = new Map<string, unknown>()
    Object.assign(peer, { writeFile: async (n: string, v: unknown) => { files.set(n, v) } })
    const r = await finishSwitchStop({ home, sw: { switchId: 'S1', to: 'machine-b', peer, commitDeadline: Date.now() + 150, phase: 'stopping' }, stoppedAt: new Date().toISOString(), signal: live(), log: () => {} })
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/still changed when the commit window ended/)
    expect(files.size).toBe(0)
    expect(readFinalStopResult(home, 'S1')?.ok).toBe(false)
  })

  it('says who still wrote: this server\'s own writer that did not stop in time, else one it does not run (never "outside Walnut" for its own)', async () => {
    const own = await runFinalBatch({ home: '/x/a', peer: fakePeer([true]), deadlineAt: Date.now() + 100, signal: live(), writers: { late: ['git auto-commit'], ms: 30_000 } })
    expect(!own.ok && own.why).toMatch(/still changed .*this server's own git auto-commit did not stop within its budget/)
    expect(!own.ok && own.why).not.toMatch(/outside Walnut/)
    const other = await runFinalBatch({ home: '/x/a', peer: fakePeer([true]), deadlineAt: Date.now() + 100, signal: live(), writers: { late: [], ms: 5 } })
    expect(!other.ok && other.why).toMatch(/a writer this server does not run/)
  })

  it('a final batch that only ran out of time (the copy link too slow for what it carries) says so, not "a writer"', async () => {
    // The rehearsal's case: every try was cut at the commit deadline over the held link.
    const peer = fakePeer(['void'])
    Object.assign(peer, { batch: async () => ({ ok: false, reason: 'the switch stop is past its commit deadline: nothing more goes over the copy link', stats: {} }) })
    const r = await runFinalBatch({ home: '/x/a', peer, deadlineAt: Date.now() + 100, signal: live() })
    expect(!r.ok && r.why).toMatch(/did not finish within the commit window .*past its commit deadline/)
    expect(!r.ok && r.why).not.toMatch(/writer/)
  })

  it('the target applying this server\'s last periodic batch: tried again each second, never spun', async () => {
    let n = 0
    const peer = fakePeer([false])
    const real = peer.batch.bind(peer)
    Object.assign(peer, { batch: async () => (++n <= 2 ? { ok: false, reason: 'standby receive init on the host: the target is busy: an apply of batch 7 runs there since x', stats: {} } : real()) })
    const t0 = Date.now()
    const r = await runFinalBatch({ home: '/x/a', peer, deadlineAt: Date.now() + 30_000, signal: live() })
    expect(r.ok).toBe(true)
    expect(n).toBe(3)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_900)
  })

  it('a signal during it ends it before its mark (the switch rolls back)', async () => {
    const home = dir()
    const peer = fakePeer([true, false])
    const files = new Map<string, unknown>()
    Object.assign(peer, { writeFile: async (n: string, v: unknown) => { files.set(n, v) } })
    const ctl = new AbortController()
    const run = finishSwitchStop({ home, sw: { switchId: 'S2', to: 'machine-b', peer, commitDeadline: Date.now() + 60_000, phase: 'stopping' }, stoppedAt: new Date().toISOString(), signal: ctl.signal, test: { pauseAfterFirstBatchMs: 5_000 }, log: () => {} })
    setTimeout(() => ctl.abort('stopped by SIGTERM'), 30)
    const r = await run
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/stopped by SIGTERM/)
    expect(files.has(finalMarkName('S2'))).toBe(false)
    expect(peer.batches).toBe(1)
  })

  it('real batches into a real standby folder: the mark names the unchanged batch, and the result is beside the home', async () => {
    const base = dir()
    const home = path.join(base, 'home')
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(home, 'notes', 'a.md'), 'one\n')
    const standbyDir = path.join(base, 'standby')
    const peer = new LocalPeer({ id: 'machine-b', home: path.join(base, 'b-home'), standbyDir, port: 1 }, standbyDir)
    const r = await finishSwitchStop({ home, sw: { switchId: 'S3', to: 'machine-b', peer, commitDeadline: Date.now() + 60_000, phase: 'stopping' }, stoppedAt: '2026-11-23T00:00:00.000Z', signal: live(), log: () => {} })
    expect(r.ok).toBe(true)
    const mark = readSwitchFile(standbyDir, finalMarkName('S3'))
    expect(validFinalMark(mark, 'S3')).toBe(true)
    expect((mark as { batch: number }).batch).toBe(r.batch)
    expect(fs.readFileSync(path.join(standbyDir, 'copy', 'notes', 'a.md'), 'utf8')).toBe('one\n')
    expect(readFinalStopResult(home, 'S3')).toMatchObject({ ok: true, batch: r.batch, stoppedAt: '2026-11-23T00:00:00.000Z' })
  })
})

describe('the wait for the switch stop', () => {
  it('no stop within the wait: the server takes its handover back; a stop after that is refused', () => {
    vi.useFakeTimers()
    let held: HandedOverSwitch | null = null
    const over = vi.fn((sw: HandedOverSwitch) => { held = sw })
    noteHandedOver({ switchId: 'S4', to: 'machine-b', peer: fakePeer([false]), commitDeadline: Date.now() + 300_000, stopWaitMs: 120_000, onStopWaitOver: over })
    vi.advanceTimersByTime(119_000)
    expect(over).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(over).toHaveBeenCalledTimes(1)
    // While it takes the handover back, a stop is refused (the two never both run), and so is a second take-back.
    expect(beginSwitchStop('S4')).toEqual({ ok: false, why: expect.stringMatching(/taking that handover back/) })
    expect(beginTakeBack()).toEqual({ ok: false, why: expect.stringMatching(/taking its handover back already/) })
    // No witness majority this moment: it waits for its stop again, and tries again 5 s later.
    endTakeBack(held, false, 5_000)
    expect(beginSwitchStop('S4').ok).toBe(true)
    // A stop taken in a retry gap and then abandoned: the take-back is tried again 5 s later (its wait is over).
    abandonSwitchStop(held!)
    vi.advanceTimersByTime(4_000)
    expect(over).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2_000)
    expect(over).toHaveBeenCalledTimes(2)
    endTakeBack(held, true)
    expect(beginSwitchStop('S4')).toEqual({ ok: false, why: expect.stringMatching(/took that handover back/) })
  })

  it('a cancel by hand during the switch stop is refused; one before it makes the stop refused', () => {
    vi.useFakeTimers()
    noteHandedOver({ switchId: 'S8', to: 'machine-b', peer: fakePeer([false]), commitDeadline: Date.now() + 300_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    const t = beginTakeBack()
    expect(t.ok).toBe(true)
    expect(beginSwitchStop('S8').ok).toBe(false)
    endTakeBack(t.ok ? t.sw : null, false)
    expect(beginSwitchStop('S8').ok).toBe(true)
    expect(beginTakeBack()).toEqual({ ok: false, why: expect.stringMatching(/in its switch stop/) })
    // No switch handed over: a plain cancel goes ahead.
    forgetHandedOver()
    expect(beginTakeBack()).toEqual({ ok: true, sw: null })
  })

  it('a stop in time ends the wait: no cancel comes after it, and a second stop is refused', () => {
    vi.useFakeTimers()
    const over = vi.fn()
    noteHandedOver({ switchId: 'S5', to: 'machine-b', peer: fakePeer([false]), commitDeadline: Date.now() + 300_000, stopWaitMs: 120_000, onStopWaitOver: over })
    expect(beginSwitchStop('S5').ok).toBe(true)
    vi.advanceTimersByTime(300_000)
    expect(over).not.toHaveBeenCalled()
    expect(beginSwitchStop('S5').ok).toBe(false)
    expect(beginSwitchStop('S6')).toEqual({ ok: false, why: expect.stringMatching(/no switch S6/) })
  })

  it('a resumed source job asking again keeps the first deadline and wait', () => {
    vi.useFakeTimers()
    const first = noteHandedOver({ switchId: 'S7', to: 'machine-b', peer: fakePeer([false]), commitDeadline: 1_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    const again = noteHandedOver({ switchId: 'S7', to: 'machine-b', peer: fakePeer([false]), commitDeadline: 9_000, stopWaitMs: 120_000, onStopWaitOver: () => {} })
    expect(again).toBe(first)
    expect(again.commitDeadline).toBe(1_000)
  })
})

describe('who may begin a switch, and the copy link', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'begin-rule-'))
  afterAll(() => rmAll(base))
  const sa = path.join(base, 'a-standby')
  const sb = path.join(base, 'b-standby')
  fs.mkdirSync(sa); fs.mkdirSync(sb)
  const settings = parseSwitchSettings({
    witnesses: [{ id: 'w1', dir: '/w/1' }, { id: 'w2', dir: '/w/2' }, { id: 'w3', dir: '/w/3' }],
    machines: [{ id: 'machine-a', home: '/a/home', standby_dir: sa, port: 1, host_key: 'dev-a' }, { id: 'machine-b', home: '/b/home', standby_dir: sb, port: 2, host_key: 'dev-b' }, { id: 'machine-c', home: '/c/home', standby_dir: '/c/standby', port: 3 }],
  }).settings!
  const noKeys = parseSwitchSettings({
    witnesses: [{ id: 'w1', dir: '/w/1' }, { id: 'w2', dir: '/w/2' }, { id: 'w3', dir: '/w/3' }],
    machines: [{ id: 'machine-a', home: '/a/home', standby_dir: sa, port: 1 }, { id: 'machine-b', home: '/b/home', standby_dir: sb, port: 2 }],
  }).settings!

  it('takes a machine of the list that holds this leader\'s standby target', () => {
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb } })).toBeNull()
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-x', standby: { dir: sb } })).toMatch(/not in leader_switch.machines/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-c', standby: { dir: sb } })).toMatch(/not to machine-c's standby_dir/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-a', standby: { dir: sa } })).toMatch(/leads already/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: {} })).toMatch(/no standby copy/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'machine-c' } })).toMatch(/on host machine-c, not on machine-b/)
    // A copy on the target as a host: its service must say it can lead, in both versions.
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'machine-b' }, hostService: null })).toMatch(/not connected/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'machine-b' }, hostService: { serviceRoles: ['replica'], launcher: { goodRoles: ['leader'] } } })).toMatch(/does not say it can lead/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'machine-b' }, hostService: { serviceRoles: ['replica', 'leader'], launcher: { goodRoles: ['replica', 'leader'] } } })).toBeNull()
  })

  it('a copy on another machine: that machine by its id or its host_key, its own standby_dir, and a way back to this machine by its host_key', () => {
    const can = { serviceRoles: ['replica', 'leader'], launcher: { goodRoles: ['replica', 'leader'] } }
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'dev-b' }, hosts: ['dev-a', 'dev-b'], hostService: can })).toBeNull()
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sa, host: 'dev-b' }, hosts: ['dev-a', 'dev-b'], hostService: can })).toMatch(/goes to dev-b:.*not to machine-b's standby_dir/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'dev-b' }, hosts: ['dev-b'], hostService: can })).toMatch(/hosts has no dev-a/)
    expect(beginRefusal({ settings: noKeys, me: 'machine-a', to: 'machine-b', standby: { dir: sb, host: 'machine-b' }, hosts: ['machine-b'], hostService: can })).toMatch(/machine-a\) has no host_key/)
  })

  it('a begin forwarded from another machine is taken only from the machine it goes to', () => {
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb }, forwardedBy: 'machine-b' })).toBeNull()
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb }, forwardedBy: 'machine-c' })).toMatch(/taken only from the machine it goes to/)
    expect(beginRefusal({ settings, me: 'machine-a', to: 'machine-b', standby: { dir: sb }, forwardedBy: null })).toMatch(/unknown machine/)
  })

  it('the copy link is the place the standby runner sends to: a folder here, or a folder on the target as a host', async () => {
    const b = settings.machines[1]!
    expect(await peerFor({ to: b, standby: { dir: sb }, home: '/x/a' })).toBeInstanceOf(LocalPeer)
    expect(await peerFor({ to: b, standby: { dir: sa }, home: '/x/a' })).toEqual({ refused: expect.stringMatching(/not to machine-b's standby_dir/) })
    expect(await peerFor({ to: b, standby: { dir: sb, host: 'box' }, home: '/x/a' })).toEqual({ refused: expect.stringMatching(/on host box, not on machine-b/) })
    const connect = async () => { throw new Error('not dialled in this test') }
    const d = await peerFor({ to: b, standby: { dir: sb, host: 'dev-b' }, home: '/x/a', connect })
    expect(d).toBeInstanceOf(DaemonPeer)
    expect((d as DaemonPeer).kind).toBe('daemon')
    ;(d as DaemonPeer).close()
  })
})
