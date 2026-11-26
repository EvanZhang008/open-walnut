/**
 * Where sessions run after a switch between machines (src/core/leader/switch/session-hosts.ts): the old
 * leader's own daemon's sessions name the old machine, the new machine's name none, a host-judged row
 * keeps its key, a router area's own conversation keeps its area's host, and a second run of the same
 * switch changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import Database from '../../../../src/lib/sqlite.js'
import { AREA_PROFILE_SQL, moveSessionHosts } from '../../../../src/core/leader/switch/session-hosts.js'
import { isRouterAreaSession, routerAreaProfile } from '../../../../src/core/router/session-policy.js'
import { hasAreaProfile } from '../../../../src/core/router/history-write.js'
import { promoteCopy } from '../../../../src/core/leader/switch/promote.js'

let root = ''
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-session-hosts-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

type Row = [sid: string, host: string | null, payload: string | null]

function sessionsDb(home: string, rows: Row[]): void {
  fs.mkdirSync(home, { recursive: true })
  const db = new Database(path.join(home, 'sessions.sqlite'))
  db.exec('CREATE TABLE sessions (claude_session_id TEXT PRIMARY KEY, host TEXT, payload TEXT)')
  db.exec('CREATE TABLE session_channel_cursor (host_id TEXT, log_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(host_id))')
  db.prepare('INSERT INTO session_channel_cursor VALUES (?, ?, ?)').run('machine-b', 'log-1', 7)
  for (const r of rows) db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(...r)
  db.close()
}

function hosts(home: string): Record<string, string | null> {
  const db = new Database(path.join(home, 'sessions.sqlite'), { readonly: true })
  try {
    return Object.fromEntries((db.prepare('SELECT claude_session_id AS sid, host FROM sessions ORDER BY sid').all() as Array<{ sid: string; host: string | null }>).map((r) => [r.sid, r.host]))
  } finally { db.close() }
}

const judgedByHost = JSON.stringify({ judge: 'host' })
const rows: Row[] = [
  ['own-null', null, '{}'], ['own-empty', '', null], ['own-local', '__local__', '{}'],
  // No host: the leader's row whatever its payload says (judgedByHost needs a host), so it moves too.
  ['own-null-judged', null, judgedByHost],
  ['on-h', 'machine-h', '{}'], ['on-b', 'machine-b', '{}'], ['on-b-judged', 'machine-b', judgedByHost],
]

describe('moveSessionHosts', () => {
  it('moves the old leader\'s own daemon\'s sessions to the old machine and the new machine\'s to its own daemon', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, rows)
    const r = moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })
    expect(r).toEqual({ toOldMachine: 4, toOwnDaemon: 1, homeMoved: 0, homeEnded: 0, alreadyDone: false })
    expect(hosts(home)).toEqual({
      'on-b': null, 'on-b-judged': 'machine-b', 'on-h': 'machine-h',
      'own-empty': 'machine-a', 'own-local': 'machine-a', 'own-null': 'machine-a', 'own-null-judged': 'machine-a',
    })
    // The channel's position is keyed by a host that did not move.
    const db = new Database(path.join(home, 'sessions.sqlite'), { readonly: true })
    try { expect(db.prepare('SELECT host_id, seq FROM session_channel_cursor').all()).toEqual([{ host_id: 'machine-b', seq: 7 }]) } finally { db.close() }
  })

  it('runs once per switch: the same switch again changes nothing (the swap is not its own inverse)', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, rows)
    moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })
    const after = hosts(home)
    expect(moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })).toEqual({ toOldMachine: 0, toOwnDaemon: 0, homeMoved: 0, homeEnded: 0, alreadyDone: true })
    expect(hosts(home)).toEqual(after)
    // The switch back is another switch: the same rule the other way.
    expect(moveSessionHosts(home, 's2', { oldMachine: 'machine-b', newMachine: 'machine-a' })).toMatchObject({ toOldMachine: 1, toOwnDaemon: 3 })
    expect(hosts(home)).toMatchObject({ 'own-null': null, 'own-local': null, 'on-b': 'machine-b', 'on-b-judged': 'machine-b', 'on-h': 'machine-h' })
  })

  it('without the new machine\'s key only the old leader\'s sessions move; without a sessions store nothing happens', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, rows)
    expect(moveSessionHosts(home, 's1', { oldMachine: 'machine-a' })).toEqual({ toOldMachine: 4, toOwnDaemon: 0, homeMoved: 0, homeEnded: 0, alreadyDone: false })
    expect(hosts(home)['on-b']).toBe('machine-b')
    expect(moveSessionHosts(path.join(root, 'none'), 's1', { oldMachine: 'machine-a' })).toEqual({ toOldMachine: 0, toOwnDaemon: 0, homeMoved: 0, homeEnded: 0, alreadyDone: false })
  })
})

describe('promoteCopy between machines', () => {
  function copyWithSessions(standby: string): void {
    const copy = path.join(standby, 'copy')
    fs.mkdirSync(copy, { recursive: true })
    fs.writeFileSync(path.join(copy, 'config.yaml'), YAML.stringify({ experimental: { switchable_leader: true }, standby: { dir: '/old/target' } }))
    sessionsDb(copy, rows)
  }

  it('moves the sessions when the copy came over a daemon link (reverseStandbyHost), and only then', async () => {
    const a = path.join(root, 'a')
    copyWithSessions(path.join(a, 'standby'))
    const r = await promoteCopy({ switchId: 's1', standbyDir: path.join(a, 'standby'), home: path.join(a, 'home'), previousHome: '/old/home', reverseStandbyDir: '/old/standby', reverseStandbyHost: 'machine-a', ownHostKey: 'machine-b' })
    expect(r.sessionHosts).toEqual({ toOldMachine: 4, toOwnDaemon: 1, homeMoved: 0, homeEnded: 0, alreadyDone: false })
    expect(hosts(path.join(a, 'home'))['own-null']).toBe('machine-a')
    // A promotion run again (a resume after a kill) keeps them where the first put them.
    const again = await promoteCopy({ switchId: 's1', standbyDir: path.join(a, 'standby'), home: path.join(a, 'home'), previousHome: '/old/home', reverseStandbyDir: '/old/standby', reverseStandbyHost: 'machine-a', ownHostKey: 'machine-b' })
    expect(again.sessionHosts?.alreadyDone).toBe(true)
    expect(hosts(path.join(a, 'home'))).toMatchObject({ 'own-null': 'machine-a', 'on-b': null })

    const b = path.join(root, 'b')
    copyWithSessions(path.join(b, 'standby'))
    const local = await promoteCopy({ switchId: 's1', standbyDir: path.join(b, 'standby'), home: path.join(b, 'home'), previousHome: '/old/home', reverseStandbyDir: '/old/standby' })
    expect(local.sessionHosts).toBeUndefined()
    expect(hosts(path.join(b, 'home'))['own-null']).toBeNull()
  })
})

describe('the trial\'s offline check of a home whose sessions moved', () => {
  it('compares the sessions store\'s size and rows with the copy\'s only where the promotion did not change it', async () => {
    const { offlineCheck, readCopyFacts } = await import('../../../../src/core/leader/switch/self-check.js')
    const { moveRoots } = await import('../../../../src/core/leader/switch/promote.js')
    const { homePathRules } = await import('../../../../src/core/leader/switch/home-path-rules.js')
    const home = path.join(root, 'home')
    sessionsDb(home, rows)
    const files = [{ p: 'sessions.sqlite', size: fs.statSync(path.join(home, 'sessions.sqlite')).size, h: 'x', db: 1 }] as unknown as import('../../../../src/core/standby/types.js').BatchFile[]
    const facts = await readCopyFacts(home, files)
    moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })
    const o = { facts, home, files, roots: moveRoots({ previousHome: '/old/home', home }), rules: homePathRules() }
    // Red control: the switch's mark is a row of its own, so the store holds more rows than the copy did.
    const plain = await offlineCheck(o)
    expect(plain.ok).toBe(false)
    expect(plain.problems.join('; ')).toMatch(/sessions\.sqlite/)
    const changed = { 'sessions.sqlite': { table: 'leader_switch_session_hosts', addedRows: 1 } }
    const told = await offlineCheck({ ...o, changed })
    expect(told.problems).toEqual([])
    expect(told.ok).toBe(true)
    // The rows are still compared, table by table: a session row lost on the way fails it.
    const db = new Database(path.join(home, 'sessions.sqlite'))
    db.prepare("DELETE FROM sessions WHERE claude_session_id = 'on-h'").run()
    db.close()
    const lost = await offlineCheck({ ...o, changed })
    expect(lost.problems.join('; ')).toMatch(/sessions\.sqlite: rows in the new home differ from the copy it was made from: sessions 6 \(the copy 7\)/)
    // And a lost row beside one added elsewhere in the same store never cancels out (the total is the copy's plus one).
    const db2 = new Database(path.join(home, 'sessions.sqlite'))
    db2.prepare("INSERT INTO leader_switch_session_hosts (switch_id, at) VALUES ('s0', 'x')").run()
    db2.close()
    const even = await offlineCheck({ ...o, changed })
    expect(even.problems.join("; ")).toMatch(/leader_switch_session_hosts 2 \(the copy 0, and 1 the promotion added\), sessions 6 \(the copy 7\)/)
    // Red control: the totals alone (a job that read its copy before table counts were kept) miss exactly that.
    const { tableRows: _t, ...oldFacts } = facts
    expect((await offlineCheck({ ...o, facts: oldFacts, changed })).problems).toEqual([])
    const { sessionHostsMarked } = await import('../../../../src/core/leader/switch/session-hosts.js')
    expect(sessionHostsMarked(home, 's1')).toBe(true)
    expect(sessionHostsMarked(home, 's2')).toBe(false)
  })
})

describe('the offline check after the trial server ran (a resumed switch)', () => {
  it('does not require the dated copies of config.yaml, which a server\'s config write prunes; every other file it does', async () => {
    const { offlineCheck, readCopyFacts } = await import('../../../../src/core/leader/switch/self-check.js')
    const { moveRoots } = await import('../../../../src/core/leader/switch/promote.js')
    const { homePathRules } = await import('../../../../src/core/leader/switch/home-path-rules.js')
    const home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, 'config.yaml.history'), { recursive: true })
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(home, 'notes', 'a.md'), '# a\n')
    const files = [{ p: 'config.yaml.history/config-20261124T072034.846Z-751cac566548.yaml', size: 10, h: 'x' }, { p: 'notes/a.md', size: 4, h: 'y' }] as unknown as import('../../../../src/core/standby/types.js').BatchFile[]
    const o = { facts: await readCopyFacts(home, files), home, files, roots: moveRoots({ previousHome: '/old/home', home }), rules: homePathRules() }
    // The first pass (no server ran yet) requires the copy: red control for the rule below.
    expect((await offlineCheck(o)).problems.join('; ')).toMatch(/config\.yaml\.history\/config-20261124T072034\.846Z-751cac566548\.yaml: missing/)
    expect((await offlineCheck({ ...o, sizesAndRows: false })).problems).toEqual([])
    fs.rmSync(path.join(home, 'notes', 'a.md'))
    expect((await offlineCheck({ ...o, sizesAndRows: false })).problems.join('; ')).toMatch(/notes\/a\.md: missing/)
  })
})

describe('a row whose host is the leader\'s role, not a machine', () => {
  const area = { id: 'area-1', host: '__local__' } as Parameters<typeof isRouterAreaSession>[1]
  const routerRow = (sid: string, host: string | null): Row => [sid, host, JSON.stringify({ profile: routerAreaProfile(area.id) })]
  const recordOf = (home: string, sid: string) => {
    const db = new Database(path.join(home, 'sessions.sqlite'), { readonly: true })
    try {
      const r = db.prepare('SELECT host, payload FROM sessions WHERE claude_session_id = ?').get(sid) as { host: string | null; payload: string }
      return { host: r.host ?? undefined, profile: JSON.parse(r.payload).profile }
    } finally { db.close() }
  }

  it('a router area\'s own conversation stays on its area\'s host, so the new leader still wakes it as the area\'s', () => {
    const home = path.join(root, 'home')
    // An older build's receiver profile ('work') reads as no area profile (history-write.ts): an ordinary row, it moves.
    const workRow: Row = ['work-null', null, JSON.stringify({ profile: { areaId: area.id, areaRole: 'work', areaPolicyVersion: 1 } })]
    sessionsDb(home, [...rows, routerRow('router-null', null), routerRow('router-local', '__local__'), workRow])
    expect(isRouterAreaSession(recordOf(home, 'router-null'), area)).toBe(true)
    const r = moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })
    expect(r).toEqual({ toOldMachine: 5, toOwnDaemon: 1, homeMoved: 0, homeEnded: 0, alreadyDone: false })
    expect(hosts(home)).toMatchObject({ 'router-null': null, 'router-local': '__local__', 'work-null': 'machine-a', 'own-null': 'machine-a', 'on-b': null })
    // router/wake.ts refuses a router task with any row isRouterAreaSession does not take: both are still the area's.
    expect(isRouterAreaSession(recordOf(home, 'router-null'), area)).toBe(true)
    expect(isRouterAreaSession(recordOf(home, 'router-local'), area)).toBe(true)
    // A switch back leaves them too, and a router row on the new machine's key (an area named after a host) keeps it.
    const back = path.join(root, 'back')
    sessionsDb(back, [routerRow('router-on-b', 'machine-b'), routerRow('router-null', null)])
    expect(moveSessionHosts(back, 's2', { oldMachine: 'machine-a', newMachine: 'machine-b' })).toEqual({ toOldMachine: 0, toOwnDaemon: 0, homeMoved: 0, homeEnded: 0, alreadyDone: false })
    expect(hosts(back)).toEqual({ 'router-null': null, 'router-on-b': 'machine-b' })
  })

  it('the step\'s SQL reads an area profile exactly as the router\'s history rule does', () => {
    const profiles: unknown[] = [
      undefined, null, 'router', {}, { slim: true }, routerAreaProfile('a'),
      { areaId: 'a' }, { areaRole: 'router' }, { areaPolicyVersion: 1 }, { areaId: null }, { areaRole: 'work', areaId: 'a' },
      { areaRole: 'work' }, { areaRole: null }, { areaRole: 'other', areaPolicyVersion: 2 }, { area: 'a' }, { areaIdx: 'a' },
    ]
    const db = new Database(':memory:')
    try {
      for (const profile of profiles) {
        const payload = profile === undefined ? JSON.stringify({ engine: 'claude' }) : JSON.stringify({ profile })
        const sql = (db.prepare(`SELECT CASE WHEN ${AREA_PROFILE_SQL} THEN 1 ELSE 0 END AS v FROM (SELECT ? AS payload)`).get(payload) as { v: number }).v === 1
        expect(sql, JSON.stringify(profile)).toBe(hasAreaProfile({ profile: profile as never }))
      }
      expect((db.prepare(`SELECT CASE WHEN ${AREA_PROFILE_SQL} THEN 1 ELSE 0 END AS v FROM (SELECT ? AS payload)`).get('not json') as { v: number }).v).toBe(0)
    } finally { db.close() }
  })
})
