/**
 * The Threads database and the JSON files beside it (threads-backend.ts): reads and writes of a
 * node in the database, each node written back to its file, and a file changed outside read back in.
 *
 *  - Written back: a node that changed is written to `org/threads/<taskId>.json` in the old format
 *    (all the threads it holds), at most once a minute per node, and every waiting node at shutdown
 *    and when the experiment is turned off. The text's hash, mtime and size are kept (thread_nodes),
 *    and a node stays marked dirty until its file holds it, so a crash writes it at the next start.
 *  - Read back in: before a node is used, its file's stat is compared with what was kept; a file whose
 *    text changed (an older build, a sync pull, a hand edit) replaces the node's rows: the file wins.
 *    When the database also held changes not yet in that file, the two are merged by thread instead
 *    (threads-merge.ts), the database's copy saved first to org/threads-backup/conflicts/. A file that
 *    is gone is written again from the database; one that does not parse is overwritten.
 *  - Stopping: once the server stops, every write goes to its file before the call returns.
 *
 * Every call touches one node. The mutation runs synchronously inside one transaction, so two
 * writers of a node never interleave (only this server writes Threads).
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { withFileLock } from '../../utils/file-lock.js'
import { writeTextFile } from '../../utils/fs.js'
import { dbNodes, dirtyNodes, dropExpired, loadNode, markDirty, nodeRow, replaceNode, setJsonMark, snapshotOf, threadsDb, threadsDbGeneration, positionsOf, unchangedText, writeNode, type NodeSnapshot } from './threads-db.js'
import { mergeThreadsConflict } from './threads-merge.js'
import { CLOSED_KEEP_MS, normalizeThreads, ThreadError, type OrgThread, type ThreadsFile } from './threads-model.js'
import { registerMemoryHolder } from '../observability/memory-ledger.js'
import { freezeReadForTests } from './frozen-read.js'

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const threadsDir = (): string => path.join(WALNUT_HOME, 'org', 'threads')

/** A node's JSON file; a task id that could name another path is refused. */
export function threadsJsonFile(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new ThreadError('bad_input', 400, `Invalid task id: ${taskId}`)
  return path.join(threadsDir(), `${taskId}.json`)
}

/** The nodes that have a JSON file. */
export async function jsonNodes(): Promise<string[]> {
  const names = await fs.readdir(threadsDir()).catch(() => [] as string[])
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => TASK_ID_RE.test(id))
}

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex')

/** A JSON file's text as a node's threads (an empty file reads as none, as readJsonFile does). */
export function parseThreadsText(text: string, node: string): ThreadsFile {
  return normalizeThreads(text.trim() ? JSON.parse(text) : null, node)
}

const TEST_PROCESS = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')
const EXPORT_EVERY_MS = 60_000
let exportEveryOverride: number | undefined
let stopping = false
function exportEveryMs(): number {
  if (stopping) return 0
  if (exportEveryOverride !== undefined) return exportEveryOverride
  const env = TEST_PROCESS ? Number(process.env.WALNUT_THREADS_EXPORT_MS) : NaN
  return Number.isFinite(env) && env >= 0 ? env : EXPORT_EVERY_MS
}

// What waits to be written, per node; kept for one open of the database (a test's wiped home starts over).
let stateGen = -1
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const lastAt = new Map<string, number>()
const chains = new Map<string, Promise<void>>()
const writing = new Set<string>()
const changes = new Map<string, number>()
/** The database writes under way: a JSON read or write after the experiment went off waits for its node's. */
const inflight = new Set<{ node: string; done: Promise<unknown> }>()
const writesOf = (node?: string) => [...inflight].filter((w) => node === undefined || w.node === node).map((w) => w.done)

function forget(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear(); lastAt.clear(); chains.clear(); writing.clear(); changes.clear(); inflight.clear(); cache.clear(); cacheChars = 0
  if (viewSweep) clearTimeout(viewSweep)
  viewSweep = undefined
}

function fresh(): void {
  threadsDb()
  const gen = threadsDbGeneration()
  if (gen === stateGen) return
  forget()
  stateGen = gen
}

/** For tests: this module as a new process finds it (nothing waiting, nothing cached), the database rows kept. */
export function _forgetThreadsSyncForTesting(): void {
  forget()
  stateGen = -1
  stopping = false
}

