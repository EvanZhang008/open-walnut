/**
 * The scan and rewrite of old-machine paths in a promoted home (src/core/leader/switch/home-paths.ts):
 * the boundary of a root, Unicode, escapes in JSON, Windows separators, SQLite columns and JSON
 * in them, YAML by key with its comments kept, and a rewrite that is safe to run again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from '../../../../src/lib/sqlite.js'
import { findRoots, judgePathHits, pathRoots, replaceRoots, rewriteHomePaths, scanHomePaths, type PathRoot, type PathRule } from '../../../../src/core/leader/switch/home-paths.js'

let root = ''
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-home-paths-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const ROOTS: PathRoot[] = [
  { kind: 'home', from: '/home/a/.open-walnut', to: '/Users/b/.open-walnut' },
  { kind: 'account', from: '/home/a', to: '/Users/b' },
]

function put(home: string, rel: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true })
  fs.writeFileSync(path.join(home, rel), content)
}

describe('matching a root', () => {
  it('a name that only shares the prefix is not under it', () => {
    expect(findRoots('/home/ab/x /home/a.bak /home/a-2 /home/a_old', ROOTS)).toEqual([])
    expect(findRoots('cd /home/a/x', ROOTS).map((m) => m.root.kind)).toEqual(['account'])
    expect(findRoots('/home/a', ROOTS)).toHaveLength(1)
    expect(findRoots('"/home/a"', ROOTS)).toHaveLength(1)
  })

  it('a root inside another path is not one; file:// URLs are', () => {
    expect(findRoots('/mnt/home/a/x', ROOTS)).toEqual([])
    expect(findRoots('see file:///home/a/x.md', ROOTS).map((m) => m.root.kind)).toEqual(['account'])
  })

  it('the longest root wins: a path in the home is the home\'s, not the account\'s', () => {
    expect(findRoots('/home/a/.open-walnut/tasks', ROOTS).map((m) => m.root.kind)).toEqual(['home'])
    expect(replaceRoots('/home/a/.open-walnut/tasks and /home/a/code', ROOTS)).toBe('/Users/b/.open-walnut/tasks and /Users/b/code')
  })

  it('Unicode names on both sides', () => {
    const roots = pathRoots({ fromHome: '/home/émile/données', toHome: '/Users/张三/数据' })
    expect(replaceRoots('/home/émile/données/notes/café ✓.md', roots)).toBe('/Users/张三/数据/notes/café ✓.md')
    // "donnéesX" shares the prefix only (a letter, not a separator, follows).
    expect(findRoots('/home/émile/donnéesé', roots)).toEqual([])
  })

  it('Windows roots: either separator after them, separators turned when the style changes', () => {
    const roots = pathRoots({ fromHome: 'C:\\Users\\a\\.open-walnut', toHome: '/home/a/.open-walnut', fromAccount: 'C:\\Users\\a', toAccount: '/home/a' })
    expect(replaceRoots('C:\\Users\\a\\code\\proj', roots)).toBe('/home/a/code/proj')
    expect(replaceRoots('C:\\Users\\a\\.open-walnut\\tasks', roots)).toBe('/home/a/.open-walnut/tasks')
    expect(findRoots('C:\\Users\\ab\\x', roots)).toEqual([])
    const back = pathRoots({ fromHome: '/home/a/.open-walnut', toHome: 'C:\\Users\\a\\.open-walnut' })
    expect(replaceRoots('/home/a/.open-walnut/notes/x.md', back)).toBe('C:\\Users\\a\\.open-walnut\\notes\\x.md')
  })

  it('a new root under the old one is not found again, so a rewrite runs twice to the same result', () => {
    const roots = pathRoots({ fromHome: '/srv/w', toHome: '/srv/w/moved' })
    const once = replaceRoots('/srv/w/tasks', roots)
    expect(once).toBe('/srv/w/moved/tasks')
    expect(replaceRoots(once, roots)).toBe(once)
    expect(findRoots(once, roots)).toEqual([])
  })

  it('pathRoots leaves out a root that does not change', () => {
    expect(pathRoots({ fromHome: '/a/h', toHome: '/a/h2', fromAccount: '/a', toAccount: '/a' }).map((r) => r.kind)).toEqual(['home'])
  })
})

describe('scanHomePaths', () => {
  it('reports file, key path or line, and the path, for JSON, JSON lines, YAML and text', () => {
    const home = path.join(root, 'h')
    put(home, 'a.json', JSON.stringify({ list: [{ cwd: '/home/a/code/x' }], byId: { 'f3-1': { file: '/home/a/.open-walnut/notes/n.md' } }, '/home/a/key': 1 }, null, 2))
    put(home, 'b.jsonl', `${JSON.stringify({ cwd: '/home/a/p' })}\nnot json /home/a/q\n`)
    put(home, 'c.yaml', 'x:\n  dir: /home/a/backups  # comment\nlist:\n  - /home/a/.open-walnut/plugins\n')
    put(home, 'd.md', 'line one\nthe repo is at /home/a/code/x, see it\n')
    const r = scanHomePaths(home, ROOTS)
    const got = r.hits.map((h) => [h.file, h.at, h.line ?? null, h.path, h.root])
    expect(got).toEqual(expect.arrayContaining([
      ['a.json', 'list[].cwd', null, '/home/a/code/x', 'account'],
      ['a.json', 'byId.*.file', null, '/home/a/.open-walnut/notes/n.md', 'home'],
      ['a.json', '{key}', null, '/home/a/key', 'account'],
      ['b.jsonl', 'cwd', 1, '/home/a/p', 'account'],
      ['b.jsonl', '', 2, '/home/a/q', 'account'],
      ['c.yaml', 'x.dir', null, '/home/a/backups', 'account'],
      ['c.yaml', 'list[]', null, '/home/a/.open-walnut/plugins', 'home'],
      ['d.md', '', 2, '/home/a/code/x', 'account'],
    ]))
    expect(r.hits).toHaveLength(8)
  })

  it('paths inside JSON strings with escapes: a quote, a backslash, \\u escapes and \\/', () => {
    const home = path.join(root, 'h')
    const roots = pathRoots({ fromHome: '/home/zoë/w', toHome: '/home/z/w' })
    // Written the way a writer that escapes non-ASCII and slashes would.
    put(home, 'esc.json', '{"p":"\\/home\\/zo\\u00eb\\/w\\/notes\\/say \\"hi\\".md","q":"C:\\\\x"}')
    const r = scanHomePaths(home, roots)
    expect(r.hits.map((h) => [h.at, h.path])).toEqual([['p', '/home/zoë/w/notes/say "hi".md']])
    rewriteHomePaths(home, [{ id: 'all', stores: [], file: 'esc.json', rule: 'rewrite', why: 't' }], { roots, reverseStandbyDir: '/x' })
    expect(JSON.parse(fs.readFileSync(path.join(home, 'esc.json'), 'utf8')).p).toBe('/home/z/w/notes/say "hi".md')
  })

  it('SQLite: text columns by table.column and row, JSON in a column by its key path, escaped forms found', () => {
    const home = path.join(root, 'h')
    fs.mkdirSync(home, { recursive: true })
    const db = new Database(path.join(home, 's.sqlite'))
    db.exec('CREATE TABLE s (id TEXT PRIMARY KEY, cwd TEXT, meta TEXT, n INTEGER)')
    db.exec('CREATE TABLE w (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID')
    db.prepare('INSERT INTO s VALUES (?, ?, ?, ?)').run('1', '/home/a/code', JSON.stringify({ plan: '/home/a/.open-walnut/plans/p.md' }), 3)
    db.prepare('INSERT INTO s VALUES (?, ?, ?, ?)').run('2', '/home/ab/other', '{"x":"/home/caf\\u00e9"}', 4)
    db.prepare('INSERT INTO w VALUES (?, ?)').run('k', '/home/a/w')
    db.close()
    const roots: PathRoot[] = [...ROOTS, { kind: 'account', from: '/home/café', to: '/Users/c' }]
    const r = scanHomePaths(home, roots)
    expect(r.hits.map((h) => [h.at, h.row ?? null, h.path])).toEqual(expect.arrayContaining([
      ['s.cwd', 1, '/home/a/code'],
      ['s.meta:plan', 1, '/home/a/.open-walnut/plans/p.md'],
      ['s.meta:x', 2, '/home/café'],
      ['w.v', null, '/home/a/w'],
    ]))
    expect(r.hits).toHaveLength(4)
  })

  it('binaries are skipped, a file over the cap is listed as skipped, -wal siblings are read through their database', () => {
    const home = path.join(root, 'h')
    put(home, 'img.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from('/home/a/x')]))
    put(home, 'big.txt', `/home/a/x\n${'y'.repeat(2000)}`)
    put(home, 'db.sqlite-wal', '/home/a/x')
    const r = scanHomePaths(home, ROOTS, { maxFileBytes: 1000 })
    expect(r.hits).toEqual([])
    expect(r.skipped.map((s) => s.file)).toEqual(['big.txt'])
  })

  it('caps the hits kept per place and counts the rest', () => {
    const home = path.join(root, 'h')
    put(home, 'many.json', JSON.stringify({ l: Array.from({ length: 50 }, (_, i) => `/home/a/${i}`) }))
    const r = scanHomePaths(home, ROOTS, { hitsPerPlace: 5 })
    expect(r.hits).toHaveLength(5)
    expect(r.counts['many.json\tl[]']).toBe(50)
  })
})

describe('rewriteHomePaths', () => {
  const rules: PathRule[] = [
    { id: 'json-cwd', stores: [], file: '*.json', at: 'list[].cwd', rule: 'rewrite', why: 't' },
    { id: 'yaml-dir', stores: [], file: 'c.yaml', at: 'x.dir', rule: 'rewrite', why: 't' },
    { id: 'db-cwd', stores: [], file: 's.sqlite', at: 's.cwd', rule: 'rewrite', why: 't' },
    { id: 'db-plan', stores: [], file: 's.sqlite', at: 's.meta:plan', rule: 'rewrite', why: 't' },
    { id: 'account-only', stores: [], file: 'acc.json', rule: 'rewrite', root: 'account', why: 't' },
  ]

  it('moves only the places a rule names, keeps formatting and YAML comments, and runs again to the same bytes', () => {
    const home = path.join(root, 'h')
    put(home, 'a.json', `${JSON.stringify({ list: [{ cwd: '/home/a/code/x', note: '/home/a/keep' }] }, null, 2)}\n`)
    put(home, 'c.yaml', '# top\nx:\n  dir: /home/a/backups  # where\n  other: /home/a/stay\n')
    put(home, 'acc.json', JSON.stringify({ h: '/home/a/.open-walnut/x', a: '/home/a/y' }))
    const db = new Database(path.join(home, 's.sqlite'))
    db.exec('CREATE TABLE s (id TEXT PRIMARY KEY, cwd TEXT, meta TEXT)')
    db.prepare('INSERT INTO s VALUES (?, ?, ?)').run('1', '/home/a/code', JSON.stringify({ plan: '/home/a/.open-walnut/p.md', log: '/home/a/log' }))
    db.close()
    const ctx = { roots: ROOTS, reverseStandbyDir: '/x' }
    const done = rewriteHomePaths(home, rules, ctx)
    expect(done.map((d) => d.file).sort()).toEqual(['a.json', 'acc.json', 'c.yaml', 's.sqlite'])
    expect(fs.readFileSync(path.join(home, 'a.json'), 'utf8')).toBe(`${JSON.stringify({ list: [{ cwd: '/Users/b/code/x', note: '/home/a/keep' }] }, null, 2)}\n`)
    expect(fs.readFileSync(path.join(home, 'c.yaml'), 'utf8')).toBe('# top\nx:\n  dir: /Users/b/backups # where\n  other: /home/a/stay\n')
    // Only the account root: a path in the old home stays as it was.
    expect(JSON.parse(fs.readFileSync(path.join(home, 'acc.json'), 'utf8'))).toEqual({ h: '/home/a/.open-walnut/x', a: '/Users/b/y' })
    const rdb = new Database(path.join(home, 's.sqlite'), { readonly: true })
    const row = rdb.prepare('SELECT cwd, meta FROM s').get() as { cwd: string; meta: string }
    rdb.close()
    expect(row.cwd).toBe('/Users/b/code')
    expect(JSON.parse(row.meta)).toEqual({ plan: '/Users/b/.open-walnut/p.md', log: '/home/a/log' })
    const bytes = (f: string) => fs.readFileSync(path.join(home, f))
    const before = ['a.json', 'c.yaml', 'acc.json', 's.sqlite'].map(bytes)
    expect(rewriteHomePaths(home, rules, ctx)).toEqual([])
    expect(['a.json', 'c.yaml', 'acc.json', 's.sqlite'].map(bytes)).toEqual(before)
  })
})

describe('judgePathHits', () => {
  it('kept, not rewritten, and unknown; a file no store writes is the user\'s own', () => {
    const rules: PathRule[] = [
      { id: 'k', stores: [], file: 'tasks/**', at: 'title', rule: 'keep', why: 't' },
      { id: 'r', stores: [], file: 'tasks/**', at: 'cwd', rule: 'rewrite', why: 't' },
    ]
    const h = (file: string, at: string) => ({ file, at, path: '/home/a/x', root: 'account' as const })
    const j = judgePathHits([h('tasks/t.json', 'title'), h('tasks/t.json', 'cwd'), h('tasks/t.json', 'other'), h('my-own-folder/x.json', 'a'), h('server.lock.json', 'cwd')], rules)
    expect(j.kept.map((k) => k.rule)).toEqual(['k', 'user-file', 'manifest-machine'])
    expect(j.notRewritten.map((k) => k.rule)).toEqual(['r'])
    expect(j.unknown.map((u) => u.at)).toEqual(['other'])
  })
})

/**
 * The scan's time on a home of real-sized stores (WALNUT_HOME_PATHS_BENCH=1): 20k notes, 2k task
 * files, a sessions database of 50k rows, a tasks database of 20k rows, a 200k-line log.
 */
