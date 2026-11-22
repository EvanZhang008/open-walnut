/**
 * The Threads database (experiment `threads_sqlite`, threads-backend.ts): `WALNUT_HOME/org/threads.sqlite`,
 * its own file, so its schema version never stops an older build from opening tasks.sqlite.
 *
 * Storage only. One row per thread (`threads`: the columns a query needs, the rest of the thread in
 * `body` with `messages` left as `[]` so its key keeps its place), one row per message
 * (`thread_messages`, in order by `seq`), one row per node (`thread_nodes`: what its JSON file held
 * when this store last read or wrote it, and whether a change still waits to go out to it), and
 * `meta` (the import mark). Every call touches one node's rows; only the one-time import
 * (threads-backend.ts) runs over every node, once.
 *
 * A read leaves out a closed thread past its week (CLOSED_KEEP_MS): the sweep deletes it for good,
 * and until then it is never loaded, so the closed threads kept for a week cost an open-thread read
 * nothing more than their own rows.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database, { type Database as DatabaseType } from '../../lib/sqlite.js'
import { reopenIfWiped } from '../../lib/sqlite-wiped.js'
import { WALNUT_HOME } from '../../constants.js'
import { CLOSED_KEEP_MS, ThreadError, type OrgThread, type ThreadMessage, type ThreadsFile } from './threads-model.js'
import { expandAnswerRefs, storedMessages } from './thread-answer-refs.js'

/**
 * The newest schema this build reads; a file a newer build wrote is refused (JSON is used then).
 * 2: a message row may hold its answer as `{ same: <message id> }` (thread-answer-refs.ts). A
 * version-1 build would hand that on as an answer with no text (its routes and the phone fail on
 * it), so it refuses the file and reads the JSON files, which keep every reply whole.
 */
export const THREADS_DB_VERSION = 2

export const threadsDbPath = (): string => path.join(WALNUT_HOME, 'org', 'threads.sqlite')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  node TEXT NOT NULL,
  id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  state TEXT NOT NULL,
  closed INTEGER NOT NULL,
  closed_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (node, id)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS threads_node_open ON threads(node, closed, closed_at);
