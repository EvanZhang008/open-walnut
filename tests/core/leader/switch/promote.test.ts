/**
 * The standby copy becoming the new leader's home (src/core/leader/switch/promote.ts): one
 * rename, read-write modes, the ledger's home column and standby.dir rewritten, safe to repeat,
 * and undone by demoteTrialHome.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import Database from '../../../../src/lib/sqlite.js'
import { demoteTrialHome, moveRoots, promoteCopy, promotedBy } from '../../../../src/core/leader/switch/promote.js'
import { homePathRules, rewriteLedgerHome } from '../../../../src/core/leader/switch/home-path-rules.js'
import { promotionRefusal, readPromoted } from '../../../../src/core/leader/switch/records.js'
import { leftoverPaths } from '../../../../src/core/leader/switch/self-check.js'

let root = ''
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-promote-')) })
afterEach(() => {
  // The copy's modes are read-only until promoted: give the owner write back before removing.
  const open = (p: string) => { try { fs.chmodSync(p, 0o700) } catch { /* gone */ } }
  const walk = (p: string) => { open(p); if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e)) }
  if (fs.existsSync(root)) walk(root)
  fs.rmSync(root, { recursive: true, force: true })
})

function ledger(file: string, rows: [string, string, string][]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.exec('CREATE TABLE applied_ops (host_key TEXT NOT NULL, home TEXT NOT NULL, op_id TEXT NOT NULL, rev INTEGER NOT NULL, applied_at INTEGER, outcome TEXT, PRIMARY KEY (host_key, home, op_id, rev))')
  db.exec('CREATE TABLE create_remap (host_key TEXT NOT NULL, home TEXT NOT NULL, minted TEXT NOT NULL, task_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (host_key, home, minted))')
  for (const [h, home, op] of rows) db.prepare('INSERT INTO applied_ops VALUES (?, ?, ?, 1, 1, ?)').run(h, home, op, '{}')
  db.close()
}

function homesOf(file: string): string[] {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare('SELECT home FROM applied_ops ORDER BY op_id').all() as { home: string }[]).map((r) => r.home) } finally { db.close() }
}

