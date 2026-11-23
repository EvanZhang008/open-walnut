/**
 * The absolute paths a promoted home still holds of the machine it came from
 * (docs/reference/leader-switch.md, "Paths"). A home moved to another machine, another OS or
 * another account keeps every path its stores wrote: the old home (`/home/old/.open-walnut/...`)
 * and the old account's home (`/home/old/...`). This module finds them and rewrites them:
 *
 *   - scanHomePaths(): every file of the home, bounded (a size cap per file, binaries skipped):
 *     config and YAML by key, JSON by key path, JSON lines by line and key path, SQLite by
 *     table.column and row (JSON in a column by its key path too), other text by line;
 *   - judgePathHits(): each hit against the rule table (home-path-rules.ts): rewritten by the
 *     promotion, or kept with the reason it must not change, or neither (the trial fails);
 *   - rewriteHomePaths(): the promotion's rewrite of every place a `rewrite` rule names.
 *
 * A path is a root followed by a separator or the end of the path: `/home/a` is not in
 * `/home/ab/x`, and a root preceded by a path character (`/x/home/a`) is not one either.
 * Windows-style roots (`C:\Users\a`) match with either separator after them; a rewrite to a
 * root of the other style turns the rest of that path's separators too.
 *
 * The switch command runs it, never the server: synchronous reads are fine here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import YAML from 'yaml'
import Database, { type Database as DatabaseType } from '../../../lib/sqlite.js'
import { homePathClass, isUnnamedHomePath, originalOfCopy } from '../../home-manifest/index.js'

export type RootKind = 'home' | 'account'

/** One prefix of the old machine and what it becomes on the new one. */
export interface PathRoot { kind: RootKind; from: string; to: string }

export interface PathHit {
  /** Home-relative, '/'-separated. */
  file: string
  /**
   * Where in the file: a key path (`a.b[].c`, `{key}` for a hit in an object's key), a SQLite
   * `table.column` (`table.column:key.path` when the column holds JSON), '' for plain text.
   */
  at: string
  line?: number
  row?: number | string
  /** The path as found (the root and what follows it, up to the end of the path). */
  path: string
  root: RootKind
}

export interface ScanOptions {
  /** A file larger than this is not read (listed in `skipped`). Default 16 MB. */
  maxFileBytes?: number
  /** A database larger than this is not read. Default 4 GB. */
  maxDbBytes?: number
  /** Hits kept per (file, at); the rest are only counted. Default 20. */
  hitsPerPlace?: number
  /**
   * Skip whole files and SQLite columns a `keep` rule covers (the trial's self-check: what is
   * kept does not have to be read). The ratchet reads everything.
   */
  skip?: (file: string, at?: string) => boolean
}

export interface ScanResult {
  hits: PathHit[]
  /** Hits per `file\tat`, those past hitsPerPlace included. */
  counts: Record<string, number>
  skipped: { file: string; why: string }[]
  files: number
  bytes: number
  ms: number
}

// ---- roots and matching ----------------------------------------------------------------------

const isWindowsStyle = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || (p.includes('\\') && !p.includes('/'))

function trimRoot(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  return t || p
}

/** `p` with its symlinks resolved, when it exists on this machine (else null). */
function realOf(p: string): string | null {
  try { return trimRoot(fs.realpathSync.native(p)) } catch { return null }
}

/**
 * The roots of a move: the old home and the old account home, each with what it becomes. A
 * root that does not change, or is not known, is left out. A root that is a symlink (or lies
 * under one: `/home/u` -> `/local/home/u`, macOS `/var` -> `/private/var`) is also matched by
 * its real path, which is what a store that resolved it saved. Resolved on the machine that runs
 * this, so it holds for a home on this machine (today's switch runs both sides here).
 */
