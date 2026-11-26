/**
 * The running server's side of the sessions in the data home (src/core/leader/switch/home-session-runtime.ts), by
 * behaviour: the runtime's answers to the stop, when a switch counts as committed here, the placement that waits for
 * that commit and never gives up, and the lead's settle that starts both. Also the process scan that fails closed
 * (src/lib/home-processes.ts) and the hold of a session whose home carries a switch's marker (sessions/switch-hold.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { committedHere, placeAfterCommit, settleHomeSessionsAtLead, stopAnswer, untilDone } from '../../../../src/core/leader/switch/home-session-runtime.js'
import { processesInFolders } from '../../../../src/lib/home-processes.js'
import { heldByHomeMarker } from '../../../../src/core/sessions/switch-hold.js'
import { LEADER_SWITCH_MARKER_REL } from '../../../../src/lib/leader-home-gate.js'
import type { SessionRecord } from '../../../../src/core/types.js'

let root = ''
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-runtime-'))) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const describeIt = (r: Record<string, unknown>) => `refused (${String(r.reason)})`

describe('the runtime\'s answer to the leader_switch stop', () => {
  it('done: the process gone, nothing to stop, or nothing of it held at all', () => {
    expect(stopAnswer({ ok: true, stopped: true }, describeIt)).toEqual({ ok: true })
    expect(stopAnswer({ ok: true, stopped: true, noop: true, reason: 'not_in_registry' }, describeIt)).toEqual({ ok: true })
    expect(stopAnswer({ ok: true, stopped: false, reason: 'not_owned', detail: 'not_journaled' }, describeIt)).toEqual({ ok: true })
  })

  it('not done: a session the runtime holds with no record of who started it, a refusal, an error', () => {
    const held = stopAnswer({ ok: true, stopped: false, held: true, reason: 'not_owned', detail: 'no_owner_record', kind: 'acp', pid: 4242 }, describeIt)
    expect(held).toEqual({ ok: false, why: expect.stringMatching(/holds it \(acp 4242\) with no record of who started it/) })
    expect(stopAnswer({ ok: true, stopped: false, reason: 'not_owned', detail: 'other_walnut' }, describeIt)).toEqual({ ok: false, why: 'refused (not_owned)' })
    expect(stopAnswer({ ok: true, stopped: false, held: true, kind: 'claude', reason: 'not_owned', detail: 'other_walnut' }, describeIt)).toEqual({ ok: false, why: 'refused (not_owned)' })
    expect(stopAnswer({ ok: true, stopped: false, held: false, kind: 'claude', reason: 'not_owned', detail: 'not_journaled' }, describeIt)).toEqual({ ok: true })
    expect(stopAnswer({ ok: false, error: 'stop: process did not exit after SIGTERM' }, describeIt)).toEqual({ ok: false, why: 'stop: process did not exit after SIGTERM' })
  })
})

function switchFiles(home: string, files: Record<string, unknown>) {
  const dir = path.join(home, 'local', 'leader-switch')
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(v))
}

function permit(state: string, number: number, holder = 'machine-b') {
  return () => ({ trial: false, machine: 'machine-b', runtime: { status: () => ({ state, record: { holder, number } }) } }) as never
}

describe('committedHere', () => {
  it('true by the history or a promoted record that led; else by this process leading above the handover', async () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    expect(await committedHere(home, 'S1', { permit: () => null as never })).toBe(false)
    switchFiles(home, { 'promoted.json': { switchId: 'S1', state: 'promoted', from: '/a', at: '', handover: 4 } })
    expect(await committedHere(home, 'S1', { permit: permit('trying', 4) })).toBe('wait')
    expect(await committedHere(home, 'S1', { permit: permit('leading', 4) })).toBe('wait')
    expect(await committedHere(home, 'S1', { permit: permit('leading', 5) })).toBe(true)
    expect(await committedHere(home, 'S1', { permit: permit('leading', 5, 'machine-a') })).toBe('wait')
    expect(await committedHere(home, 'S1', { permit: permit('stopped', 5, 'machine-a') })).toBe(false)
    switchFiles(home, { 'promoted.json': { switchId: 'S1', state: 'led', from: '/a', at: '' } })
    expect(await committedHere(home, 'S1', { permit: () => null as never })).toBe(true)
    switchFiles(home, { 'promoted.json': { switchId: 'S2', state: 'promoted', from: '/a', at: '' }, 'history.json': [{ switchId: 'S1', from: 'machine-a', to: 'machine-b', committedAt: '', record: 5 }] })
    expect(await committedHere(home, 'S1', { permit: () => null as never })).toBe(true)
  })
})

describe('placeAfterCommit', () => {
  it('waits for the commit, places once it stands, and tries again after a failure, never giving up', async () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const answers: Array<boolean | 'wait'> = ['wait', false, 'wait', ...Array(20).fill(false), true]
    const calls: string[] = []
    let places = 0
    const sleeps: number[] = []
    await placeAfterCommit(home, 'S1', { standbyDir: '/sb', homeFolder: '-a' }, 'machine-b', {
      committed: async () => answers.shift() ?? true,
      place: async () => { places++; calls.push(`place ${places}`); if (places === 1) throw new Error('the engine dir is not writable') },
      sleep: async (ms) => { sleeps.push(ms) },
    })
    // 23 answers not committed, then a placement that failed, then one that stood.
    expect(calls).toEqual(['place 1', 'place 2'])
    expect(sleeps).toHaveLength(24)
    // The waits grow, up to the slowest retry.
    expect(sleeps[0]).toBe(250)
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5 * 60_000)
    expect(sleeps[sleeps.length - 1]).toBeGreaterThan(sleeps[0]!)
  })

  it('untilDone retries a throw like a not-done answer', async () => {
    let n = 0
    const waits: string[] = []
    await untilDone(async () => { n++; if (n === 1) throw new Error('boom'); return n < 3 ? { done: false, why: 'not yet' } : { done: true } }, { sleep: async () => {}, onWait: (why) => { waits.push(why) } })
    expect(waits).toEqual(['boom', 'not yet'])
  })
})

describe('settleHomeSessionsAtLead', () => {
  const stamp = (extra: object = {}) => ({ switchId: 'S1', plan: 'move', from: { machine: 'machine-a', home: '/a', cwd: '/a' }, rel: '', stopped: 'idle', at: '', ...extra })
  const rec = (n: number, extra: Partial<SessionRecord> = {}) => ({ claudeSessionId: `s${n}`, cwd: '/b', ...extra }) as SessionRecord

  it('starts the placement of each switch whose moved rows are pending, and the rollback settle for rows that never moved', async () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const placed: unknown[] = []
    const settled: string[] = []
    await settleHomeSessionsAtLead(home, {
      list: async () => [
        rec(1, { leaderSwitch: stamp({ moved: { machine: 'machine-b', home, cwd: home, at: '', records: 'pending', carry: { standbyDir: '/sb', homeFolder: '-a' } } }) as never }),
        rec(2, { leaderSwitch: stamp({ moved: { machine: 'machine-b', home, cwd: home, at: '', records: 'placed' } }) as never }),
        rec(3, { leaderSwitch: stamp() as never }),
        rec(4),
      ],
      place: async (...args) => { placed.push(args) },
      settle: async (h) => { settled.push(h) },
    })
    expect(placed).toEqual([[home, 'S1', { standbyDir: '/sb', homeFolder: '-a' }, 'machine-b']])
    expect(settled).toEqual([home])
  })

  it('with no row a switch holds it does nothing', async () => {
    let called = false
    await settleHomeSessionsAtLead(root, { list: async () => [rec(1), rec(2, { leaderSwitch: stamp({ rolledBack: 'x' }) as never })], place: async () => { called = true }, settle: async () => { called = true } })
    expect(called).toBe(false)
  })
})

describe('the process scan (home-processes.ts)', () => {
  it('reads the command line of a process in the folder, and fails closed where it cannot read processes', async () => {
    if (process.platform === 'linux') {
      const here = await processesInFolders([process.cwd()])
      expect(here.every((p) => typeof p.args === 'string')).toBe(true)
    }
    await expect(processesInFolders([root], { platform: 'win32' })).rejects.toThrow(/cannot be read on win32/)
  })
})

describe('a session whose home carries a switch\'s marker is held (switch-hold.ts heldByHomeMarker)', () => {
  it('only a session in that home, only while the marker is there', () => {
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const r = (cwd: string, extra: Partial<SessionRecord> = {}) => ({ cwd, ...extra }) as SessionRecord
    expect(heldByHomeMarker(r(home), home)).toBe(false)
    fs.mkdirSync(path.dirname(path.join(home, LEADER_SWITCH_MARKER_REL)), { recursive: true })
    fs.writeFileSync(path.join(home, LEADER_SWITCH_MARKER_REL), JSON.stringify({ state: 'switching' }))
    expect(heldByHomeMarker(r(home), home)).toBe(true)
    expect(heldByHomeMarker(r(path.join(home, 'notes')), home)).toBe(true)
    expect(heldByHomeMarker(r(`${home}-c`), home)).toBe(false)
    expect(heldByHomeMarker(r(home, { archived: true }), home)).toBe(false)
    expect(heldByHomeMarker(r(home), '')).toBe(false)
  })
})
