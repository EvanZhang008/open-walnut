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
import { findRoots, judgePathHits, pathRoots, replaceRoots, rewriteHomePaths, scanHomePaths, spliceJson, type PathRoot, type PathRule } from '../../../../src/core/leader/switch/home-paths.js'
import { promptSha256, textRefsColumnOf } from '../../../../src/core/session-prompts.js'
import { refreshPromptStubsIn } from '../../../../src/core/session-db.js'

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
    expect(r.skipped.map((s) => s.file).sort()).toEqual(['big.txt', 'img.png'])
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

describe('a moved path in a session prompt (the prompt split)', () => {
  it('the prompt rows\' hashes, the payload stubs and the row\'s prompt_text_refs follow the new text; a second run changes nothing', () => {
    const home = path.join(root, 'h')
    fs.mkdirSync(home, { recursive: true })
    const was = 'Work in /home/a/code/x, please.'
    const now = 'Work in /Users/b/code/x, please.'
    const bytes = (t: string) => Buffer.byteLength(t)
    const db = new Database(path.join(home, 'sessions.sqlite'))
    db.exec(`CREATE TABLE sessions (claude_session_id TEXT PRIMARY KEY, payload TEXT, prompt_text_refs TEXT);
      CREATE TABLE session_prompts (claude_session_id TEXT NOT NULL, field TEXT NOT NULL, body TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (claude_session_id, field))`)
    const row = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
    const prompt = db.prepare("INSERT INTO session_prompts VALUES (?, ?, ?, ?, 'x')")
    // Release A's row: the texts in the payload, stubs beside them, and their table copies.
    row.run('a', `{"big":12345678901234567890,"appliedAppendSystemPrompt":${JSON.stringify(was)},"appliedAppendSystemPromptRef":{"bytes":${bytes(was)},"inline":true},"profile":{"systemPrompt":${JSON.stringify(was)},"systemPromptRef":{"bytes":${bytes(was)},"blank":false,"inline":true}}}`,
      textRefsColumnOf({ appliedAppendSystemPrompt: was, systemPrompt: was }, true))
    prompt.run('a', 'appliedAppendSystemPrompt', was, promptSha256(was))
    prompt.run('a', 'profile.systemPrompt', was, promptSha256(was))
    // A stripped row: the stub stands for the table's text.
    row.run('b', JSON.stringify({ appliedAppendSystemPromptRef: { sha256: promptSha256(was), bytes: bytes(was) } }), '{}')
    prompt.run('b', 'appliedAppendSystemPrompt', was, promptSha256(was))
    db.close()
    const rules: PathRule[] = [{ id: 's', stores: [], file: 'sessions.sqlite', rule: 'rewrite', why: 't' }]
    expect(rewriteHomePaths(home, rules, { roots: ROOTS, reverseStandbyDir: '/x' }).map((d) => d.file)).toEqual(['sessions.sqlite'])
    const rdb = new Database(path.join(home, 'sessions.sqlite'), { readonly: true })
    const prompts = rdb.prepare('SELECT claude_session_id AS sid, field, body, sha256 FROM session_prompts ORDER BY 1, 2').all()
    const rows = Object.fromEntries((rdb.prepare('SELECT claude_session_id AS sid, payload, prompt_text_refs AS refs FROM sessions').all() as Array<{ sid: string; payload: string; refs: string }>).map((r) => [r.sid, r]))
    rdb.close()
    expect(prompts).toEqual([
      { sid: 'a', field: 'appliedAppendSystemPrompt', body: now, sha256: promptSha256(now) },
      { sid: 'a', field: 'profile.systemPrompt', body: now, sha256: promptSha256(now) },
      { sid: 'b', field: 'appliedAppendSystemPrompt', body: now, sha256: promptSha256(now) },
    ])
    const a = JSON.parse(rows.a!.payload)
    expect([a.appliedAppendSystemPrompt, a.appliedAppendSystemPromptRef, a.profile.systemPrompt, a.profile.systemPromptRef])
      .toEqual([now, { bytes: bytes(now), inline: true }, now, { bytes: bytes(now), blank: false, inline: true }])
    expect(rows.a!.refs).toBe(textRefsColumnOf({ appliedAppendSystemPrompt: now, systemPrompt: now }, true))
    // Only the stub changed: a number past double precision keeps its digits.
    expect(rows.a!.payload).toContain('12345678901234567890')
    expect(JSON.parse(rows.b!.payload).appliedAppendSystemPromptRef).toEqual({ sha256: promptSha256(now), bytes: bytes(now) })
    expect(rows.b!.refs).toBe('{}')
    const file = () => fs.readFileSync(path.join(home, 'sessions.sqlite'))
    const once = file()
    expect(rewriteHomePaths(home, rules, { roots: ROOTS, reverseStandbyDir: '/x' })).toEqual([])
    expect(file()).toEqual(once)
  })
})