function changed(node: string): void {
  changes.set(node, (changes.get(node) ?? 0) + 1)
  scheduleExport(node)
}

const statOf = async (p: string): Promise<import('node:fs').Stats | null | 'unknown'> => {
  try { return await fs.stat(p) } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? null : 'unknown' }
}

/** Threads with one id kept once (the first), as the database holds them; a hand edit may repeat one. */
function onceEach(node: string, file: ThreadsFile): ThreadsFile {
  const seen = new Set<string>()
  const threads = file.threads.filter((t) => !seen.has(t.id) && !!seen.add(t.id))
  if (threads.length === file.threads.length) return file
  log.task.warn('org threads: a threads file names a thread twice; the first is kept', { node, dropped: file.threads.length - threads.length })
  return { ...file, threads }
}

/** The database keeps its copy over a file it cannot take, and writes it out again. */
function keepOurs(node: string, mark: { hash: string; mtime: number; size: number }, why: string, error?: unknown): void {
  setJsonMark(node, mark)
  markDirty(node)
  changed(node)
  log.task.warn(`org threads: a threads file changed outside ${why}; the database keeps its copy`, { node, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) })
}

/** Read a node's file back in when it changed outside since this store last read or wrote it. Never throws. */
export async function syncFromJson(node: string): Promise<void> {
  fresh()
  if (writing.has(node)) return
  const p = threadsJsonFile(node)
  const row = nodeRow(node)
  const st = await statOf(p)
  // A file this server cannot look at now (permissions, I/O): nothing is decided on it.
  if (st === 'unknown') return
  if (!st) {
    if (row?.hash) {
      setJsonMark(node, { hash: null, mtime: null, size: null })
      markDirty(node)
      changed(node)
      log.task.warn('org threads: a threads file was gone; written again from the database', { node })
    }
    return
  }
  if (row?.hash && row.mtime === st.mtimeMs && row.size === st.size) return
  let text: string
  try { text = await fs.readFile(p, 'utf8') } catch { return }
  if (writing.has(node)) return
  const hash = sha256(text)
  const mark = { hash, mtime: st.mtimeMs, size: st.size }
  // Checked again after the read: another call may have read this same text in meanwhile.
  if (nodeRow(node)?.hash === hash) { setJsonMark(node, mark); return }
  let file: ThreadsFile
  try {
    file = onceEach(node, parseThreadsText(text, node))
  } catch (err) {
    keepOurs(node, mark, 'does not parse', err)
    return
  }
  // An empty file (a write cut short) never empties a node the database holds threads of.
  if (!text.trim() && storedNow(node).threads.length) { keepOurs(node, mark, 'is empty'); return }
  // Changes here not yet in the file: merged by thread, never dropped whole, the database's copy saved first.
  let fromDb = 0
  const ours = nodeRow(node)?.dirty ? storedNow(node) : null
  if (ours?.threads.length) {
    const saved = await saveConflictCopy(node, ours).catch((err) => {
      log.task.warn('org threads: the database copy was not set aside before a merge', { node, error: err instanceof Error ? err.message : String(err) })
      return ''
    })
    if (writing.has(node) || nodeRow(node)?.hash === hash) return
    const merged = mergeThreadsConflict(file, current(node).file)
    file = merged.file
    fromDb = merged.fromDb
    log.task.warn('org threads: a threads file changed outside while changes here waited for it; merged by thread', { node, fromDatabase: fromDb, saved })
  }
  try {
    threadsDb().transaction(() => {
      replaceNode(node, file, mark)
      if (fromDb) markDirty(node)
    })()
  } catch (err) {
    keepOurs(node, mark, 'was not taken in', err)
    return
  }
  dropCache(node)
  if (fromDb) changed(node)
  else changes.set(node, (changes.get(node) ?? 0) + 1)
  if (row && !fromDb) log.task.info('org threads: a threads file changed outside; read back in', { node, threads: file.threads.length })
}

