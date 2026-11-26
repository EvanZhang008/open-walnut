/**
 * Sessions in the data home across a leader switch (src/core/leader/switch/home-sessions.ts, session-hosts.ts
 * moveHomeRows, sessions/switch-hold.ts): the class is chosen by folder (never by a name's prefix), the old leader's stop
 * stamps and stops each one (a turn it ends is a pending restart loss, a CLI that outlives it fails the stop), the
 * promotion moves each row to the new home (archived ones too) or ends it with why, and a rollback settles them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from '../../../../src/lib/sqlite.js'
import {
  homeSessionRows, moveRefusal, planHomeSessions, planLine, relInHome, settleHomeSessionsAfterRollback, stopHomeSessions, stopRequestIdFor,
  type HomeStopDeps,
} from '../../../../src/core/leader/switch/home-sessions.js'
import { moveSessionHosts } from '../../../../src/core/leader/switch/session-hosts.js'
import { heldBySwitch } from '../../../../src/core/sessions/switch-hold.js'
import type { SessionRecord } from '../../../../src/core/types.js'

let root = ''
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'home-sessions-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function rec(n: number, cwd: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { claudeSessionId: sid(n), taskId: `t${n}`, project: 'p', process_status: 'stopped', mode: 'default', cwd, title: `s${n}`, ...extra } as SessionRecord
}

describe('the class: by folder', () => {
  it('takes the home and folders under it, never a neighbour whose name only starts the same', () => {
    expect(relInHome('/a/home', ['/a/home'])).toBe('')
    expect(relInHome('/a/home/tasks/x', ['/a/home'])).toBe('tasks/x')
    expect(relInHome('/a/home-c', ['/a/home'])).toBeNull()
    expect(relInHome('/a', ['/a/home'])).toBeNull()
    expect(relInHome('relative/path', ['/a/home'])).toBeNull()
    expect(relInHome(undefined, ['/a/home'])).toBeNull()
  })

  it('counts only the leader\'s own daemon\'s rows (a host\'s session stays where it runs)', () => {
    const home = path.join(root, 'home')
    const rows = homeSessionRows([
      rec(1, home), rec(2, path.join(home, 'notes')), rec(3, `${home}-c`),
      rec(4, home, { host: 'machine-h' }), rec(5, home, { host: '__local__' }), rec(6, '/elsewhere'),
    ], home)
    expect(rows.map((r) => r.rec.claudeSessionId)).toEqual([sid(1), sid(2), sid(5)])
  })

  it('says why a row cannot move: another engine, a machine-runtime folder, a path Claude Code would hash', () => {
    const home = path.join(root, 'home')
    expect(moveRefusal(rec(1, home), '')).toBeNull()
    expect(moveRefusal(rec(1, home, { engine: 'codex' } as never), '')).toMatch(/engine \(codex\)/)
    expect(moveRefusal(rec(1, path.join(home, 'tmp', 'x')), 'tmp/x')).toMatch(/runtime place|data, which the standby copy does not carry/)
    const deep = path.join(home, 'x'.repeat(220))
    expect(moveRefusal(rec(1, deep), 'x'.repeat(220))).toMatch(/200 characters/)
  })

  it('plans in one line what the preflight says', () => {
    const home = path.join(root, 'home')
    const p = planHomeSessions([rec(1, home, { process_status: 'running' }), rec(2, home, { process_status: 'idle' }), rec(3, home, { engine: 'codex' } as never)], home)
    expect(p).toMatchObject({ rows: 3, moves: 2, live: { turn: 1, idle: 1 } })
    expect(p.ends).toHaveLength(1)
    expect(planLine(p)).toMatch(/2 move with the leader; the switch stop ends 1 running turn\(s\) and 1 idle CLI\(s\).*1 end instead: s3/)
    expect(planLine(planHomeSessions([], home))).toBe('no session works in the data home')
  })
})

function fakeStore(records: SessionRecord[]) {
  const byId = new Map(records.map((r) => [r.claudeSessionId, r]))
  return {
    byId,
    list: async () => [...byId.values()],
    save: async (id: string, patch: Partial<SessionRecord>) => { byId.set(id, { ...byId.get(id)!, ...patch }) },
  }
}

describe('the old leader\'s stop', () => {
  it('stamps every row, marks a running turn as a pending restart loss, and stops each live CLI through the runtime', async () => {
    const home = path.join(root, 'home')
    const s = fakeStore([rec(1, home, { process_status: 'running', pid: 101 }), rec(2, home, { process_status: 'idle', pid: 102 }), rec(3, home), rec(4, home, { archived: true }), rec(5, '/elsewhere', { process_status: 'running' })])
    const stopped: Array<[string, string]> = []
    const deps: HomeStopDeps = {
      ...s, supervised: async (id) => id === sid(2), now: Date.now,
      stop: async (r, id) => { stopped.push([r.claudeSessionId, id]); s.byId.set(r.claudeSessionId, { ...s.byId.get(r.claudeSessionId)!, process_status: 'stopped' }); return { ok: true } },
      processesInHome: async () => [{ pid: 999, name: 'zsh' }],
    }
    const r = await stopHomeSessions({ switchId: 'S1', home, machine: 'machine-a', budgetMs: 5_000, deps })
    expect(r).toMatchObject({ ok: true, rows: 4, moves: 3, stopped: { turn: 1, idle: 1 }, others: [{ pid: 999, name: 'zsh' }] })
    expect(stopped.sort()).toEqual([[sid(1), stopRequestIdFor('S1', sid(1))], [sid(2), stopRequestIdFor('S1', sid(2))]])
    expect(s.byId.get(sid(1))!.leaderSwitch).toMatchObject({ switchId: 'S1', plan: 'move', stopped: 'turn', supervised: false, from: { machine: 'machine-a', home } })
    expect(s.byId.get(sid(1))!.restartLoss).toMatchObject({ cause: 'leader_switch', state: 'pending', before: { status: 'running' } })
    expect(s.byId.get(sid(2))!.leaderSwitch).toMatchObject({ stopped: 'idle', supervised: true })
    expect(s.byId.get(sid(2))!.restartLoss).toBeUndefined()
    expect(s.byId.get(sid(3))!.leaderSwitch).toMatchObject({ stopped: 'none' })
    // An archived row follows by its folder at the promotion; one outside the home is not touched.
    expect(s.byId.get(sid(4))!.leaderSwitch).toBeUndefined()
    expect(s.byId.get(sid(5))!.leaderSwitch).toBeUndefined()
    // The stop's id is a UUID (the daemon takes no other) and the same each time.
    expect(stopRequestIdFor('S1', sid(1))).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // Asked again (a resumed source job): what the first stop found stands, a turn stays a turn.
    const again = await stopHomeSessions({ switchId: 'S1', home, machine: 'machine-a', budgetMs: 5_000, deps })
    expect(again.ok).toBe(true)
    expect(s.byId.get(sid(1))!.leaderSwitch).toMatchObject({ stopped: 'turn', supervised: false })
    expect(s.byId.get(sid(2))!.leaderSwitch).toMatchObject({ stopped: 'idle', supervised: true })
  })

  it('names an ACP session to the runtime by its worker\'s runtime id', async () => {
    const { stopTargetOf } = await import('../../../../src/core/leader/switch/home-session-runtime.js')
    expect(stopTargetOf({ claudeSessionId: sid(1), acpRuntimeId: 'acp-rt-1' })).toBe('acp-rt-1')
    expect(stopTargetOf({ claudeSessionId: sid(1) })).toBe(sid(1))
  })

  it('fails (and names the session) when a CLI did not end, or its process still runs in the home', async () => {
    const home = path.join(root, 'home')
    const s = fakeStore([rec(1, home, { process_status: 'running', pid: 101, title: 'Main' }), rec(2, home, { process_status: 'idle', pid: 102 })])
    const deps: HomeStopDeps = {
      ...s, supervised: async () => false, now: Date.now,
      stop: async (r) => r.claudeSessionId === sid(1) ? { ok: false, why: 'the process group did not end' } : { ok: true },
      processesInHome: async () => [{ pid: 102, name: 'claude' }],
    }
    const r = await stopHomeSessions({ switchId: 'S1', home, machine: 'machine-a', budgetMs: 5_000, deps })
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/Main \(.*\): the process group did not end/)
    expect(r.why).toMatch(/its process 102 still runs in the data home/)
  })

  it('a stop that never answers fails within its budget', async () => {
    const home = path.join(root, 'home')
    const s = fakeStore([rec(1, home, { process_status: 'running' })])
    const deps: HomeStopDeps = { ...s, supervised: async () => false, now: Date.now, stop: () => new Promise(() => {}), processesInHome: async () => [] }
    const t0 = Date.now()
    const r = await stopHomeSessions({ switchId: 'S1', home, machine: 'machine-a', budgetMs: 200, deps })
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/did not end within/)
  })
})

describe('a rollback', () => {
  it('settles only rows of a switch no marker holds open: supervision on again under the stop\'s id, held messages out, then resume', async () => {
    const home = path.join(root, 'home')
    const stamp = (id: string, extra: object = {}) => ({ switchId: id, plan: 'move', from: { machine: 'a', home, cwd: home }, rel: '', stopped: 'idle', at: '', ...extra }) as never
    const s = fakeStore([
      rec(1, home, { leaderSwitch: stamp('S1', { supervised: true, stopRequestId: stopRequestIdFor('S1', sid(1)) }) }),
      rec(2, home, { leaderSwitch: stamp('S2') }),
      rec(3, home, { leaderSwitch: stamp('S1', { moved: { machine: 'b', home: '/b', cwd: '/b', at: '' } }) }),
    ])
    const calls: string[] = []
    const n = await settleHomeSessionsAfterRollback({
      home, isOpenSwitch: (id) => id === 'S2',
      deps: { ...s, reenable: async (id, f) => { calls.push(`reenable ${id} ${f}`) }, release: async (id) => { calls.push(`release ${id}`) }, resume: async () => { calls.push('resume') } },
    })
    expect(n).toBe(1)
    expect(calls).toEqual([`reenable ${sid(1)} ${stopRequestIdFor('S1', sid(1))}`, `release ${sid(1)}`, 'resume'])
    expect(s.byId.get(sid(1))!.leaderSwitch!.rolledBack).toBeTruthy()
    expect(heldBySwitch(s.byId.get(sid(1)))).toBe(false)
    // The open switch's row stays held; settled once (a second pass does nothing).
    expect(heldBySwitch(s.byId.get(sid(2)))).toBe(true)
    expect(await settleHomeSessionsAfterRollback({ home, isOpenSwitch: () => false, deps: { ...s, reenable: async () => {}, release: async () => {}, resume: async () => { calls.push('resume2') } } })).toBe(1)
    expect(calls).toContain('resume2')
  })

  it('holds a moved row only until its records are placed', () => {
    const st = { switchId: 'S1', plan: 'move', from: { machine: 'a', home: '/a', cwd: '/a' }, rel: '', stopped: 'none', at: '' } as const
    expect(heldBySwitch(null)).toBe(false)
    expect(heldBySwitch({ leaderSwitch: undefined } as never)).toBe(false)
    expect(heldBySwitch({ leaderSwitch: st } as never)).toBe(true)
    expect(heldBySwitch({ leaderSwitch: { ...st, moved: { machine: 'b', home: '/b', cwd: '/b', at: '', records: 'pending' } } } as never)).toBe(true)
    expect(heldBySwitch({ leaderSwitch: { ...st, moved: { machine: 'b', home: '/b', cwd: '/b', at: '', records: 'placed' } } } as never)).toBe(false)
    expect(heldBySwitch({ leaderSwitch: st, archived: true } as never)).toBe(false)
  })
})

// ---- the promotion ---------------------------------------------------------------------------------------------

function sessionsDb(home: string, rows: Array<{ sid: string; cwd: string; host?: string | null; provider?: string; archived?: number; reason?: string; status?: string; payload?: object }>): void {
  fs.mkdirSync(home, { recursive: true })
  const db = new Database(path.join(home, 'sessions.sqlite'))
  db.exec('CREATE TABLE sessions (claude_session_id TEXT PRIMARY KEY, host TEXT, cwd TEXT, provider TEXT, archived INTEGER DEFAULT 0, archive_reason TEXT, process_status TEXT, payload TEXT)')
  for (const r of rows) {
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(r.sid, r.host ?? null, r.cwd, r.provider ?? 'claude', r.archived ?? 0, r.reason ?? null, r.status ?? 'stopped', JSON.stringify(r.payload ?? { keep: 'me' }))
  }
  db.close()
}

function rowsOf(home: string): Record<string, { host: string | null; cwd: string; archived: number; archive_reason: string | null; process_status: string; payload: Record<string, any> }> {
  const db = new Database(path.join(home, 'sessions.sqlite'), { readonly: true })
  try {
    return Object.fromEntries((db.prepare('SELECT * FROM sessions').all() as Array<Record<string, any>>).map((r) => [r.claude_session_id, { ...r, payload: JSON.parse(r.payload) }]))
  } finally { db.close() }
}

describe('the promotion (moveSessionHosts with the home)', () => {
  const homes = (to: string) => ({ from: '/old/home', to, fromMachine: 'machine-a', toMachine: 'machine-b', carry: { standbyDir: '/sb', homeFolder: '-old-home' } })

  it('moves each row of the home to this home\'s same place, archived ones too, and ends those that cannot move', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, [
      { sid: sid(1), cwd: '/old/home', status: 'idle', payload: { keep: 'me', leaderSwitch: { switchId: 'S1', plan: 'move', from: { machine: 'machine-a', home: '/old/home', cwd: '/old/home' }, rel: '', stopped: 'idle', at: 'x', supervised: true } } },
      { sid: sid(2), cwd: '/old/home/notes/x', status: 'running' },
      { sid: sid(3), cwd: '/old/home', archived: 1, reason: 'chat_cleared' },
      { sid: sid(4), cwd: '/old/home', payload: { engine: 'codex' } },
      { sid: sid(5), cwd: '/old/home-c' },
      { sid: sid(6), cwd: '/old/home', host: 'machine-h' },
      { sid: sid(7), cwd: '/elsewhere' },
    ])
    const r = moveSessionHosts(home, 'S1', { oldMachine: 'machine-a', newMachine: 'machine-b', homes: homes(home) })
    expect(r).toMatchObject({ homeMoved: 3, homeEnded: 1, alreadyDone: false })
    const after = rowsOf(home)
    expect(after[sid(1)]).toMatchObject({ host: null, cwd: home, archived: 0, process_status: 'stopped' })
    // Only the two payload keys change: the rest of the payload is as written.
    expect(after[sid(1)].payload).toMatchObject({ keep: 'me', leaderSwitch: { switchId: 'S1', plan: 'move', stopped: 'idle', supervised: true, moved: { machine: 'machine-b', home, cwd: home, records: 'pending', carry: { standbyDir: '/sb', homeFolder: '-old-home' } } }, folderMoved: { from: '/old/home', to: home, why: 'leader-switch', fromMachine: 'machine-a', toMachine: 'machine-b' } })
    expect(after[sid(2)]).toMatchObject({ host: null, cwd: path.join(home, 'notes', 'x'), process_status: 'stopped' })
    // An archived row follows by its folder (its history comes too) and keeps its own reason; no notice for it.
    expect(after[sid(3)]).toMatchObject({ host: null, cwd: home, archived: 1, archive_reason: 'chat_cleared' })
    expect(after[sid(3)].payload.folderMoved).toBeUndefined()
    // Another engine's history stays on the old machine: the row names it and ends with why.
    expect(after[sid(4)]).toMatchObject({ host: 'machine-a', cwd: '/old/home', archived: 1, archive_reason: 'leader_switch' })
    expect(after[sid(4)].payload.leaderSwitch).toMatchObject({ plan: 'end', why: expect.stringMatching(/codex/) })
    // A neighbour folder is no part of the home: it is an ordinary own-daemon row (the old machine's now).
    expect(after[sid(5)]).toMatchObject({ host: 'machine-a', cwd: '/old/home-c' })
    expect(after[sid(6)]).toMatchObject({ host: 'machine-h' })
    expect(after[sid(7)]).toMatchObject({ host: 'machine-a' })
    // Once per switch.
    expect(moveSessionHosts(home, 'S1', { oldMachine: 'machine-a', newMachine: 'machine-b', homes: homes(home) }).alreadyDone).toBe(true)
    expect(rowsOf(home)).toEqual(after)
  })

  it('on one machine (no old machine key) only the home\'s rows change', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, [{ sid: sid(1), cwd: '/old/home' }, { sid: sid(2), cwd: '/elsewhere' }])
    const r = moveSessionHosts(home, 'S1', { homes: homes(home) })
    expect(r).toMatchObject({ homeMoved: 1, homeEnded: 0, toOldMachine: 0 })
    expect(rowsOf(home)[sid(1)]).toMatchObject({ host: null, cwd: home })
    expect(rowsOf(home)[sid(2)]).toMatchObject({ host: null, cwd: '/elsewhere' })
  })

  it('an end the old leader planned stands', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, [{ sid: sid(1), cwd: '/old/home', payload: { leaderSwitch: { switchId: 'S1', plan: 'end', why: 'planned end', from: { machine: 'machine-a', home: '/old/home', cwd: '/old/home' }, rel: '', stopped: 'none', at: 'x' } } }])
    moveSessionHosts(home, 'S1', { oldMachine: 'machine-a', homes: homes(home) })
    expect(rowsOf(home)[sid(1)]).toMatchObject({ host: 'machine-a', archived: 1, archive_reason: 'leader_switch' })
    expect(rowsOf(home)[sid(1)].payload.leaderSwitch).toMatchObject({ plan: 'end', why: 'planned end' })
  })
})

describe('the old leader\'s handed-over home as a host folder (moved-home.ts handedOverHomeOnHost)', () => {
  it('names it only on the machine the lead last moved from, and only for that home', async () => {
    const { handedOverHomeOnHost } = await import('../../../../src/core/leader/switch/moved-home.js')
    const YAML = (await import('yaml')).default
    const home = path.join(root, 'new-home')
    fs.mkdirSync(path.join(home, 'local', 'leader-switch'), { recursive: true })
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({
      experimental: { switchable_leader: true },
      leader_switch: {
        witnesses: [{ id: 'w1', dir: '/w/1' }, { id: 'w2', dir: '/w/2' }, { id: 'w3', dir: '/w/3' }],
        machines: [{ id: 'machine-a', home: '/a/.open-walnut', standby_dir: '/a/standby', port: 1, host_key: 'dev-a' }, { id: 'machine-b', home, standby_dir: '/b/standby', port: 2, host_key: 'dev-b' }],
      },
    }))
    const write = (name: string, v: unknown) => fs.writeFileSync(path.join(home, 'local', 'leader-switch', name), JSON.stringify(v))
    write('promoted.json', { switchId: 'S1', state: 'promoted', from: '/a/.open-walnut', at: '' })
    write('history.json', [{ switchId: 'S1', from: 'machine-a', to: 'machine-b', committedAt: '', record: 3 }])
    // Not committed yet ('promoted'): nothing said.
    expect(await handedOverHomeOnHost(home, 'dev-a', '/a/.open-walnut')).toBeNull()
    write('promoted.json', { switchId: 'S1', state: 'led', from: '/a/.open-walnut', at: '' })
    expect(await handedOverHomeOnHost(home, 'dev-a', '/a/.open-walnut/')).toMatch(/moved away from \(switch S1 to machine-b\)/)
    expect(await handedOverHomeOnHost(home, 'machine-a', '/a/.open-walnut')).toMatch(/moved away from/)
    // Another host with the same path, or another folder on that machine: no refusal.
    expect(await handedOverHomeOnHost(home, 'dev-h', '/a/.open-walnut')).toBeNull()
    expect(await handedOverHomeOnHost(home, 'dev-a', '/a/other')).toBeNull()
  })
})