describe('refreshPromptStubsIn on one connection', () => {
  it('the first call fixes every stale hash, stub and column; a second call changes nothing', () => {
    const was = 'Work in /home/a/code/x, please.'
    const now = 'Work in /Users/b/code/x, please.'
    const bytes = (t: string) => Buffer.byteLength(t)
    const db = new Database(path.join(root, 'sessions.sqlite'))
    try {
      db.exec(`CREATE TABLE sessions (claude_session_id TEXT PRIMARY KEY, payload TEXT, prompt_text_refs TEXT);
        CREATE TABLE session_prompts (claude_session_id TEXT NOT NULL, field TEXT NOT NULL, body TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (claude_session_id, field))`)
      const row = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      const prompt = db.prepare("INSERT INTO session_prompts VALUES (?, ?, ?, ?, 'x')")
      // The texts are already the new ones; their hashes, stubs and column still say the old ones.
      row.run('a', JSON.stringify({ appliedAppendSystemPrompt: now, appliedAppendSystemPromptRef: { bytes: bytes(was), inline: true } }),
        textRefsColumnOf({ appliedAppendSystemPrompt: was }, false))
      prompt.run('a', 'appliedAppendSystemPrompt', now, promptSha256(was))
      row.run('b', JSON.stringify({ profile: { systemPromptRef: { sha256: promptSha256(was), bytes: bytes(was), blank: false } } }), '{}')
      prompt.run('b', 'profile.systemPrompt', now, promptSha256(was))
      // Untouched: a row whose stubs are right already, and a row with no prompt.
      row.run('c', JSON.stringify({ appliedAppendSystemPrompt: now, appliedAppendSystemPromptRef: { bytes: bytes(now), inline: true } }),
        textRefsColumnOf({ appliedAppendSystemPrompt: now }, false))
      prompt.run('c', 'appliedAppendSystemPrompt', now, promptSha256(now))
      row.run('d', JSON.stringify({ title: 'none' }), '{}')
      const dump = () => JSON.stringify([db.prepare('SELECT * FROM sessions ORDER BY 1').all(), db.prepare('SELECT * FROM session_prompts ORDER BY 1, 2').all()])
      // Two prompt rows' hashes, and rows a and b.
      expect(refreshPromptStubsIn(db)).toBe(4)
      const once = dump()
      expect(JSON.parse(db.prepare("SELECT payload FROM sessions WHERE claude_session_id = 'a'").pluck().get() as string).appliedAppendSystemPromptRef).toEqual({ bytes: bytes(now), inline: true })
      expect(db.prepare("SELECT prompt_text_refs FROM sessions WHERE claude_session_id = 'a'").pluck().get()).toBe(textRefsColumnOf({ appliedAppendSystemPrompt: now }, false))
      expect(JSON.parse(db.prepare("SELECT payload FROM sessions WHERE claude_session_id = 'b'").pluck().get() as string).profile.systemPromptRef)
        .toEqual({ sha256: promptSha256(now), bytes: bytes(now), blank: false })
      expect(db.prepare('SELECT sha256 FROM session_prompts ORDER BY 1').pluck().all()).toEqual([promptSha256(now), promptSha256(now), promptSha256(now)])
      expect(refreshPromptStubsIn(db)).toBe(0)
      expect(dump()).toBe(once)
      // A caller that changed no table with a text: nothing read, nothing changed.
      expect(refreshPromptStubsIn(db, new Set(['tasks']))).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('review round 1: modes, JSON bytes, symlinked homes', () => {
  const all = (roots: PathRoot[]) => Object.assign(() => roots, { all: roots })

  it('a rewritten script keeps its mode (a trigger stays executable)', () => {
    const home = path.join(root, 'h')
    put(home, 'triggers/t/check.sh', '#!/bin/sh\ncat /home/a/.open-walnut/notes/x.md\n')
    fs.chmodSync(path.join(home, 'triggers/t/check.sh'), 0o750)
    rewriteHomePaths(home, [{ id: 'r', stores: [], file: 'triggers/**', rule: 'rewrite', why: 't' }], { roots: ROOTS, reverseStandbyDir: '/x' })
    expect(fs.readFileSync(path.join(home, 'triggers/t/check.sh'), 'utf8')).toContain('/Users/b/.open-walnut/notes/x.md')
    expect(fs.statSync(path.join(home, 'triggers/t/check.sh')).mode & 0o777).toBe(0o750)
  })

  it('a JSON rewrite changes the path strings only: big ids, number spellings, key order, __proto__ and other escapes stay byte for byte', () => {
    const text = '{\n  "z": 12345678901234567890, "n": 1.0, "e": 1E5,\n  "__proto__": {"cwd": "/home/a/code"},\n  "s": "caf\\u00e9 \\/ok", "a": [ "/home/a/.open-walnut/x" , 2 ],\n  "/home/a/key": true\n}\n'
    const r = spliceJson(text, all(ROOTS))!
    expect(r.count).toBe(3)
    expect(r.text).toBe('{\n  "z": 12345678901234567890, "n": 1.0, "e": 1E5,\n  "__proto__": {"cwd": "/Users/b/code"},\n  "s": "caf\\u00e9 \\/ok", "a": [ "/Users/b/.open-walnut/x" , 2 ],\n  "/Users/b/key": true\n}\n')
    expect(spliceJson('{"a": 1,}', all(ROOTS))).toBeNull()
    expect(spliceJson('{"a": 1} x', all(ROOTS))).toBeNull()
    // Through the file rewrite too.
    const home = path.join(root, 'h')
    put(home, 'p.json', text)
    rewriteHomePaths(home, [{ id: 'r', stores: [], file: 'p.json', rule: 'rewrite', why: 't' }], { roots: ROOTS, reverseStandbyDir: '/x' })
    expect(fs.readFileSync(path.join(home, 'p.json'), 'utf8')).toBe(r.text)
  })

  it('a symlinked home: paths saved under its real path are found and moved too', () => {
    const real = path.join(root, 'real-account')
    const link = path.join(root, 'account-link')
    fs.mkdirSync(path.join(real, '.open-walnut'), { recursive: true })
    fs.symlinkSync(real, link)
    const roots = pathRoots({ fromHome: path.join(link, '.open-walnut'), toHome: '/Users/b/.open-walnut', fromAccount: link, toAccount: '/Users/b' })
    const realHome = fs.realpathSync(path.join(real, '.open-walnut'))
    expect(roots.map((r) => r.from)).toEqual(expect.arrayContaining([path.join(link, '.open-walnut'), realHome, link, fs.realpathSync(real)]))
    const home = path.join(root, 'h')
    put(home, 'a.json', JSON.stringify({ given: `${link}/.open-walnut/x`, real: `${realHome}/y`, acct: `${fs.realpathSync(real)}/code` }))
    const hits = scanHomePaths(home, roots).hits.map((h) => [h.at, h.root])
    expect(hits).toEqual(expect.arrayContaining([['given', 'home'], ['real', 'home'], ['acct', 'account']]))
    rewriteHomePaths(home, [{ id: 'r', stores: [], file: 'a.json', rule: 'rewrite', why: 't' }], { roots, reverseStandbyDir: '/x' })
    expect(JSON.parse(fs.readFileSync(path.join(home, 'a.json'), 'utf8'))).toEqual({ given: '/Users/b/.open-walnut/x', real: '/Users/b/.open-walnut/y', acct: '/Users/b/code' })
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