CREATE INDEX IF NOT EXISTS threads_id ON threads(id);
CREATE TABLE IF NOT EXISTS thread_messages (
  node TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (node, thread_id, seq)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS thread_nodes (
  node TEXT PRIMARY KEY,
  json_hash TEXT,
  json_mtime REAL,
  json_size INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;
`

let db: DatabaseType | null = null
let generation = 0

/** Which open of the file the handle is: state built on an earlier one (a test's wiped home) is stale. */
export function threadsDbGeneration(): number { return generation }

function open(): DatabaseType {
  fs.mkdirSync(path.dirname(threadsDbPath()), { recursive: true })
  const handle = new Database(threadsDbPath())
  try {
    const version = handle.pragma('user_version', { simple: true }) as number
    if (version > THREADS_DB_VERSION) throw new Error(`Threads database schema ${version} is newer than supported schema ${THREADS_DB_VERSION}; use a newer Walnut build.`)
    handle.pragma('journal_mode = WAL')
    handle.pragma('busy_timeout = 5000')
    handle.pragma('synchronous = NORMAL')
    handle.exec(SCHEMA)
    if (version < THREADS_DB_VERSION) handle.pragma(`user_version = ${THREADS_DB_VERSION}`)
    return handle
  } catch (err) {
    try { handle.close() } catch { /* the open failed anyway */ }
    throw err
  }
}

/** The shared handle, opened on first use. Throws when the file cannot be opened (the caller stays on JSON). */
export function threadsDb(): DatabaseType {
  if (db) {
    const live = reopenIfWiped(threadsDbPath(), db, open, (old) => old.close())
    if (live !== db) { db = live; generation += 1 }
    return db
  }
  db = open()
  generation += 1
  return db
}

export function closeThreadsDb(): void {
  if (!db) return
  try { db.close() } catch { /* already closed */ }
  db = null
}

export function getMeta(key: string): string | undefined {
  return (threadsDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

export function setMeta(key: string, value: string): void {
  threadsDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** What a node's JSON file held when this store last read or wrote it (null hash: no file yet). */
export interface JsonMark { hash: string | null; mtime: number | null; size: number | null }
export interface NodeRow extends JsonMark { dirty: boolean }

export function nodeRow(node: string): NodeRow | undefined {
  const r = threadsDb().prepare('SELECT json_hash, json_mtime, json_size, dirty FROM thread_nodes WHERE node = ?').get(node) as
    { json_hash: string | null; json_mtime: number | null; json_size: number | null; dirty: number } | undefined
  return r && { hash: r.json_hash, mtime: r.json_mtime, size: r.json_size, dirty: r.dirty === 1 }
}

export function setJsonMark(node: string, mark: JsonMark, opts: { clearDirty?: boolean } = {}): void {
  threadsDb().prepare(`INSERT INTO thread_nodes (node, json_hash, json_mtime, json_size, dirty) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(node) DO UPDATE SET json_hash = excluded.json_hash, json_mtime = excluded.json_mtime, json_size = excluded.json_size${opts.clearDirty ? ', dirty = 0' : ''}`)
    .run(node, mark.hash, mark.mtime, mark.size)
}

export function markDirty(node: string): void {
  threadsDb().prepare('INSERT INTO thread_nodes (node, dirty) VALUES (?, 1) ON CONFLICT(node) DO UPDATE SET dirty = 1').run(node)
}

export function dbNodes(): string[] {
  return threadsDb().prepare('SELECT node FROM thread_nodes ORDER BY node').pluck().all() as string[]
}

export function dirtyNodes(): string[] {
  return threadsDb().prepare('SELECT node FROM thread_nodes WHERE dirty = 1 ORDER BY node').pluck().all() as string[]
}

/**
 * One loaded thread: the object handed out, its place, and the text it was read from: `body` and
 * `msgs` from the rows, or `full` (the whole thread's JSON) from threads-sync.ts's cache. A write
 * compares with these texts, never with the object, which the mutation may have changed in place.
 */
interface Loaded { thread: OrgThread; pos: number; body?: string; msgs?: string[]; full?: string; orig?: OrgThread; stored?: string[] }
/** A node as loaded: its file and what each thread was read from, for the write that follows (writeNode). */
export interface NodeSnapshot { file: ThreadsFile; rows: Map<string, Loaded> }

const bodyText = (t: OrgThread): string => JSON.stringify({ ...t, messages: [] })
const original = (l: Loaded): OrgThread => (l.orig ??= JSON.parse(l.full!) as OrgThread)
const bodyOf = (l: Loaded): string => (l.body ??= bodyText(original(l)))
const messageCount = (l: Loaded): number => (l.msgs ? l.msgs.length : original(l).messages.length)
/** A message's row as stored: each reply once (thread-answer-refs.ts), so the rows compare as written. */
const storedTexts = (t: OrgThread): string[] => storedMessages(t.messages).map((m) => JSON.stringify(m))
const messageOf = (l: Loaded, seq: number): string | undefined => {
  if (l.msgs) return l.msgs[seq]
  return (l.stored ??= storedTexts(original(l)))[seq]
}

/**
 * `t` is the thread as it was loaded: the same object and the same text (a mutation that changed the
 * object in place reads as changed). Its text when unchanged, else null.
 */
export function unchangedText(snap: NodeSnapshot, t: OrgThread): string | null {
  const l = snap.rows.get(t.id)
  if (!l || l.thread !== t) return null
  const text = JSON.stringify(t)
  if (l.full !== undefined) return text === l.full ? text : null
  if (bodyText(t) !== l.body || t.messages.length !== l.msgs!.length) return null
  const rows = storedTexts(t)
  return rows.every((m, i) => m === l.msgs![i]) ? text : null
}

/**
 * A snapshot of a node's threads parsed from a copy of what is stored (threads-sync.ts keeps one per
 * node): each thread's text and stored place (`pos`; a write leaves them 0..n-1, a load may find
 * gaps where a closed thread past its week still waits for the sweep).
 */
export function snapshotOf(file: ThreadsFile, pos: readonly number[], texts: readonly string[]): NodeSnapshot {
  return { file, rows: new Map(file.threads.map((thread, i) => [thread.id, { thread, pos: pos[i], full: texts[i] }])) }
}

/** Each thread's stored place, in the snapshot's order. */
export const positionsOf = (snap: NodeSnapshot): number[] => snap.file.threads.map((t) => snap.rows.get(t.id)!.pos)

const keepFrom = (all: boolean): number => (all ? Number.MIN_SAFE_INTEGER : Date.now() - CLOSED_KEEP_MS)

/**
 * A node's threads in their order, as the JSON file held them. `all`: the closed ones past their
 * week too (the import's check reads everything it wrote).
 */
export function loadNode(node: string, opts: { all?: boolean } = {}): NodeSnapshot {
  const h = threadsDb()
  const from = keepFrom(!!opts.all)
  const heads = h.prepare(`SELECT id, pos, body FROM threads WHERE node = ? AND (closed = 0 OR closed_at IS NULL OR closed_at >= ?) ORDER BY pos`)
    .all(node, from) as Array<{ id: string; pos: number; body: string }>
  const rows = new Map<string, Loaded>()
  if (!heads.length) return { file: { version: 1, taskId: node, threads: [] }, rows }
  const msgs = h.prepare(`SELECT m.thread_id AS tid, m.body AS body FROM thread_messages m
    JOIN threads t ON t.node = m.node AND t.id = m.thread_id
    WHERE m.node = ? AND (t.closed = 0 OR t.closed_at IS NULL OR t.closed_at >= ?) ORDER BY m.thread_id, m.seq`)
    .all(node, from) as Array<{ tid: string; body: string }>
  const byThread = new Map<string, string[]>()
  for (const m of msgs) {
    const list = byThread.get(m.tid)
    if (list) list.push(m.body); else byThread.set(m.tid, [m.body])
  }
  const threads: OrgThread[] = []
  for (const r of heads) {
    const thread = JSON.parse(r.body) as OrgThread
    const texts = byThread.get(r.id) ?? []
    // A reply stored once reads back under every message it answers (thread-answer-refs.ts).
    thread.messages = expandAnswerRefs(texts.map((t) => JSON.parse(t) as ThreadMessage))
    rows.set(r.id, { thread, pos: r.pos, body: r.body, msgs: texts })
    threads.push(thread)
  }
  return { file: { version: 1, taskId: node, threads }, rows }
}

/** Everything a node holds, closed threads past their week included: what the import compares with its file. */
export function readNodeForCheck(node: string): ThreadsFile {
  return loadNode(node, { all: true }).file
}

const closedAt = (t: OrgThread): number | null => {
  if (!t.closed) return null
  const ms = Date.parse(t.closed.at)
  return Number.isFinite(ms) ? ms : null
}

type Statements = ReturnType<typeof prepareStatements>
const prepared = new WeakMap<DatabaseType, Statements>()

function statements(h: DatabaseType): Statements {
  let s = prepared.get(h)
  if (!s) { s = prepareStatements(h); prepared.set(h, s) }
  return s
}

function prepareStatements(h: DatabaseType) {
  return {
    upsertThread: h.prepare(`INSERT INTO threads (node, id, pos, state, closed, closed_at, created_at, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node, id) DO UPDATE SET pos = excluded.pos, state = excluded.state, closed = excluded.closed, closed_at = excluded.closed_at,
        created_at = excluded.created_at, updated_at = excluded.updated_at, body = excluded.body`),
    setPos: h.prepare('UPDATE threads SET pos = ? WHERE node = ? AND id = ?'),
    upsertMessage: h.prepare(`INSERT INTO thread_messages (node, thread_id, seq, id, at, body) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(node, thread_id, seq) DO UPDATE SET id = excluded.id, at = excluded.at, body = excluded.body`),
    dropMessagesFrom: h.prepare('DELETE FROM thread_messages WHERE node = ? AND thread_id = ? AND seq >= ?'),
    dropThread: h.prepare('DELETE FROM threads WHERE node = ? AND id = ?'),
  }
}

/**
 * Write `next` over what `snap` loaded: only the threads and messages whose text changed. `unchanged`:
 * the ids the caller already found unchanged (unchangedText); without it each is checked here. A
 * thread gone from `next` is deleted with its messages; rows `snap` never loaded (closed past their
 * week) are left for the sweep. Returns whether anything was written. Call it inside a transaction.
 */
export function writeNode(node: string, snap: NodeSnapshot, next: ThreadsFile, unchanged?: ReadonlySet<string>): boolean {
  const s = statements(threadsDb())
  let wrote = false
  const seen = new Set<string>()
  next.threads.forEach((t, pos) => {
    if (seen.has(t.id)) throw new ThreadError('bad_input', 500, `Thread ${t.id} is twice on this node.`)
    seen.add(t.id)
    const prev = snap.rows.get(t.id)
    if (prev && (unchanged ? unchanged.has(t.id) : unchangedText(snap, t) !== null)) {
      if (prev.pos !== pos) { s.setPos.run(pos, node, t.id); wrote = true }
      return
    }
    const body = bodyText(t)
    if (!prev || bodyOf(prev) !== body || prev.pos !== pos) {
      s.upsertThread.run(node, t.id, pos, t.state, t.closed ? 1 : 0, closedAt(t), t.createdAt, t.updatedAt, body)
      wrote = true
    }
    storedTexts(t).forEach((text, seq) => {
      const m = t.messages[seq]
      if (prev && messageOf(prev, seq) === text) return
      s.upsertMessage.run(node, t.id, seq, m.id, m.at, text)
      wrote = true
    })
    if (!prev || messageCount(prev) > t.messages.length) {
      if (s.dropMessagesFrom.run(node, t.id, t.messages.length).changes) wrote = true
    }
  })
  for (const id of snap.rows.keys()) {
    if (seen.has(id)) continue
    s.dropThread.run(node, id)
    s.dropMessagesFrom.run(node, id, 0)
    wrote = true
  }
  if (wrote) markDirty(node)
  return wrote
}

/** Replace every row of a node with `file` (the import, and a JSON file changed outside). Call it inside a transaction. */
export function replaceNode(node: string, file: ThreadsFile, mark: JsonMark): void {
  const h = threadsDb()
  h.prepare('DELETE FROM threads WHERE node = ?').run(node)
  h.prepare('DELETE FROM thread_messages WHERE node = ?').run(node)
  writeNode(node, { file: { version: 1, taskId: node, threads: [] }, rows: new Map() }, file)
  setJsonMark(node, mark, { clearDirty: true })
}

/** Delete a node's closed threads past their week (the sweep): how many. */
export function dropExpired(node: string, now = Date.now()): number {
  const h = threadsDb()
  const cut = now - CLOSED_KEEP_MS
  return h.transaction(() => {
    const ids = h.prepare('SELECT id FROM threads WHERE node = ? AND closed = 1 AND closed_at < ?').pluck().all(node, cut) as string[]
    const del = statements(h)
    for (const id of ids) { del.dropThread.run(node, id); del.dropMessagesFrom.run(node, id, 0) }
    return ids.length
  })()
}