describe.runIf(process.env.WALNUT_HOME_PATHS_BENCH === '1')('scan time on a realistic synthetic home', () => {
  it('measures the full scan and the trial\'s scan (kept places skipped)', async () => {
    const { homePathRules } = await import('../../../../src/core/leader/switch/home-path-rules.js')
    const { keptPlace } = await import('../../../../src/core/leader/switch/home-paths.js')
    const home = path.join(root, 'bench')
    const A = '/home/a'
    const text = (i: number) => `# Note ${i}\n\n${'Some words about the work, nothing special. '.repeat(40)}\n${i % 50 === 0 ? `The repo is ${A}/code/p${i}\n` : ''}`
    for (let i = 0; i < 20_000; i++) put(home, `notes/area-${i % 100}/note-${i}.md`, text(i))
    for (let i = 0; i < 2_000; i++) put(home, `org/threads/t-${i}.json`, JSON.stringify({ id: i, body: text(i), cwd: i % 10 === 0 ? `${A}/code/p${i}` : null }))
    put(home, 'session-audit.jsonl', Array.from({ length: 200_000 }, (_, i) => JSON.stringify({ at: i, action: 'turn', session: `s-${i}`, ...(i % 100 === 0 ? { cwd: `${A}/code/p${i}` } : {}) })).join('\n'))
    put(home, 'config.yaml', `stt:\n  whisper_cpp_model: ${A}/models/m.bin\n`)
    const sdb = new Database(path.join(home, 'sessions.sqlite'))
    sdb.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, output_file TEXT, payload TEXT, history TEXT)')
    const ins = sdb.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)')
    sdb.exec('BEGIN')
    for (let i = 0; i < 50_000; i++) ins.run(`s-${i}`, `${A}/code/p${i % 300}`, `/tmp/open-walnut/streams/s-${i}.jsonl`, JSON.stringify({ title: `session ${i}` }), 'x'.repeat(2000))
    sdb.exec('COMMIT')
    sdb.close()
    fs.mkdirSync(path.join(home, 'tasks'), { recursive: true })
    const tdb = new Database(path.join(home, 'tasks', 'tasks.sqlite'))
    tdb.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, payload TEXT)')
    const tins = tdb.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
    tdb.exec('BEGIN')
    for (let i = 0; i < 20_000; i++) tins.run(`t-${i}`, `task ${i}`, 'y'.repeat(500), JSON.stringify({ cwd: i % 2 ? `${A}/code/p${i % 300}` : `${A}/.open-walnut` }))
    tdb.exec('COMMIT')
    tdb.close()
    const roots = pathRoots({ fromHome: `${A}/.open-walnut`, toHome: '/Users/b/.open-walnut', fromAccount: A, toAccount: '/Users/b' })
    const full = scanHomePaths(home, roots)
    const trial = scanHomePaths(home, roots, { skip: keptPlace(homePathRules()) })
    const mb = (n: number) => (n / 1024 / 1024).toFixed(0)
    console.log(`BENCH full scan: ${full.files} files, ${mb(full.bytes)} MB, ${Object.values(full.counts).reduce((a, b) => a + b, 0)} hits, ${Math.round(full.ms)} ms`)
    console.log(`BENCH trial scan (kept places skipped): ${trial.files} files, ${mb(trial.bytes)} MB, ${Object.values(trial.counts).reduce((a, b) => a + b, 0)} hits, ${Math.round(trial.ms)} ms`)
    expect(full.hits.length).toBeGreaterThan(0)
  }, 600_000)
})