export function pathRoots(o: { fromHome: string; toHome: string; fromAccount?: string; toAccount?: string }): PathRoot[] {
  const roots: PathRoot[] = []
  const add = (kind: RootKind, from?: string, to?: string) => {
    if (!from || !to) return
    const f = trimRoot(isWindowsStyle(from) ? from : path.resolve(from))
    const t = trimRoot(isWindowsStyle(to) ? to : path.resolve(to))
    if (f === t || f.length <= 1) return
    roots.push({ kind, from: f, to: t })
    const real = isWindowsStyle(f) ? null : realOf(f)
    if (real && real !== f && real !== t && real !== realOf(t) && !roots.some((r) => r.from === real)) roots.push({ kind, from: real, to: t })
  }
  add('home', o.fromHome, o.toHome)
  add('account', o.fromAccount, o.toAccount)
  return roots
}

// A character that continues a path's name: a root followed by one is only a prefix of another name.
const NAME_CHAR = /[\p{L}\p{N}\p{M}._~@+$%#-]/u
// What ends a path inside running text.
const TEXT_END = /[\s"'`<>|()[\]{},;*?]/

interface Match { index: number; root: PathRoot; end: number }

function boundaryAfter(s: string, i: number): boolean {
  if (i >= s.length) return true
  const c = s[i]!
  return c === '/' || c === '\\' || !NAME_CHAR.test(c)
}

function boundaryBefore(s: string, i: number): boolean {
  if (i === 0) return true
  const c = s[i - 1]!
  if (c === '/' || c === '\\') return s.slice(Math.max(0, i - 7), i).toLowerCase() === 'file://'
  return !NAME_CHAR.test(c)
}

/** The end of the path that starts at `i`: a whole value's line, or up to the next separator of text. */
function pathEnd(s: string, i: number): number {
  let j = i
  if (i === 0) { while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++; return j }
  while (j < s.length && !TEXT_END.test(s[j]!)) j++
  return j
}

/** Every root occurrence in `s`, the longest root winning at a place, a new path (a `to` that lies under a `from`) skipped. */
export function findRoots(s: string, roots: readonly PathRoot[]): Match[] {
  if (!roots.length || s.length < 2) return []
  const sorted = [...roots].sort((a, b) => b.from.length - a.from.length)
  const taken = new Map<number, Match>()
  for (const root of sorted) {
    for (let i = s.indexOf(root.from); i >= 0; i = s.indexOf(root.from, i + 1)) {
      if (taken.has(i)) continue
      if (!boundaryBefore(s, i) || !boundaryAfter(s, i + root.from.length)) continue
      // Already the new place: a `to` under this `from` starts here.
      if (sorted.some((r) => r.to.length > root.from.length && s.startsWith(r.to, i) && boundaryAfter(s, i + r.to.length))) continue
      taken.set(i, { index: i, root, end: pathEnd(s, i) })
    }
  }
  return [...taken.values()].sort((a, b) => a.index - b.index)
}

/**
 * `s` with every root occurrence moved to its new place; with `only`, just the occurrences of
 * those roots (the match itself is made against all of them: a path in the home is the home's).
 */
export function replaceRoots(s: string, roots: readonly PathRoot[], only?: readonly PathRoot[]): string {
  const found = findRoots(s, roots)
  if (!found.length) return s
  let out = ''
  let at = 0
  for (let i = 0; i < found.length; i++) {
    const m = found[i]!
    if (only && !only.includes(m.root)) continue
    const end = Math.min(m.end, found[i + 1]?.index ?? Infinity)
    out += s.slice(at, m.index) + m.root.to
    let tail = s.slice(m.index + m.root.from.length, end)
    const fromWin = isWindowsStyle(m.root.from)
    const toWin = isWindowsStyle(m.root.to)
    if (fromWin && !toWin) tail = tail.replace(/\\/g, '/')
    else if (!fromWin && toWin) tail = tail.replace(/\//g, '\\')
    out += tail
    at = end
  }
  return out + s.slice(at)
}

// ---- structured values -----------------------------------------------------------------------

// A field name; anything else (an id, a path, a name with digits) is one of many keys: `*`.
const PLAIN_KEY = /^[A-Za-z_$][A-Za-z_$-]*$/

function child(at: string, key: string): string {
  const k = PLAIN_KEY.test(key) ? key : '*'
  return at ? `${at}.${k}` : k
}

/** Every string (and object key) of a parsed value that holds a root, with its key path. */
function walkValue(v: unknown, at: string, roots: readonly PathRoot[], hit: (at: string, s: string, m: Match) => void): void {
  if (typeof v === 'string') { for (const m of findRoots(v, roots)) hit(at, v, m); return }
  if (Array.isArray(v)) { for (const x of v) walkValue(x, `${at}[]`, roots, hit); return }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      for (const m of findRoots(k, roots)) hit(at ? `${at}.{key}` : '{key}', k, m)
      walkValue(x, child(at, k), roots, hit)
    }
  }
}

/** The roots to move at a place (`under`: at it or anywhere under it); `all` is every root of the move. */
interface RootsAt { (at: string, under?: boolean): readonly PathRoot[]; all: readonly PathRoot[] }

/**
 * `text` (JSON) with the roots moved inside the string tokens whose place has roots to move, and
 * nothing else touched: numbers, key order, spacing and the escapes of every other string stay
 * byte for byte (a re-serialized value would lose an id above 2^53, a `__proto__` key, or one of
 * two keys that become the same). A changed string is written again as JSON.stringify writes it.
 * Null when `text` is not one JSON value.
 */
export function spliceJson(text: string, rootsAt: RootsAt): { text: string; count: number } | null {
  const edits: { start: number; end: number; token: string }[] = []
  let i = 0
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++ }
  const fail = (): never => { throw new SyntaxError('not JSON') }
  const str = (at: string): string => {
    if (text[i] !== '"') fail()
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (i >= text.length) fail()
    const end = ++i
    const value = JSON.parse(text.slice(start, end)) as string
    const roots = rootsAt(at)
    if (roots.length) {
      const next = replaceRoots(value, rootsAt.all, roots)
      if (next !== value) edits.push({ start, end, token: JSON.stringify(next) })
    }
    return value
  }
  const value = (at: string): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++; ws()
      if (text[i] === '}') { i++; return }
      for (;;) {
        ws()
        const key = str(at ? `${at}.{key}` : '{key}')
        ws(); if (text[i++] !== ':') fail()
        value(child(at, key))
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i++] !== '}') fail()
        return
      }
    }
    if (c === '[') {
      i++; ws()
      if (text[i] === ']') { i++; return }
      for (;;) {
        value(`${at}[]`)
        ws()
        if (text[i] === ',') { i++; continue }
        if (text[i++] !== ']') fail()
        return
      }
    }
    if (c === '"') { str(at); return }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 400))
    if (!m) fail()
    i += m![0].length
  }
  try {
    value('')
    ws()
    if (i !== text.length) return null
  } catch { return null }
  let out = text
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.token + out.slice(e.end)
  return { text: out, count: edits.length }
}