function makeCopy(standby: string, oldHome: string): void {
  const copy = path.join(standby, 'copy')
  fs.mkdirSync(path.join(copy, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(copy, 'notes', 'a.md'), '# a\n')
  fs.writeFileSync(path.join(copy, 'config.yaml'), YAML.stringify({ experimental: { switchable_leader: true }, standby: { dir: '/old/target' }, user: { name: 'x' } }))
  ledger(path.join(copy, 'cache', 'applied-ops.sqlite'), [['local', oldHome, 'op-1'], ['local', oldHome, 'op-2'], ['host-x', '/elsewhere', 'op-3']])
  // As the standby target leaves it: files 0400, dirs 0500.
  const ro = (p: string) => {
    if (fs.statSync(p).isDirectory()) { for (const e of fs.readdirSync(p)) ro(path.join(p, e)); fs.chmodSync(p, 0o500) } else fs.chmodSync(p, 0o400)
  }
  ro(copy)
}

describe('promoteCopy', () => {
  it('renames the copy into place, makes it writable and rewrites what names the old home', async () => {
    const standby = path.join(root, 'b', 'standby')
    const home = path.join(root, 'b', 'home')
    const oldHome = path.join(root, 'a', 'home')
    makeCopy(standby, oldHome)
    const r = await promoteCopy({ switchId: 's1', standbyDir: standby, home, previousHome: oldHome, reverseStandbyDir: path.join(root, 'a', 'standby') })
    expect(r.alreadyDone).toBe(false)
    expect(r.ledgerRows).toBe(2)
    expect(fs.existsSync(path.join(standby, 'copy'))).toBe(false)
    expect(fs.readFileSync(path.join(home, 'notes', 'a.md'), 'utf8')).toBe('# a\n')
    fs.writeFileSync(path.join(home, 'notes', 'a.md'), 'writable\n')
    expect(homesOf(path.join(home, 'cache', 'applied-ops.sqlite'))).toEqual([home, home, '/elsewhere'])
    const cfg = YAML.parse(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'))
    expect(cfg.standby.dir).toBe(path.join(root, 'a', 'standby'))
    expect(cfg.user.name).toBe('x')
    expect(promotedBy(home)).toBe('s1')
    // A rerun after a kill changes nothing more.
    const again = await promoteCopy({ switchId: 's1', standbyDir: standby, home, previousHome: oldHome, reverseStandbyDir: path.join(root, 'a', 'standby') })
    expect(again.alreadyDone).toBe(true)
    expect(fs.readFileSync(path.join(home, 'notes', 'a.md'), 'utf8')).toBe('writable\n')
  })

  it('keeps a folder already at the home path beside it, and demote puts it back', async () => {
    const standby = path.join(root, 'b', 'standby')
    const home = path.join(root, 'b', 'home')
    makeCopy(standby, '/old')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'previous.txt'), 'was here')
    const r = await promoteCopy({ switchId: 's2', standbyDir: standby, home, previousHome: '/old', reverseStandbyDir: '/rev' })
    expect(r.movedAside).toBe(`${home}.before-s2`)
    expect(fs.readFileSync(path.join(`${home}.before-s2`, 'previous.txt'), 'utf8')).toBe('was here')
    const d = await demoteTrialHome({ switchId: 's2', home })
    expect(d.keptAt).toBe(`${home}.trial-failed-s2`)
    expect(fs.readFileSync(path.join(home, 'previous.txt'), 'utf8')).toBe('was here')
    expect(fs.existsSync(path.join(`${home}.trial-failed-s2`, 'notes', 'a.md'))).toBe(true)
  })

  it('a kill right after the rename leaves a home marked as this switch\'s: a rerun finishes it, a rollback puts it aside', async () => {
    const standby = path.join(root, 'b', 'standby')
    const home = path.join(root, 'b', 'home')
    makeCopy(standby, '/old')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'previous.txt'), 'was here')
    const kill = () => { throw new Error('killed') }
    await expect(promoteCopy({ switchId: 's4', standbyDir: standby, home, previousHome: '/old', reverseStandbyDir: '/rev', afterRename: kill })).rejects.toThrow('killed')
    // Marked before it existed at the home's path: a server started on it by hand refuses (records.ts).
    expect(readPromoted(home)).toMatchObject({ switchId: 's4', state: 'promoting' })
    expect(promotionRefusal(home, { trial: false, commit: false })).toMatch(/switch s4/)
    const again = await promoteCopy({ switchId: 's4', standbyDir: standby, home, previousHome: '/old', reverseStandbyDir: '/rev' })
    expect(again.alreadyDone).toBe(true)
    expect(readPromoted(home)?.state).toBe('promoted')
    const d = await demoteTrialHome({ switchId: 's4', home })
    expect(d.keptAt).toBe(`${home}.trial-failed-s4`)
    expect(fs.readFileSync(path.join(home, 'previous.txt'), 'utf8')).toBe('was here')
  })

  it('a kill between moving the old folder aside and the copy\'s rename: demote brings the folder back', async () => {
    const home = path.join(root, 'b', 'home')
    fs.mkdirSync(`${home}.before-s5`, { recursive: true })
    fs.writeFileSync(path.join(`${home}.before-s5`, 'previous.txt'), 'was here')
    const d = await demoteTrialHome({ switchId: 's5', home })
    expect(d.restored).toBe(true)
    expect(fs.readFileSync(path.join(home, 'previous.txt'), 'utf8')).toBe('was here')
  })

  it('refuses when the copy is gone and the home is not this switch\'s', async () => {
    const home = path.join(root, 'b', 'home')
    fs.mkdirSync(home, { recursive: true })
    await expect(promoteCopy({ switchId: 's3', standbyDir: path.join(root, 'none'), home, previousHome: '/old', reverseStandbyDir: '/rev' })).rejects.toThrow(/is gone/)
  })
})

describe('rewriteLedgerHome', () => {
  it('moves rows to the new home; a row already there wins over the old one', () => {
    const f = path.join(root, 'cache', 'applied-ops.sqlite')
    ledger(f, [['local', '/old', 'op-1'], ['local', '/new', 'op-1'], ['local', '/old', 'op-2']])
    expect(rewriteLedgerHome(root, '/old', '/new')).toBe(1)
    expect(homesOf(f)).toEqual(['/new', '/new'])
  })

  it('does nothing without a ledger or when the path is the same', () => {
    expect(rewriteLedgerHome(root, '/old', '/new')).toBe(0)
    const f = path.join(root, 'cache', 'applied-ops.sqlite')
    ledger(f, [['local', '/same', 'op-1']])
    expect(rewriteLedgerHome(root, '/same', '/same')).toBe(0)
  })
})

