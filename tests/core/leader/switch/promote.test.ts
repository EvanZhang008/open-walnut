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
import { demoteTrialHome, promoteCopy, promotedBy, rewriteLedgerHome } from '../../../../src/core/leader/switch/promote.js'
import { promotionRefusal, readPromoted } from '../../../../src/core/leader/switch/records.js'
import { configPathsInto } from '../../../../src/core/leader/switch/self-check.js'

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

describe('configPathsInto (the trial\'s self-check)', () => {
  it('finds settings that still name the old home, leader_switch aside', () => {
    const home = path.join(root, 'b', 'home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({
      leader_switch: { machines: [{ id: 'a', home: '/srv/a/home' }] },
      standby: { dir: '/srv/a/standby' },
      notes: { extra_dirs: ['/srv/a/home/notes-extra', '/elsewhere'] },
      other: '/srv/a/homework',
    }))
    expect(configPathsInto(home, '/srv/a/home')).toEqual(['notes.extra_dirs[0]'])
  })
})
