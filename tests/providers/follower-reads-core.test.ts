/**
 * The owner scope of follower reads (src/providers/follower-reads-core.ts, WP6):
 * the rules both daemon twins inline, on a real temp tree with real realpath.
 * The same scope on real daemon processes is tests/providers/follower-owner-scope-twins.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFollowerReads, type FollowerDecision } from '../../src/providers/follower-reads-core.js'

const A = '/fixture/marina-home'
const B = '/fixture/acme-home'

let base = ''
let journal = ''
let journalReads = 0
let live: Array<{ sid: string; cwd: string }> = []
let slice: Record<string, string> = {}
let journalHomes: Record<string, string> = {}

function make() {
  return createFollowerReads({
    path, homeDir: path.join(base, 'home'),
    realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
    sliceOwner: (sid) => slice[sid], journalOwner: (sid) => journalHomes[sid],
    liveSessions: () => live,
    journalSize: () => (fs.existsSync(journal) ? fs.statSync(journal).size : -1),
    readJournal: () => { journalReads++; return fs.readFileSync(journal, 'utf8') },
    replica: { list: () => null, read: () => null, readMany: () => null },
    log: () => {},
  })
}

const passes = (d: FollowerDecision) => 'pass' in d
const refused = (d: FollowerDecision) => 'refuse' in d

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wfr-')))
  journal = path.join(base, 'spawn-journal.jsonl')
  journalReads = 0
  for (const d of ['work/src', 'work/acme-sub/src', 'shared', 'stopped', 'home']) fs.mkdirSync(path.join(base, d), { recursive: true })
  live = [{ sid: 'sa', cwd: path.join(base, 'work') }, { sid: 'sb', cwd: path.join(base, 'work', 'acme-sub') }, { sid: 'sa2', cwd: path.join(base, 'shared') }, { sid: 'sb2', cwd: path.join(base, 'shared') }]
  slice = { sa: A, sa2: A, sb: B, sb2: B }
  journalHomes = {}
})
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

describe('files: inside the Walnut\'s own session cwds', () => {
  it('the deepest session cwd that holds a path decides whose it is; a cwd both work in is both\'s', () => {
    const r = make()
    const read = (home: string, p: string) => r.gate(home, { cmd: 'fs.read', path: p })
    expect(passes(read(A, path.join(base, 'work', 'src', 'a.ts')))).toBe(true)
    expect(refused(read(A, path.join(base, 'work', 'acme-sub', 'src', 'b.ts')))).toBe(true)
    expect(passes(read(B, path.join(base, 'work', 'acme-sub', 'src', 'b.ts')))).toBe(true)
    expect(refused(read(B, path.join(base, 'work', 'src', 'a.ts')))).toBe(true)
    expect(passes(read(A, path.join(base, 'shared', 'x')))).toBe(true)
    expect(passes(read(B, path.join(base, 'shared', 'x')))).toBe(true)
  })

  it('.., a link out, a relative path, a NUL, ~ and the filesystem root are not inside', () => {
    fs.symlinkSync(path.join(base, 'work', 'acme-sub'), path.join(base, 'work', 'src', 'out'))
    live.push({ sid: 'sroot', cwd: '/' })
    slice.sroot = A
    const r = make()
    const read = (p: string) => r.gate(A, { cmd: 'fs.read', path: p })
    expect(refused(read(path.join(base, 'work', 'src', '..', 'acme-sub', 'b.ts')))).toBe(true)
    expect(refused(read(path.join(base, 'work', 'src', 'out', 'src', 'b.ts')))).toBe(true)
    expect(refused(read('work/src/a.ts'))).toBe(true)
    expect(refused(read(path.join(base, 'work', 'a\u0000b')))).toBe(true)
    expect(refused(read('~/secret'))).toBe(true)
    expect(refused(read('/etc/hosts'))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.ls', path: '/' }))).toBe(true)
    // A stat out of scope looks like a missing file, never like a refusal.
    expect(r.gate(A, { cmd: 'fs.stat', path: '/etc/hosts' })).toEqual({ answer: { exists: false } })
  })

  it('git reads: the cwd and the (absolute) path both inside; a resolvePath and a grep the same', () => {
    const r = make()
    const work = path.join(base, 'work')
    expect(passes(r.gate(A, { cmd: 'git.fileLog', cwd: work, path: path.join(work, 'src', 'a.ts') }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'git.fileShow', cwd: work, path: path.join(work, 'acme-sub', 'src', 'b.ts'), sha: 'a'.repeat(40) }))).toBe(true)
    // The handlers resolve a relative path against the daemon's own cwd, not this
    // one: a relative path is refused even when cwd + path would be inside.
    for (const c of ['git.fileLog', 'git.fileShow']) expect(refused(r.gate(A, { cmd: c, cwd: work, path: 'src/a.ts', sha: 'a'.repeat(40) })), c).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.grep', cwd: work, file: 'src/a.ts', symbol: 'x' }))).toBe(true)
    expect(passes(r.gate(A, { cmd: 'git.diff', cwd: work, base: 'uncommitted' }))).toBe(true)
    // Out of scope, a diff looks like no repository (never a failure the whole changes view would show).
    expect(r.gate(A, { cmd: 'git.diff', cwd: path.join(work, 'acme-sub'), base: 'uncommitted' })).toEqual({ answer: { repoRoot: null, files: [] } })
    expect(passes(r.gate(A, { cmd: 'fs.resolvePath', ref: 'src/a.ts', cwd: work }))).toBe(true)
    expect(passes(r.gate(A, { cmd: 'fs.resolvePath', ref: 'src/a.ts', sessionId: 'sa' }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.resolvePath', ref: 'src/a.ts', sessionId: 'sb' }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.resolvePath', ref: '/etc/hosts', cwd: work }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.resolvePath', ref: 'a.ts' }))).toBe(true)
    expect(passes(r.gate(A, { cmd: 'fs.grep', file: path.join(work, 'src', 'a.ts'), symbol: 'x' }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.grep', file: path.join(work, 'acme-sub', 'src', 'b.ts'), symbol: 'x' }))).toBe(true)
  })
})

describe('sessions: owned by the slice, else by the spawn journal', () => {
  it('a stopped session\'s cwd comes from its first journal line; the journal is read again only when it grows', () => {
    fs.writeFileSync(journal, [
      JSON.stringify({ v: 1, sid: 'sstop', kind: 'new', cwd: path.join(base, 'stopped'), home: A }),
      JSON.stringify({ v: 1, sid: 'sstop', kind: 'resume', cwd: path.join(base, 'work', 'acme-sub'), home: A }),
      '{"v":1,"sid":"torn',
    ].join('\n'))
    journalHomes = { sstop: A }
    const r = make()
    expect(passes(r.gate(A, { cmd: 'fs.read', path: path.join(base, 'stopped', 'notes.txt') }))).toBe(true)
    // Only the first line counts: the second never widens A's scope into B's dir.
    expect(refused(r.gate(A, { cmd: 'fs.read', path: path.join(base, 'work', 'acme-sub', 'x') }))).toBe(true)
    const reads = journalReads
    r.gate(A, { cmd: 'fs.stat', path: path.join(base, 'stopped') })
    expect(journalReads).toBe(reads)
    fs.appendFileSync(journal, '\n' + JSON.stringify({ v: 1, sid: 'snew', cwd: path.join(base, 'home'), home: B }) + '\n')
    journalHomes.snew = B
    expect(passes(r.gate(B, { cmd: 'fs.ls', path: path.join(base, 'home') }))).toBe(true)
    expect(journalReads).toBe(reads + 1)
  })

  it('attach, status, markers, history and changes: own sessions pass (status without its argv), others are not_found', () => {
    journalHomes = { sj: A }
    const r = make()
    for (const c of ['attach', 'status', 'markers.find', 'read-history', 'changes.compute']) {
      expect(passes(r.gate(A, { cmd: c, sid: 'sa' })), c).toBe(true)
      expect(passes(r.gate(A, { cmd: c, sid: 'sj' })), c).toBe(true)
      expect(refused(r.gate(A, { cmd: c, sid: 'sb' })), c).toBe(true)
      expect(refused(r.gate(A, { cmd: c, sid: 'nobody' })), c).toBe(true)
      expect(refused(r.gate(A, { cmd: c })), c).toBe(true)
    }
    const status: Record<string, unknown> = { cmd: 'status', sid: 'sa', includeArgs: true }
    expect(passes(r.gate(A, status))).toBe(true)
    expect(status.includeArgs).toBeUndefined()
    // changes.file answers one file of the owned session's own change list (the
    // session edited it, wherever it lies): the session decides, not the path.
    expect(passes(r.gate(A, { cmd: 'changes.file', sid: 'sa', path: path.join(base, 'elsewhere', 'edited.ts') }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'changes.file', sid: 'sb', path: path.join(base, 'work', 'src', 'a.ts') }))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'changes.compute', sid: 'sa', cwd: path.join(base, 'work', 'acme-sub') }))).toBe(true)
    // The slice wins over the journal: a session another Walnut's copy lists is that Walnut's.
    journalHomes.sb = A
    expect(refused(r.gate(A, { cmd: 'status', sid: 'sb' }))).toBe(true)
  })

  it('list rows: the follower\'s own only; no hello, nothing; other commands are not this gate\'s', () => {
    const r = make()
    const rows = [{ sid: 'sa' }, { sid: 'sb' }, { sid: 'sa2' }, { sid: 'stranger' }]
    expect(r.ownRows(A, rows).map((x) => x.sid)).toEqual(['sa', 'sa2'])
    expect(r.ownRows(null, rows)).toEqual([])
    expect(r.gate(null, { cmd: 'fs.read', path: '/x' })).toEqual({ error: 'fs.read: send follower.hello first' })
    for (const c of ['list', 'ping', 'follower.status', 'stream.open']) expect(passes(r.gate(A, { cmd: c }))).toBe(true)
  })
})

describe('a session\'s own transcript and stream files', () => {
  it('are its Walnut\'s wherever the CLI keeps them; another session\'s, or anything else there, is not', () => {
    const projects = path.join(base, 'claude', 'projects')
    const streams = path.join(base, 'streams')
    for (const d of [path.join(projects, '-x-work', 'sa', 'subagents'), streams]) fs.mkdirSync(d, { recursive: true })
    const r = createFollowerReads({
      path, homeDir: path.join(base, 'home'), claudeProjectsDirs: [projects], streamsDir: streams,
      realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
      sliceOwner: (sid) => slice[sid], journalOwner: () => undefined, liveSessions: () => live,
      journalSize: () => -1, readJournal: () => '', replica: { list: () => null, read: () => null, readMany: () => null }, log: () => {},
    })
    const read = (home: string, p: string) => r.gate(home, { cmd: 'fs.read', path: p })
    expect(passes(read(A, path.join(projects, '-x-work', 'sa.jsonl')))).toBe(true)
    expect(passes(read(A, path.join(projects, '-any-other-encoding', 'sa.jsonl')))).toBe(true)
    expect(passes(read(A, path.join(projects, '-x-work', 'sa', 'subagents', 'agent-1.jsonl')))).toBe(true)
    expect(passes(r.gate(A, { cmd: 'fs.ls', path: path.join(projects, '-x-work', 'sa', 'subagents') }))).toBe(true)
    expect(passes(read(A, path.join(streams, 'sa.jsonl')))).toBe(true)
    expect(refused(read(A, path.join(projects, '-x-work', 'sb.jsonl')))).toBe(true)
    expect(refused(read(A, path.join(streams, 'sb.jsonl')))).toBe(true)
    expect(refused(read(A, path.join(streams, 'sa.pipe')))).toBe(true)
    expect(refused(read(A, path.join(projects, '-x-work', 'memory.md')))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.ls', path: projects }))).toBe(true)
    expect(passes(read(B, path.join(projects, '-x-work', 'sb.jsonl')))).toBe(true)
  })
})

describe('a session cwd at or above home (WP6 fix round)', () => {
  it('never opens the CLI config dirs, the daemon dirs or another Walnut\'s data dir; a deeper session cwd still decides', () => {
    const home = path.join(base, 'home')
    const claude = path.join(home, '.claude')
    const projects = path.join(claude, 'projects')
    const daemonDir = path.join(base, 'daemon')
    const replicaDir = path.join(daemonDir, 'host-replica')
    const otherData = path.join(home, '.open-walnut-host', 'acme', 'data')
    for (const d of [path.join(projects, '-w'), path.join(replicaDir, 'k', 'notes'), otherData, path.join(claude, 'skills', 'tool'), path.join(home, 'code')]) fs.mkdirSync(d, { recursive: true })
    live = [{ sid: 'sa', cwd: home }, { sid: 'sa3', cwd: path.join(claude, 'skills', 'tool') }, { sid: 'sb', cwd: path.join(base, 'work') }]
    slice = { sa: A, sa3: A, sb: B }
    const r = createFollowerReads({
      path, homeDir: home, claudeProjectsDirs: [projects], streamsDir: path.join(daemonDir, 'streams'),
      realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
      sliceOwner: (sid) => slice[sid], journalOwner: () => undefined, liveSessions: () => live,
      journalSize: () => -1, readJournal: () => '', replica: { list: () => null, read: () => null, readMany: () => null },
      denyRoots: () => [claude, daemonDir, replicaDir, otherData, path.join(home, '.open-walnut')],
      log: () => {},
    })
    const read = (p: string) => r.gate(A, { cmd: 'fs.read', path: p })
    // Under A's home-dir cwd: ordinary files are A's ...
    expect(passes(read(path.join(home, 'code', 'a.ts')))).toBe(true)
    // ... but B's transcript, the CLI's prompt history, the daemon's notes copy and B's data dir are not.
    expect(refused(read(path.join(projects, '-w', 'sb.jsonl')))).toBe(true)
    expect(refused(read(path.join(claude, 'history.jsonl')))).toBe(true)
    expect(refused(read(path.join(replicaDir, 'k', 'notes', 'body')))).toBe(true)
    expect(refused(read(path.join(otherData, 'tasks.json')))).toBe(true)
    expect(refused(read(path.join(home, '.open-walnut', 'config.yaml')))).toBe(true)
    expect(refused(r.gate(A, { cmd: 'fs.ls', path: claude }))).toBe(true)
    // A's own transcript is still A's, and a session cwd deeper than a deny root decides below it.
    expect(passes(read(path.join(projects, '-w', 'sa.jsonl')))).toBe(true)
    expect(passes(read(path.join(claude, 'skills', 'tool', 'SKILL.md')))).toBe(true)
    // A session cwd that IS a deny root does not claim it.
    live.push({ sid: 'sa4', cwd: claude })
    slice.sa4 = A
    expect(refused(read(path.join(claude, 'history.jsonl')))).toBe(true)
  })
})

describe('answers for a whole repository are cut to the Walnut\'s scope (WP6 fix round)', () => {
  const cut = (r: ReturnType<typeof make>, d: FollowerDecision, answer: Record<string, unknown>) => {
    expect(passes(d)).toBe(true)
    const sock = {}
    if ('pass' in d && d.scope) r.hold(sock, 7, d.scope)
    return r.settle(sock, 7, answer)
  }

  it('git.diff keeps A\'s files only (a rename counts from both ends); fs.grep keeps A\'s matches only', () => {
    const r = make()
    const work = path.join(base, 'work')
    const diff = cut(r, r.gate(A, { cmd: 'git.diff', cwd: work, base: 'uncommitted' }), {
      repoRoot: base,
      files: [
        { relPath: 'work/src/a.ts', before: '', after: 'a', status: 'added' },
        { relPath: 'work/acme-sub/src/b.ts', before: 'b0', after: 'b1', status: 'modified' },
        { relPath: 'work/src/moved.ts', oldRelPath: 'work/acme-sub/src/old.ts', before: 'b', after: 'b', status: 'renamed' },
        { relPath: 'shared/x', before: '', after: 'x', status: 'added' },
      ],
    })
    expect((diff!.files as Array<{ relPath: string }>).map((f) => f.relPath)).toEqual(['work/src/a.ts', 'shared/x'])
    expect(diff!.repoRoot).toBe(base)
    const grep = cut(r, r.gate(A, { cmd: 'fs.grep', file: path.join(work, 'src', 'a.ts'), symbol: 'x' }), {
      root: base, tool: 'git-grep', truncated: false,
      matches: [{ file: path.join(work, 'src', 'a.ts'), line: 1, text: 'x', kind: 'def' }, { file: path.join(work, 'acme-sub', 'src', 'b.ts'), line: 2, text: 'x', kind: 'ref' }],
    })
    expect((grep!.matches as Array<{ file: string }>).map((m) => m.file)).toEqual([path.join(work, 'src', 'a.ts')])
  })

  it('a resolvePath hit under B\'s cwd falls back to A\'s cwd; fs.find finds A\'s own transcript only', () => {
    const r = make()
    const work = path.join(base, 'work')
    const res = cut(r, r.gate(A, { cmd: 'fs.resolvePath', ref: 'b.ts', cwd: work }), {
      path: path.join(work, 'acme-sub', 'src', 'b.ts'), resolved: true, via: 'git', alternatives: [path.join(work, 'src', 'b.ts'), path.join(work, 'acme-sub', 'b.ts')],
    })
    expect(res).toMatchObject({ path: work, resolved: false, degraded: true, alternatives: [path.join(work, 'src', 'b.ts')] })
    const projects = path.join(base, 'claude', 'projects')
    fs.mkdirSync(path.join(projects, '-x'), { recursive: true })
    const rf = createFollowerReads({
      path, homeDir: path.join(base, 'home'), claudeProjectsDirs: [projects],
      realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
      sliceOwner: (sid) => slice[sid], journalOwner: () => undefined, liveSessions: () => live,
      journalSize: () => -1, readJournal: () => '', replica: { list: () => null, read: () => null, readMany: () => null }, log: () => {},
    })
    expect(refused(rf.gate(A, { cmd: 'fs.find', path: projects, name: 'sb.jsonl' }))).toBe(true)
    expect(refused(rf.gate(A, { cmd: 'fs.find', path: '/', name: 'sa.jsonl' }))).toBe(true)
    expect(refused(rf.gate(A, { cmd: 'fs.find', path: projects, name: '.jsonl' }))).toBe(true)
    const d = rf.gate(A, { cmd: 'fs.find', path: projects, name: 'sa.jsonl', maxDepth: 3 })
    expect(passes(d)).toBe(true)
    const sock = {}
    if ('pass' in d && d.scope) rf.hold(sock, 1, d.scope)
    expect(rf.settle(sock, 1, { files: [path.join(projects, '-x', 'sa.jsonl'), path.join(projects, '-x', 'sb.jsonl')] })).toEqual({ files: [path.join(projects, '-x', 'sa.jsonl')] })
  })

  it('settle: no scope leaves the answer as it is; an error answer only lets the scope go', () => {
    const r = make()
    const sock = {}
    expect(r.settle(sock, 1, { ok: 1 })).toEqual({ ok: 1 })
    r.hold(sock, 2, () => ({ cut: true }))
    expect(r.settle(sock, 2)).toBeUndefined()
    expect(r.settle(sock, 2, { files: ['x'] })).toEqual({ files: ['x'] })
    r.hold(sock, 3, () => { throw new Error('bad') })
    expect(r.settle(sock, 3, { files: ['x'] })).toEqual({})
  })
})

describe('the roots and owners are looked up once per generation (WP6 fix round)', () => {
  it('many reads scan the slices once; a session that starts is seen at once, a slice change within the TTL', () => {
    let t = 1_000_000
    let sliceCalls = 0
    const r = createFollowerReads({
      path, homeDir: path.join(base, 'home'),
      realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
      sliceOwner: (sid) => { sliceCalls++; return slice[sid] }, journalOwner: () => undefined, liveSessions: () => live,
      journalSize: () => -1, readJournal: () => '', replica: { list: () => null, read: () => null, readMany: () => null },
      now: () => t, log: () => {},
    })
    const file = path.join(base, 'work', 'src', 'a.ts')
    expect(passes(r.gate(A, { cmd: 'fs.read', path: file }))).toBe(true)
    const first = sliceCalls
    for (let i = 0; i < 200; i++) r.gate(A, { cmd: 'fs.readRange', path: file, offset: i })
    r.ownRows(A, [{ sid: 'sa' }, { sid: 'sb' }])
    expect(sliceCalls).toBe(first)
    // A session that starts (the live set moves): its cwd counts at the next read.
    fs.mkdirSync(path.join(base, 'fresh'), { recursive: true })
    live.push({ sid: 'sfresh', cwd: path.join(base, 'fresh') })
    slice.sfresh = A
    expect(passes(r.gate(A, { cmd: 'fs.read', path: path.join(base, 'fresh', 'x') }))).toBe(true)
    // A slice the Mac pushed (nothing live moved): seen once the TTL passed.
    slice.sa = B
    t += 1_500
    expect(refused(r.gate(A, { cmd: 'fs.read', path: file }))).toBe(true)
  })
})

describe('the copy of the notes\' pictures (attachment-copy-v1)', () => {
  it('answers the follower\'s own Walnut\'s copy, whatever home the frame names; a file not there is not_found', () => {
    const asked: Array<[string, string]> = []
    const r = createFollowerReads({
      path, homeDir: path.join(base, 'home'), realpath: () => null, sliceOwner: () => undefined, journalOwner: () => undefined,
      liveSessions: () => [], journalSize: () => -1, readJournal: () => '',
      replica: { list: () => null, read: () => null, readMany: () => null },
      attachments: {
        list: (home, after, maxBytes) => { asked.push(['list', home]); expect(maxBytes).toBeLessThanOrEqual(r.MAX_ANSWER_BYTES / 2); return { keys: home === A ? ['a/pic.png'] : [], asOf: '2026-10-22T00:00:00.000Z', next: after ? null : null } },
        readChunk: (home, key, offset, maxBytes) => {
          asked.push(['read', home])
          // One 2 MB slice at most: its base64 stays under the answer cap.
          expect(maxBytes * 4 / 3).toBeLessThan(r.MAX_ANSWER_BYTES)
          return home === A && key === 'a/pic.png' ? { k: 'a/pic.png', h: 'f'.repeat(64), n: 3, offset: Number(offset) || 0, data: 'AAAA' } : null
        },
      },
      log: () => {},
    })
    expect(r.COMMANDS).toEqual(expect.arrayContaining(['attachments.list', 'attachments.read']))
    expect(r.gate(A, { cmd: 'attachments.list', home: B })).toEqual({ answer: { keys: ['a/pic.png'], asOf: '2026-10-22T00:00:00.000Z', next: null } })
    expect(r.gate(A, { cmd: 'attachments.read', key: 'a/pic.png', offset: 0, home: B })).toMatchObject({ answer: { k: 'a/pic.png', n: 3, data: 'AAAA' } })
    expect(refused(r.gate(B, { cmd: 'attachments.read', key: 'a/pic.png' }))).toBe(true)
    expect(asked.every(([, home]) => home === A || home === B)).toBe(true)
    expect(asked.filter(([, home]) => home === B)).toEqual([['read', B]])
    expect(r.gate(null, { cmd: 'attachments.list' })).toEqual({ error: 'attachments.list: send follower.hello first' })
  })

  it('a daemon without the copy answers an error, never another Walnut\'s data', () => {
    const r = make()
    expect(r.gate(A, { cmd: 'attachments.list' })).toEqual({ error: 'attachments.list: this host keeps no copy of the attachments' })
    expect(r.gate(A, { cmd: 'attachments.read', key: 'a/pic.png' })).toEqual({ error: 'attachments.read: this host keeps no copy of the attachments' })
  })
})