describe('leftoverPaths (the trial\'s self-check)', () => {
  it('names a setting that still points into the old home; leader_switch and standby.dir are kept on purpose', () => {
    const home = path.join(root, 'b', 'home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({
      leader_switch: { machines: [{ id: 'a', home: '/srv/a/home' }] },
      standby: { dir: '/srv/a/standby' },
      notes: { extra_dirs: ['/srv/a/home/notes-extra', '/elsewhere'] },
      other: '/srv/a/homework',
    }))
    // A store no rule names: a new one, undecided.
    fs.mkdirSync(path.join(home, 'cache'), { recursive: true })
    fs.writeFileSync(path.join(home, 'cache', 'status-reconcile.json'), JSON.stringify({ at: '/srv/a/home/x' }))
    // A message a session was sent rides in the status cache with its words, paths and all: a record, kept.
    fs.writeFileSync(path.join(home, 'cache', 'status-riding.json'), JSON.stringify({ sessions: { s1: { t1: { turn: { text: 'please read /srv/a/home/notes/x.md' } } } } }))
    const roots = moveRoots({ previousHome: '/srv/a/home', home })
    const r = leftoverPaths(home, roots, homePathRules())
    expect(r.problems).toHaveLength(2)
    expect(r.problems[0]).toMatch(/left old paths where it rewrites them: config.yaml \(notes.extra_dirs\[\]\): \/srv\/a\/home\/notes-extra/)
    expect(r.problems[1]).toMatch(/no rule decides about .*cache\/status-reconcile.json \(at\): \/srv\/a\/home\/x/)
  })
})