/** The database's copy of a node, set aside before a merge changes it: its path. */
async function saveConflictCopy(node: string, file: ThreadsFile): Promise<string> {
  const p = path.join(WALNUT_HOME, 'org', 'threads-backup', 'conflicts', `${node}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeTextFile(p, JSON.stringify(file, null, 2) + '\n')
  return p
}

/** Write a node to its file soon: at once when it was not written this last minute, else when the minute is up. */
export function scheduleExport(node: string, minWait = 0): void {
  fresh()
  if (timers.has(node)) return
  const gen = stateGen
  const last = lastAt.get(node)
  const wait = Math.max(minWait, last === undefined ? 0 : last + exportEveryMs() - Date.now())
  const timer = setTimeout(() => {
    timers.delete(node)
    if (gen === threadsDbGeneration()) void runExport(node)
  }, wait)
  timer.unref?.()
  timers.set(node, timer)
}

const RETRY_MS = 30_000

function runExport(node: string): Promise<void> {
  const run = (chains.get(node) ?? Promise.resolve())
    .then(() => exportNow(node))
    .catch((err) => {
      log.task.warn('org threads: a threads file was not written; trying again', { node, error: err instanceof Error ? err.message : String(err) })
      try { scheduleExport(node, RETRY_MS) } catch { /* the database is gone: the next start writes it */ }
    })
  chains.set(node, run)
  void run.finally(() => { if (chains.get(node) === run) chains.delete(node) })
  return run
}

async function exportNow(node: string): Promise<void> {
  const gen = stateGen
  fresh()
  if (gen !== stateGen) return
  lastAt.set(node, Date.now())
  if (!nodeRow(node)?.dirty) return
  // A file changed outside wins over what waits here.
  await syncFromJson(node)
  if (!nodeRow(node)?.dirty) return
  const seen = changes.get(node) ?? 0
  // Every reply whole, also where the database keeps it once (thread-answer-refs.ts): the file is what
  // an older build and the JSON mode read.
  const text = JSON.stringify(storedNow(node), null, 2) + '\n'
  const p = threadsJsonFile(node)
  writing.add(node)
  let outside = false
  try {
    await withFileLock(p, async () => {
      // Under the lock an older build's writer also takes: a file it changed since is not overwritten.
      const row = nodeRow(node)
      const st = await statOf(p)
      if (st === 'unknown') throw new Error('the threads file cannot be read')
      if (st && !(row?.hash && row.mtime === st.mtimeMs && row.size === st.size)
        && sha256(await fs.readFile(p, 'utf8')) !== row?.hash) { outside = true; return }
      await writeTextFile(p, text)
      const after = await fs.stat(p)
      if (gen !== threadsDbGeneration()) return
      setJsonMark(node, { hash: sha256(text), mtime: after.mtimeMs, size: after.size }, { clearDirty: (changes.get(node) ?? 0) === seen })
    })
  } finally {
    writing.delete(node)
  }
  if (outside) await syncFromJson(node)
}

/** Every node still marked dirty (a crash before its write) goes out to its file. */
export function exportDirtyNodes(): void {
  for (const node of dirtyNodes()) scheduleExport(node)
}

/** Write every waiting node now (shutdown, the experiment turned off). Never opens the database for it. */
export async function flushThreadsExports(): Promise<void> {
  if (stateGen < 0) return
  try { fresh() } catch { return }
  await Promise.allSettled(writesOf())
  const nodes = new Set([...timers.keys(), ...dirtyNodes()])
  for (const node of nodes) { clearTimeout(timers.get(node)); timers.delete(node) }
  await Promise.all([...[...nodes].map(runExport), ...chains.values()])
}

/**
 * The server stops: every write from now on goes to its file before its call returns (no minute's
 * wait a timer at exit would never end), and every waiting node is written now. stopServer calls it
 * before the HTTP close, and flushThreadsExports after it.
 */
export async function stopThreadsExports(): Promise<void> {
  stopping = true
  await flushThreadsExports()
}

/** A server starts in this process (a test's restart): writes go back to waiting their minute. */
export function noteThreadsRunning(): void {
  stopping = false
}

/** A node's write that still waits is done now (a JSON read right after the experiment went off). */
export async function flushNodeExport(node: string): Promise<void> {
  if (stateGen < 0) return
  await Promise.allSettled(writesOf(node))
  await exportWaiting(node)
}

async function exportWaiting(node: string): Promise<void> {
  if (!timers.has(node) && !chains.has(node)) return
  clearTimeout(timers.get(node))
  timers.delete(node)
  await runExport(node)
}

// ── A node's reads and writes in the database ──

/**
 * Each node's threads as JSON text, made when it is loaded and at each write (only this server
 * writes them). Dropped when a closed thread in it passes its week (a read leaves that one out),
 * and on any other change: a write here (keepCache), a file changed outside (syncFromJson), the sweep.
 *
 * `view`: the threads parsed once from that text, which every reader of the node shares until it
 * changes (dbReadThreads; 2026-11-25: one parse per read of the whole node, about 8 MB of text
 * across the nodes, was the server's largest JSON.parse after a start, 0.6 to 1.8 GB of objects).
 * No reader changes what it reads (tests/core/org/threads-shared-read.test.ts lists how each is
 * kept from it); a write's step gets its own copy (current). Let go VIEW_KEEP_MS after its last read.
 */
const cache = new Map<string, { texts: string[]; pos: number[]; until: number; chars: number; view?: ThreadsFile; viewAt?: number }>()
/**
 * The cache's bound: the nodes used last are kept, up to this much text (2026-11-25: 2.8 M chars
 * for every node on the live server). A node's view takes about two bytes per char of its text.
 */
const CACHE_CHARS = 16 * 1024 * 1024
let cacheChars = 0
/** A node's shared read is let go this long after its last read (the JSON mode's too, threads-store.ts). */
export const VIEW_KEEP_MS = 60_000
let viewSweep: ReturnType<typeof setTimeout> | undefined
let viewParses = 0
registerMemoryHolder({
  name: 'threads.texts',
  // The texts (two bytes a char) and their views (measured about two bytes a char of text).
  budgetBytes: CACHE_CHARS * 4,
  read: () => {
    let viewChars = 0
    for (const c of cache.values()) if (c.view) viewChars += c.chars
    return { entries: cache.size, bytes: cacheChars * 2 + viewChars * 2 }
  },
})

function dropCache(node: string): void {
  const c = cache.get(node)
  if (!c) return
  cacheChars -= c.chars
  cache.delete(node)
}

/** `texts`: each thread's JSON, when the caller has it already. */
function keepCache(node: string, file: ThreadsFile, pos: number[], texts = file.threads.map((t) => JSON.stringify(t))): void {
  let until = Infinity
  for (const t of file.threads) {
    const at = t.closed ? Date.parse(t.closed.at) : NaN
    if (Number.isFinite(at)) until = Math.min(until, at + CLOSED_KEEP_MS)
  }
  dropCache(node)
  const chars = texts.reduce((n, t) => n + t.length, 0)
  cache.set(node, { texts, pos, until, chars })
  cacheChars += chars
  for (const old of cache.keys()) {
    if (cacheChars <= CACHE_CHARS || old === node) break
    dropCache(old)
  }
}

/** The node's cache entry while it holds; used last, so kept longest. */
function liveEntry(node: string) {
  const c = cache.get(node)
  if (!c) return null
  if (Date.now() > c.until) { dropCache(node); return null }
  cache.delete(node)
  cache.set(node, c)
  return c
}

const parseTexts = (texts: readonly string[]): OrgThread[] => JSON.parse(`[${texts.join(',')}]`) as OrgThread[]

/** A copy of the node of its own, from the cache: what a write's step may change in place. */
function cached(node: string): NodeSnapshot | null {
  const c = liveEntry(node)
  if (!c) return null
  return snapshotOf({ version: 1, taskId: node, threads: parseTexts(c.texts) }, c.pos, c.texts)
}

/** The node as stored now, a copy of the caller's own: from the cache, else loaded (and cached before anyone holds it). */
function current(node: string): NodeSnapshot {
  const hit = cached(node)
  if (hit) return hit
  const snap = loadNode(node)
  keepCache(node, snap.file, positionsOf(snap))
  return snap
}

/** The node's threads every reader shares: parsed once per change of the node (`view`). Never changed in place. */
function sharedView(node: string): ThreadsFile {
  const c = liveEntry(node)
  if (c?.view) { c.viewAt = Date.now(); return c.view }
  // Parsed from the kept text, or loaded (current keeps its text): objects no write's step holds.
  const view: ThreadsFile = c ? { version: 1, taskId: node, threads: parseTexts(c.texts) } : current(node).file
  viewParses++
  freezeReadForTests(view)
  const kept = cache.get(node)
  if (kept) { kept.view = view; kept.viewAt = Date.now(); armViewSweep() }
  return view
}

/**
 * The node as stored now, for this module's own one-off looks (an export, a file changed outside):
 * the readers' view when one is kept, else a parse of its own that is not kept, so a write's
 * export does not hold a view nobody reads.
 */
function storedNow(node: string): ThreadsFile {
  return liveEntry(node)?.view ?? current(node).file
}

/** One clock for every view: a view not read for VIEW_KEEP_MS is let go (its text stays). */
function armViewSweep(): void {
  if (viewSweep) return
  viewSweep = setTimeout(() => {
    viewSweep = undefined
    const old = Date.now() - VIEW_KEEP_MS
    let left = false
    for (const c of cache.values()) {
      if (c.view && (c.viewAt ?? 0) <= old) { c.view = undefined; c.viewAt = undefined }
      else if (c.view) left = true
    }
    if (left) armViewSweep()
  }, VIEW_KEEP_MS)
  viewSweep.unref?.()
}

/** For tests: how many times a node's threads were parsed for its readers (each change of a node at most once). */
export const _threadViewParsesForTesting = (): number => viewParses

/**
 * The node's threads, shared by every reader until the node changes: read only. A caller that
 * changes threads builds new objects (`{ ...t }`, `[...threads]`) or copies what it changes.
 */
export async function dbReadThreads(node: string): Promise<ThreadsFile> {
  await syncFromJson(node)
  return sharedView(node)
}

/**
 * The threads as the JSON mode would read them back: a changed thread goes through a JSON round
 * trip and normalizeThreads (what the next JSON read does to the written file); one whose object and
 * text are as loaded is kept as it is. Also which ids are unchanged, and each thread's text.
 */
function storedForm(node: string, snap: NodeSnapshot, next: ThreadsFile): { file: ThreadsFile; unchanged: Set<string>; texts: string[] } {
  const threads: OrgThread[] = []
  const texts: string[] = []
  const unchanged = new Set<string>()
  for (const t of next.threads) {
    const same = unchangedText(snap, t)
    if (same !== null) { threads.push(t); texts.push(same); unchanged.add(t.id); continue }
    for (const n of normalizeThreads({ threads: [JSON.parse(JSON.stringify(t))] }, node).threads) {
      threads.push(n)
      texts.push(JSON.stringify(n))
    }
  }
  return { file: { version: 1, taskId: node, threads }, unchanged, texts }
}

/**
 * One node's read-modify-write: `step` gets the node's threads and returns the next ones; only what
 * changed is written, judged by each thread's text against what was loaded (a mutation that changed
 * an object in place is caught too). `step` throwing writes nothing.
 */
export async function dbMutateThreads(node: string, step: (cur: ThreadsFile) => ThreadsFile, stillOn: () => boolean): Promise<boolean> {
  const write = { node, done: mutateNow(node, step, stillOn) }
  inflight.add(write)
  try { return await write.done } finally { inflight.delete(write) }
}

/** false: the experiment went off before the write began; nothing was written (the caller writes the file). */
async function mutateNow(node: string, step: (cur: ThreadsFile) => ThreadsFile, stillOn: () => boolean): Promise<boolean> {
  await syncFromJson(node)
  // Checked with nothing awaited before the write: a write that began after the experiment went off
  // goes to the file instead, behind the flush of what waits here.
  if (!stillOn()) return false
  const { wrote, stored } = threadsDb().transaction(() => {
    const snap = current(node)
    const stored = storedForm(node, snap, step(snap.file))
    return { wrote: writeNode(node, snap, stored.file, stored.unchanged), stored }
  })()
  if (wrote) {
    // Before the caller gets its answer, which may hold some of these objects. A write leaves every
    // thread it holds at its index (writeNode).
    keepCache(node, stored.file, stored.file.threads.map((_, i) => i), stored.texts)
    changed(node)
    // No wait between writes (stopping, or a test's setting): the call returns once its file holds it.
    if (exportEveryMs() === 0) await exportWaiting(node)
  }
  return true
}

/** Every node the database or the files hold. */
export async function dbThreadNodes(): Promise<string[]> {
  fresh()
  return [...new Set([...dbNodes(), ...(await jsonNodes())])]
}

/** The sweep's delete of a node's closed threads past their week, which no read loads. */
export async function dbDropExpired(node: string, now: number): Promise<number> {
  await syncFromJson(node)
  const n = dropExpired(node, now)
  if (n) { dropCache(node); markDirty(node); changed(node) }
  return n
}

/** For tests: the minimum time between two writes of one node's file (undefined: the default). */
export function _setThreadsExportEveryForTesting(ms?: number): void {
  exportEveryOverride = ms
}