const looksJson = (s: string) => /^\s*[[{]/.test(s)

function tryJson(s: string): { ok: true; v: unknown } | { ok: false } {
  try { return { ok: true, v: JSON.parse(s) } } catch { return { ok: false } }
}

// ---- files -----------------------------------------------------------------------------------

type FileKind = 'sqlite' | 'json' | 'jsonl' | 'yaml' | 'text'

const SQLITE_MAGIC = 'SQLite format 3\u0000'
const SQLITE_SIBLING = /-(wal|shm|journal)$/

function kindOf(file: string, head: Buffer): FileKind | 'binary' {
  if (head.subarray(0, 16).toString('latin1') === SQLITE_MAGIC) return 'sqlite'
  if (head.includes(0)) return 'binary'
  const ext = path.extname(originalOfCopy(file)).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  return 'text'
}

function readHead(abs: string): Buffer {
  const fd = fs.openSync(abs, 'r')
  try {
    const b = Buffer.alloc(4096)
    const n = fs.readSync(fd, b, 0, b.length, 0)
    return b.subarray(0, n)
  } finally { fs.closeSync(fd) }
}

/** Every regular file of the home, home-relative and '/'-separated (symlinks are not followed). */
function listFiles(home: string): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = []
  const walk = (rel: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(path.join(home, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) {
        let size = 0
        try { size = fs.statSync(path.join(home, r)).size } catch { continue }
        out.push({ rel: r, size })
      }
    }
  }
  walk('')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

const quote = (id: string) => `"${id.replace(/"/g, '""')}"`

/** The forms a root takes inside SQLite text: as is, JSON-escaped, and with non-ASCII as \u escapes. */
function sqlNeedles(roots: readonly PathRoot[]): string[] {
  const set = new Set<string>()
  for (const r of roots) {
    set.add(r.from)
    set.add(JSON.stringify(r.from).slice(1, -1))
    set.add(r.from.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
    set.add(r.from.replace(/\//g, '\\/'))
  }
  return [...set]
}

interface Column { table: string; column: string; rowid: boolean }

function textColumns(db: DatabaseType): { columns: Column[]; skipped: string[] } {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string | null }[]
  const virtual = tables.filter((t) => /^\s*CREATE\s+VIRTUAL/i.test(t.sql ?? '')).map((t) => t.name)
  const columns: Column[] = []
  const skipped: string[] = []
  for (const t of tables) {
    // A full-text index and its shadow tables: derived from the tables they index.
    if (virtual.includes(t.name) || virtual.some((v) => t.name.startsWith(`${v}_`))) { skipped.push(t.name); continue }
    const rowid = !/WITHOUT\s+ROWID/i.test(t.sql ?? '')
    for (const c of db.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as { name: string; type: string }[]) {
      if (/^(INTEGER|INT|REAL|BLOB|NUMERIC|BOOLEAN)$/i.test(c.type ?? '')) continue
      columns.push({ table: t.name, column: c.name, rowid })
    }
  }
  return { columns, skipped }
}

function columnRows(db: DatabaseType, c: Column, needles: string[]): Iterable<{ r?: number | string; v: string }> {
  const where = needles.map(() => `instr(${quote(c.column)}, ?) > 0`).join(' OR ')
  const sql = `SELECT ${c.rowid ? 'rowid AS r, ' : ''}${quote(c.column)} AS v FROM ${quote(c.table)} WHERE typeof(${quote(c.column)}) = 'text' AND (${where})`
  return db.prepare(sql).iterate(...needles) as Iterable<{ r?: number | string; v: string }>
}

/** Every absolute path of the old machine the home holds (see the header). */
export function scanHomePaths(home: string, roots: readonly PathRoot[], opts: ScanOptions = {}): ScanResult {
  const t0 = performance.now()
  const maxFile = opts.maxFileBytes ?? 16 * 1024 * 1024
  const maxDb = opts.maxDbBytes ?? 4 * 1024 * 1024 * 1024
  const perPlace = opts.hitsPerPlace ?? 20
  const res: ScanResult = { hits: [], counts: {}, skipped: [], files: 0, bytes: 0, ms: 0 }
  if (!roots.length) { res.ms = performance.now() - t0; return res }
  const add = (h: PathHit) => {
    const k = `${h.file}\t${h.at}`
    const n = (res.counts[k] = (res.counts[k] ?? 0) + 1)
    if (n <= perPlace) res.hits.push(h)
  }
  const fromMatch = (file: string, at: string, s: string, m: Match, extra: Partial<PathHit> = {}) =>
    add({ file, at, ...extra, path: s.slice(m.index, m.end), root: m.root.kind })
  const needles = sqlNeedles(roots)
  for (const { rel, size } of listFiles(home)) {
    if (SQLITE_SIBLING.test(rel)) continue // read through its database
    if (opts.skip?.(rel)) continue
    let head: Buffer
    try { head = readHead(path.join(home, rel)) } catch (err) { res.skipped.push({ file: rel, why: (err as Error).message }); continue }
    const kind = kindOf(rel, head)
    if (kind === 'binary') { res.skipped.push({ file: rel, why: 'binary (a NUL byte in its first 4 KB)' }); continue }
    if (size > (kind === 'sqlite' ? maxDb : maxFile)) { res.skipped.push({ file: rel, why: `${size} bytes, over the ${kind === 'sqlite' ? 'database' : 'file'} cap` }); continue }
    res.files++
    res.bytes += size
    if (kind === 'sqlite') { scanDb(home, rel, roots, needles, opts, res, fromMatch); continue }
    const text = fs.readFileSync(path.join(home, rel), 'utf8')
    if (kind === 'json') {
      const j = tryJson(text)
      if (j.ok) { walkValue(j.v, '', roots, (at, s, m) => fromMatch(rel, at, s, m)); continue }
    }
    if (kind === 'yaml') {
      let v: unknown
      let ok = true
      try { v = YAML.parse(text) } catch { ok = false }
      if (ok) { walkValue(v, '', roots, (at, s, m) => fromMatch(rel, at, s, m)); continue }
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!roots.some((r) => line.includes(r.from) || line.includes(JSON.stringify(r.from).slice(1, -1)))) continue
      const j = kind === 'jsonl' || looksJson(line) ? tryJson(line) : { ok: false as const }
      if (j.ok) walkValue(j.v, '', roots, (at, s, m) => fromMatch(rel, at, s, m, { line: i + 1 }))
      else for (const m of findRoots(line, roots)) fromMatch(rel, '', line, m, { line: i + 1 })
    }
  }
  res.ms = performance.now() - t0
  return res
}

function scanDb(home: string, rel: string, roots: readonly PathRoot[], needles: string[], opts: ScanOptions, res: ScanResult,
  fromMatch: (file: string, at: string, s: string, m: Match, extra?: Partial<PathHit>) => void): void {
  let db: DatabaseType
  try { db = new Database(path.join(home, rel), { readonly: true }) } catch (err) { res.skipped.push({ file: rel, why: `not opened: ${(err as Error).message}` }); return }
  try {
    const { columns } = textColumns(db)
    for (const c of columns) {
      const at = `${c.table}.${c.column}`
      if (opts.skip?.(rel, at)) continue
      for (const { r, v } of columnRows(db, c, needles)) {
        const extra: Partial<PathHit> = r === undefined ? {} : { row: r }
        const j = looksJson(v) ? tryJson(v) : { ok: false as const }
        if (j.ok) walkValue(j.v, '', roots, (k, s, m) => fromMatch(rel, k ? `${at}:${k}` : at, s, m, extra))
        else for (const m of findRoots(v, roots)) fromMatch(rel, at, v, m, extra)
      }
    }
  } catch (err) {
    res.skipped.push({ file: rel, why: `not read: ${(err as Error).message}` })
  } finally {
    db.close()
  }
}

// ---- rules -----------------------------------------------------------------------------------

/**
 * One kind of place a home holds an old-machine path in. `file` and `at` are globs: `*` one
 * name (of a path, or of a key path), `**` any number; an `at` covers its place and everything
 * under it (`a.b` covers `a.b.c` and `a.b[]`, `t.c` covers `t.c:k`). No `at`: the whole file.
 */
export interface PathRule {
  id: string
  /** The manifest entries (src/core/home-manifest/) this rule decides for (the ratchet's coverage). */
  stores: readonly string[]
  file: string | readonly string[]
  at?: string | readonly string[]
  /** Only paths under this root (default: both). */
  root?: RootKind
  /**
   * - `rewrite`: the promotion moves it to the new home or the new account home;
   * - `keep`: it must not change (machine data of another machine, a record, the user's text).
   */
  rule: 'rewrite' | 'keep'
  why: string
  /**
   * A rewrite that sets a value of its own (standby.dir: the old machine's standby folder),
   * not the generic move of the roots. Returns how many values it changed.
   */
  apply?: (home: string, ctx: RewriteContext) => number
  /** The value a custom rewrite sets names the old machine on purpose: a hit after it is expected. */
  remains?: true
}

export interface RewriteContext {
  roots: readonly PathRoot[]
  /** Where the new leader's standby batches go: the old machine's standby folder. */
  reverseStandbyDir: string
  /** The host that folder is on (the old machine, as this config names it), when the copy came over a daemon link. */
  reverseStandbyHost?: string
}

function globRe(glob: string, sep: string, subtree: boolean): RegExp {
  const one = sep === '/' ? '[^/]*' : '[^.\\[\\]:]+'
  const body = glob.split(/(\*\*|\*)/).map((p) => (p === '**' ? '.*' : p === '*' ? one : p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(subtree ? `^${body}(?:$|[.\\[:])` : `^${body}$`)
}

const reCache = new Map<string, RegExp>()
function cached(key: string, make: () => RegExp): RegExp {
  let re = reCache.get(key)
  if (!re) { re = make(); reCache.set(key, re) }
  return re
}

const list = (x: string | readonly string[]) => (typeof x === 'string' ? [x] : x)

/** A copy beside a store (`config.yaml.bak`, a write temp) is decided like the store, as the manifest classes it. */
export function ruleCoversFile(rule: PathRule, file: string): boolean {
  const original = originalOfCopy(file)
  return list(rule.file).some((g) => {
    const re = cached(`f\0${g}`, () => globRe(g, '/', false))
    return re.test(file) || re.test(original)
  })
}

export function ruleCoversAt(rule: PathRule, at: string): boolean {
  if (rule.at === undefined) return true
  return list(rule.at).some((g) => cached(`a\0${g}`, () => globRe(g, '.', true)).test(at))
}

/** Whether the rule names a place inside a SQLite column's JSON (`table.column:...`). */
function ruleUnderColumn(rule: PathRule, column: string): boolean {
  return rule.at !== undefined && list(rule.at).some((g) => g.startsWith(`${column}:`))
}

/** The rule that decides a place: the first that covers it (rules are in order, specific first). */
export function ruleFor(rules: readonly PathRule[], h: Pick<PathHit, 'file' | 'at' | 'root'>): PathRule | undefined {
  return rules.find((r) => ruleCovers(r, h))
}

export function ruleCovers(rule: PathRule, h: Pick<PathHit, 'file' | 'at' | 'root'>): boolean {
  return (!rule.root || rule.root === h.root) && ruleCoversFile(rule, h.file) && ruleCoversAt(rule, h.at)
}

/** Rules every home has, from the manifest: what never travels, and files Walnut does not write. */
export const MANIFEST_RULES = {
  machine: 'the manifest marks it machine or rebuildable: it is never in a batch, so it does not travel',
  userFile: 'no store of Walnut: the user\'s own file in the vault, and Walnut follows no path in it',
} as const

export interface PathJudgement {
  /** Kept on purpose, with the rule's id. */
  kept: { hit: PathHit; rule: string }[]
  /** A place a rewrite rule names that still holds an old path: the rewrite did not take. */
  notRewritten: { hit: PathHit; rule: string }[]
  /** A place no rule names: a new store, or a path nobody decided about. */
  unknown: PathHit[]
}

export function judgePathHits(hits: readonly PathHit[], rules: readonly PathRule[]): PathJudgement {
  const out: PathJudgement = { kept: [], notRewritten: [], unknown: [] }
  for (const h of hits) {
    const cls = homePathClass(h.file)
    if (cls !== 'leader-data') { out.kept.push({ hit: h, rule: 'manifest-machine' }); continue }
    const rule = ruleFor(rules, h)
    if (rule) {
      if (rule.rule === 'keep' || rule.remains) out.kept.push({ hit: h, rule: rule.id })
      else out.notRewritten.push({ hit: h, rule: rule.id })
      continue
    }
    if (isUnnamedHomePath(h.file)) { out.kept.push({ hit: h, rule: 'user-file' }); continue }
    out.unknown.push(h)
  }
  return out
}

/**
 * For the self-check's scan: a whole file, or a SQLite column, whose every place a `keep` rule
 * decides need not be read (notes, histories, session records: the bulk of a home).
 */
export function keptPlace(rules: readonly PathRule[]): (file: string, at?: string) => boolean {
  return (file, at) => {
    if (homePathClass(file) !== 'leader-data') return true
    const mine = rules.filter((r) => ruleCoversFile(r, file))
    if (at === undefined) {
      const first = mine[0]
      return !!first && first.rule === 'keep' && first.at === undefined && !first.root
    }
    const kept = (root: RootKind) => ruleFor(mine, { file, at, root })?.rule === 'keep'
    return kept('home') && kept('account') && !mine.some((r) => r.rule === 'rewrite' && ruleUnderColumn(r, at))
  }
}

/**
 * Files the scan could not read (binary, over the cap, a database that would not open or read)
 * that must fail the trial: leader data that no `keep` rule covers whole (the blob rule names
 * images, audio, archives and the like), and that is not a top-level file of the user's own.
 * Such a file travels with the leader and may hold a path nobody could check.
 */
export function unscannedProblems(skipped: readonly { file: string; why: string }[], rules: readonly PathRule[]): { file: string; why: string }[] {
  const kept = keptPlace(rules)
  return skipped.filter((s) => homePathClass(s.file) === 'leader-data' && !isUnnamedHomePath(s.file) && !kept(s.file))
}

export function describeHit(h: PathHit): string {
  const where = [h.at, h.line !== undefined ? `line ${h.line}` : '', h.row !== undefined ? `row ${h.row}` : ''].filter(Boolean).join(' ')
  return `${h.file}${where ? ` (${where})` : ''}: ${h.path}`
}

// ---- rewrite ---------------------------------------------------------------------------------

export interface RewriteDone { file: string; rules: string[]; values: number }

/**
 * Replace `abs` with `text` in one rename, keeping its mode (a trigger's `check.sh` stays
 * executable): the temp file is set to the original's mode before it takes its place.
 */
export function writeAtomic(abs: string, text: string): void {
  let mode = 0o600
  try { mode = fs.statSync(abs).mode & 0o7777 } catch { /* a new file */ }
  const tmp = `${abs}.switch.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try { fs.writeSync(fd, text); fs.fchmodSync(fd, mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, abs)
}

function rewriteFile(abs: string, kind: FileKind, rootsAt: RootsAt): number {
  if (kind === 'sqlite') return rewriteDb(abs, rootsAt)
  const n = { count: 0 }
  const text = fs.readFileSync(abs, 'utf8')
  let next = text
  const whole = kind === 'json' ? spliceJson(text, rootsAt) : null
  if (whole) {
    n.count = whole.count
    next = whole.text
  } else if (kind === 'yaml') {
    const doc = YAML.parseDocument(text)
    YAML.visit(doc, {
      Scalar(_key, node, ancestors) {
        if (typeof node.value !== 'string') return
        const at = yamlAt(ancestors as unknown[], node)
        const roots = at === null ? [] : rootsAt(at)
        if (!roots.length) return
        const r = replaceRoots(node.value, rootsAt.all, roots)
        if (r !== node.value) { node.value = r; n.count++ }
      },
    })
    if (n.count) next = String(doc)
  } else {
    const lines = text.split('\n').map((line) => {
      const j = looksJson(line) ? spliceJson(line, rootsAt) : null
      if (j) { n.count += j.count; return j.text }
      const roots = rootsAt('')
      if (!roots.length) return line
      const r = replaceRoots(line, rootsAt.all, roots)
      if (r !== line) n.count++
      return r
    })
    if (n.count) next = lines.join('\n')
  }
  if (next !== text) writeAtomic(abs, next)
  return n.count
}

/** The key path of a YAML scalar from its ancestors (null for a scalar that is a key). */
function yamlAt(ancestors: unknown[], node: unknown): string | null {
  let at = ''
  const chain = [...ancestors, node]
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i]
    const next = chain[i + 1]
    if (YAML.isSeq(a)) at = `${at}[]`
    else if (YAML.isPair(a)) {
      if (next === a.key) return null
      const k = YAML.isScalar(a.key) ? String(a.key.value) : String(a.key)
      at = child(at, k)
    }
  }
  return at
}

function rewriteDb(abs: string, rootsAt: RootsAt): number {
  const db = new Database(abs)
  let n = 0
  try {
    const { columns } = textColumns(db)
    db.exec('BEGIN IMMEDIATE')
    for (const c of columns) {
      const at = `${c.table}.${c.column}`
      // A column holding JSON is judged by its keys, so ask for the column and anything under it.
      const colRoots = rootsAt(at)
      const jsonRoots: RootsAt = Object.assign((k: string) => rootsAt(k ? `${at}:${k}` : at), { all: rootsAt.all })
      const any = rootsAt(at, true)
      if (!any.length) continue
      const rows = [...columnRows(db, c, sqlNeedles(rootsAt.all))]
      const set = c.rowid
        ? db.prepare(`UPDATE OR IGNORE ${quote(c.table)} SET ${quote(c.column)} = ? WHERE rowid = ?`)
        : db.prepare(`UPDATE OR IGNORE ${quote(c.table)} SET ${quote(c.column)} = ? WHERE ${quote(c.column)} = ?`)
      for (const { r, v } of rows) {
        const j = looksJson(v) ? spliceJson(v, jsonRoots) : null
        let next = v
        if (j) next = j.text
        else if (colRoots.length) next = replaceRoots(v, rootsAt.all, colRoots)
        if (next === v) continue
        n += Number(set.run(next, c.rowid ? r : v).changes ?? 0)
      }
    }
    db.exec('COMMIT')
    return n
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* none open */ }
    throw err
  } finally {
    db.close()
  }
}

/**
 * The promotion's rewrite: every place a `rewrite` rule names, its old paths moved to the new
 * roots (or a rule's own value set). Safe to run again: a moved path is not found twice.
 */
export function rewriteHomePaths(home: string, rules: readonly PathRule[], ctx: RewriteContext): RewriteDone[] {
  const done: RewriteDone[] = []
  for (const r of rules) {
    if (r.rule === 'rewrite' && r.apply) done.push({ file: list(r.file).join(', '), rules: [r.id], values: r.apply(home, ctx) })
  }
  const moves = (r: PathRule | undefined) => r?.rule === 'rewrite' && !r.apply
  if (!ctx.roots.length || !rules.some(moves)) return done
  for (const { rel } of listFiles(home)) {
    if (SQLITE_SIBLING.test(rel) || rel.endsWith('.switch.tmp') || homePathClass(rel) !== 'leader-data') continue
    const mine = rules.filter((r) => ruleCoversFile(r, rel))
    if (!mine.some(moves)) continue
    const abs = path.join(home, rel)
    const kind = kindOf(rel, readHead(abs))
    if (kind === 'binary') continue
    // A root moves at a place when the first rule that decides it there is a generic rewrite.
    const rootsAt: RootsAt = Object.assign((at: string, under?: boolean) => ctx.roots.filter((root) => {
      if (moves(ruleFor(mine, { file: rel, at, root: root.kind }))) return true
      return under === true && mine.some((r) => moves(r) && (!r.root || r.root === root.kind) && ruleUnderColumn(r, at))
    }), { all: ctx.roots })
    const values = rewriteFile(abs, kind, rootsAt)
    if (values) done.push({ file: rel, rules: mine.filter(moves).map((r) => r.id), values })
  }
  return done
}