describe('a home swapped around this machine\'s daemon state (home-manifest isMachineRuntimePath)', () => {
  const put = (dir: string, rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body) }
  const RUNTIME = ['tmp/leader/leader-k.json', 'tmp/offline-host/journal-k.ndjson', 'tmp/streams/s.jsonl', 'tmp/host-vitals/2026-11-23.jsonl']

  it('the daemon\'s files stay at their paths, the same files, written through an open fd during the swap; the rest goes aside and comes back on demote', async () => {
    const standby = path.join(root, 'b', 'standby')
    const home = path.join(root, 'b', 'home')
    makeCopy(standby, '/old')
    for (const f of RUNTIME) put(home, f, 'line 0\n')
    put(home, 'notes/old.md', '# old\n')
    put(home, 'tmp/plugins/p/scratch.txt', 'rebuildable, not the daemon\'s\n')
    put(home, 'local/leader-switch/handed-over.json', '{"state":"handed-over"}')
    const inodes = RUNTIME.map((f) => fs.statSync(path.join(home, f)).ino)
    const fd = fs.openSync(path.join(home, 'tmp/streams/s.jsonl'), 'a')
    let n = 0
    const timer = setInterval(() => fs.writeSync(fd, `line ${++n}\n`), 1)
    try {
      await promoteCopy({ switchId: 's7', standbyDir: standby, home, previousHome: '/old', reverseStandbyDir: '/rev' })
    } finally {
      clearInterval(timer)
    }
    fs.writeSync(fd, `line ${++n}\n`)
    fs.closeSync(fd)
    expect(RUNTIME.map((f) => fs.statSync(path.join(home, f)).ino)).toEqual(inodes)
    const lines = fs.readFileSync(path.join(home, 'tmp/streams/s.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toEqual(Array.from({ length: n + 1 }, (_, i) => `line ${i}`))
    expect(fs.readFileSync(path.join(home, 'notes', 'a.md'), 'utf8')).toBe('# a\n')
    const aside = `${home}.before-s7`
    expect(fs.readFileSync(path.join(aside, 'notes', 'old.md'), 'utf8')).toBe('# old\n')
    expect(fs.existsSync(path.join(aside, 'tmp/plugins/p/scratch.txt'))).toBe(true)
    expect(fs.existsSync(path.join(aside, 'local/leader-switch/handed-over.json'))).toBe(true)
    expect(RUNTIME.filter((f) => fs.existsSync(path.join(aside, f)))).toEqual([])
    expect(fs.existsSync(path.join(home, 'notes', 'old.md'))).toBe(false)
    // The trial failed: the tried entries go aside, the old ones come back, the daemon's stay.
    const d = await demoteTrialHome({ switchId: 's7', home })
    expect(d).toEqual({ keptAt: `${home}.trial-failed-s7`, restored: true })
    expect(RUNTIME.map((f) => fs.statSync(path.join(home, f)).ino)).toEqual(inodes)
    expect(fs.readFileSync(path.join(home, 'notes', 'old.md'), 'utf8')).toBe('# old\n')
    expect(fs.existsSync(path.join(home, 'notes', 'a.md'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'local/leader-switch/handed-over.json'))).toBe(true)
    expect(fs.existsSync(path.join(`${home}.trial-failed-s7`, 'notes', 'a.md'))).toBe(true)
    expect(fs.existsSync(aside)).toBe(false)
  })

  it('a kill part way through moving the old entries aside: a rerun finishes the swap', async () => {
    const standby = path.join(root, 'b', 'standby')
    const home = path.join(root, 'b', 'home')
    makeCopy(standby, '/old')
    put(home, 'tmp/leader/leader-k.json', '{}')
    put(home, 'notes/left.md', 'not moved yet\n')
    put(home, 'local/leader-switch/handed-over.json', '{}')
    put(`${home}.before-s8`, 'notes/moved.md', 'moved already\n')
    const r = await promoteCopy({ switchId: 's8', standbyDir: standby, home, previousHome: '/old', reverseStandbyDir: '/rev' })
    expect(r.movedAside).toBe(`${home}.before-s8`)
    expect(fs.readdirSync(path.join(`${home}.before-s8`, 'notes')).sort()).toEqual(['left.md', 'moved.md'])
    expect(fs.existsSync(path.join(`${home}.before-s8`, 'local/leader-switch/handed-over.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'tmp/leader/leader-k.json'))).toBe(true)
    expect(promotedBy(home)).toBe('s8')
  })

  it('a kill part way through moving the copy in (its mark is in the home): a rerun moves the rest in, nothing aside again', async () => {
    const standby = path.join(root, 'b', 'standby')
    const home = path.join(root, 'b', 'home')
    makeCopy(standby, '/old')
    // As a kill leaves it: the copy's local/ (the mark) and notes/ are in, the rest still in the copy.
    const copy = path.join(standby, 'copy')
    fs.chmodSync(copy, 0o700)
    put(home, 'tmp/leader/leader-k.json', '{}')
    fs.chmodSync(path.join(copy, 'notes'), 0o700)
    fs.renameSync(path.join(copy, 'notes'), path.join(home, 'notes'))
    fs.mkdirSync(path.join(home, 'local', 'leader-switch'), { recursive: true })
    fs.writeFileSync(path.join(home, 'local', 'leader-switch', 'promoted.json'), JSON.stringify({ switchId: 's9', state: 'promoting', from: '/old', at: new Date().toISOString() }))
    put(`${home}.before-s9`, 'previous.txt', 'was here')
    const r = await promoteCopy({ switchId: 's9', standbyDir: standby, home, previousHome: '/old', reverseStandbyDir: '/rev' })
    expect(fs.existsSync(copy)).toBe(false)
    expect(fs.existsSync(path.join(home, 'config.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'notes', 'a.md'))).toBe(true)
    expect(fs.readdirSync(`${home}.before-s9`)).toEqual(['previous.txt'])
    expect(r.movedAside).toBe(`${home}.before-s9`)
  })
})

describe('leftoverPaths: leader data the scan could not read fails the trial, unless a rule marks it', () => {
  it('a file over the cap, a database that will not open and an unnamed binary fail; a blob, a kept store\'s binary and the user\'s own file do not', () => {
    const home = path.join(root, 'b', 'home')
    const put = (rel: string, body: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), body) }
    put('triggers/t/big.log', 'x'.repeat(5000))
    put('plugin-data/p/broken.sqlite', Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(200, 7)]))
    put('plugin-files/p/tool', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]))
    put('plugins/p/icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    put('notes/scan.heic.bin', Buffer.from([1, 0, 2]))
    put('my-own-archive.dat', Buffer.from([1, 0, 2]))
    const roots = moveRoots({ previousHome: '/srv/a/home', home })
    const r = leftoverPaths(home, roots, homePathRules(), { maxFileBytes: 1000 })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/could not read/)
    for (const f of ['triggers/t/big.log', 'plugin-data/p/broken.sqlite', 'plugin-files/p/tool']) expect(r.problems[0]).toContain(f)
    for (const f of ['icon.png', 'scan.heic.bin', 'my-own-archive.dat']) expect(r.problems[0]).not.toContain(f)
  })
})
