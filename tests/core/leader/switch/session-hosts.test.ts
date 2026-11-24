/**
 * Where sessions run after a switch between machines (src/core/leader/switch/session-hosts.ts): the old
 * leader's own daemon's sessions name the old machine, the new machine's name none, a host-judged row
 * keeps its key, and a second run of the same switch changes nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import Database from '../../../../src/lib/sqlite.js'
import { moveSessionHosts } from '../../../../src/core/leader/switch/session-hosts.js'
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
  ['on-h', 'machine-h', '{}'], ['on-b', 'machine-b', '{}'], ['on-b-judged', 'machine-b', judgedByHost],
]

describe('moveSessionHosts', () => {
  it('moves the old leader\'s own daemon\'s sessions to the old machine and the new machine\'s to its own daemon', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, rows)
    const r = moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })
    expect(r).toEqual({ toOldMachine: 3, toOwnDaemon: 1, alreadyDone: false })
    expect(hosts(home)).toEqual({
      'on-b': null, 'on-b-judged': 'machine-b', 'on-h': 'machine-h',
      'own-empty': 'machine-a', 'own-local': 'machine-a', 'own-null': 'machine-a',
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
    expect(moveSessionHosts(home, 's1', { oldMachine: 'machine-a', newMachine: 'machine-b' })).toEqual({ toOldMachine: 0, toOwnDaemon: 0, alreadyDone: true })
    expect(hosts(home)).toEqual(after)
    // The switch back is another switch: the same rule the other way.
    expect(moveSessionHosts(home, 's2', { oldMachine: 'machine-b', newMachine: 'machine-a' })).toMatchObject({ toOldMachine: 1, toOwnDaemon: 3 })
    expect(hosts(home)).toMatchObject({ 'own-null': null, 'own-local': null, 'on-b': 'machine-b', 'on-b-judged': 'machine-b', 'on-h': 'machine-h' })
  })

  it('without the new machine\'s key only the old leader\'s sessions move; without a sessions store nothing happens', () => {
    const home = path.join(root, 'home')
    sessionsDb(home, rows)
    expect(moveSessionHosts(home, 's1', { oldMachine: 'machine-a' })).toEqual({ toOldMachine: 3, toOwnDaemon: 0, alreadyDone: false })
    expect(hosts(home)['on-b']).toBe('machine-b')
    expect(moveSessionHosts(path.join(root, 'none'), 's1', { oldMachine: 'machine-a' })).toEqual({ toOldMachine: 0, toOwnDaemon: 0, alreadyDone: false })
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
    expect(r.sessionHosts).toEqual({ toOldMachine: 3, toOwnDaemon: 1, alreadyDone: false })
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
    const told = await offlineCheck({ ...o, changed: ['sessions.sqlite'] })
    expect(told.problems).toEqual([])
    expect(told.ok).toBe(true)
  })
})
