/**
 * Where Threads are kept: the JSON file per node (`org/threads/<taskId>.json`, the default), or the
 * Threads database (threads-db.ts) while the experiment `threads_sqlite` is on. threads-store.ts asks
 * `useThreadsDb()` on every call and keeps its API and behaviour on either.
 *
 * The first time the experiment is on: org/threads/ is copied to org/threads-backup/<time>/, every
 * file is imported in one transaction, and each node is read back and compared with its file; any
 * difference rolls the import back and leaves Threads in their files (warned, tried again on the
 * next boot). After that the files stay current (threads-sync.ts): a changed node is written back
 * to its file at most once a minute and at shutdown, and a file changed outside (an older build, a
 * sync pull) is read back in before its node is used: the file wins. So an older build reads the
 * files as before, and coming back reads what it wrote.
 *
 * Only the leader keeps Threads: a replica never opens the database.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { experimentalEnabled } from '../experimental.js'
import { isFollower } from '../server-role.js'
import { dbNodes, dirtyNodes, getMeta, readNodeForCheck, replaceNode, setMeta, threadsDb, threadsDbGeneration, threadsDbPath } from './threads-db.js'
import type { ThreadsFile } from './threads-model.js'
import { exportDirtyNodes, flushThreadsExports, jsonNodes, parseThreadsText, sha256, syncFromJson, threadsDir, threadsJsonFile } from './threads-sync.js'

// ── The switch: the experiment, cached, read again on every config change ──

const TEST_PROCESS = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test')
let flag: boolean | undefined
let forced: boolean | undefined
let reading: Promise<void> | null = null
let watching = false

function setFlag(on: boolean): void {
  const was = flag
  flag = on
  if (was === on) return
  // Off: every change still waiting goes out to its file before the files are read again.
  // On again: the files are checked against the database before it is used (they may have moved).
  ready = null
  if (!on && was) void flushThreadsExports()
}

async function readFlag(): Promise<void> {
  try {
    const { getConfig } = await import('../config-manager.js')
    setFlag(experimentalEnabled((await getConfig()).experimental, 'threads_sqlite'))
  } catch (err) {
    log.task.warn('org threads: config not read for threads_sqlite', { error: err instanceof Error ? err.message : String(err) })
    flag ??= false
  }
}

function watch(): void {
  if (watching) return
  watching = true
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe('org-threads-backend', (event) => {
      if (event.name !== EventNames.CONFIG_CHANGED) return
      const data = event.data as { key?: string; config?: unknown } | undefined
      if (data?.key && data.key !== 'experimental' && !data.config) return
      void readFlag()
    }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  }).catch(() => { watching = false })
}

/** The experiment as known now, with no read: undefined until the config was read once. */
function flagNow(): boolean | undefined {
  if (forced !== undefined) return forced
  if (TEST_PROCESS && process.env.WALNUT_THREADS_SQLITE === '1') return true
  return flag
}

/** Whether the experiment is on (a test process may force it: `WALNUT_THREADS_SQLITE=1`, or the setter below). */
export async function threadsSqliteOn(): Promise<boolean> {
  const now = flagNow()
  if (now !== undefined) return now
  watch()
  await (reading ??= readFlag().finally(() => { reading = null }))
  return flag === true
}

// ── Ready: imported once, checked against the files on every start ──

let ready: { gen: number; ok: Promise<boolean>; value?: boolean } | null = null
let openFailed = false

/**
 * Whether a call that chose the database may still write it, checked with nothing awaited right
 * before its write (threads-sync.ts dbMutateThreads): false once the experiment went off meanwhile.
 */
export function threadsDbOnNow(): boolean {
  return !openFailed && !isFollower() && flagNow() === true && ready?.value === true && ready.gen === threadsDbGeneration()
}

/** True when this call goes to the database; false keeps the JSON files (the flag is off, or the move did not finish). */
export async function useThreadsDb(): Promise<boolean> {
  if (isFollower() || openFailed) return false
  if (!(await threadsSqliteOn())) return false
  let gen: number
  try {
    threadsDb()
    gen = threadsDbGeneration()
  } catch (err) {
    openFailed = true
    log.task.warn('org threads: the database did not open; Threads stay in their JSON files', { error: err instanceof Error ? err.message : String(err) })
    return false
  }
  if (!ready || ready.gen !== gen) {
    const run: NonNullable<typeof ready> = { gen, ok: prepare().catch(async (err) => {
      log.task.warn('org threads: the database is not used; Threads stay in their JSON files', { error: err instanceof Error ? err.message : String(err) })
      // What it holds and its files lack goes out to them first, so the JSON mode reads it.
      await writeDirtyNow()
      return false
    }) }
    void run.ok.then((v) => { run.value = v })
    ready = run
  }
  return ready.ok
}

async function prepare(): Promise<boolean> {
  if (!getMeta('imported_at')) return importAll()
  // A crash's changes not yet in their files go out first (each checked against its file there).
  exportDirtyNodes()
  // Files an older build, a sync pull or the JSON mode wrote since: read back in (the file wins).
  // One node that cannot be read keeps its database copy; the others go on.
  for (const node of new Set([...dbNodes(), ...(await jsonNodes())])) {
    try { await syncFromJson(node) } catch (err) {
      log.task.warn('org threads: a threads file was not checked against the database', { node, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return true
}

async function writeDirtyNow(): Promise<void> {
  try {
    if (!getMeta('imported_at') || !dirtyNodes().length) return
    exportDirtyNodes()
    await flushThreadsExports()
  } catch (err) {
    log.task.warn('org threads: changes left in the database were not written to their files', { error: err instanceof Error ? err.message : String(err) })
  }
}

let leftovers: Promise<void> | null = null

/**
 * With the experiment off: the changes a crash left in the database and not yet in their files go
 * out to them (each where its file is as the database last wrote or read it, else merged), so turning
 * the experiment off never loses its last minute. Run once per start; the JSON path awaits it before
 * its first read or write (threads-store.ts), so a boot-time JSON write never lands first. A home
 * that never had the database never opens one.
 */
export function writeThreadsLeftovers(): Promise<void> {
  return (leftovers ??= (async () => {
    if (isFollower() || (await threadsSqliteOn())) return
    try { await fs.access(threadsDbPath()) } catch { return }
    await writeDirtyNow()
  })())
}

/** The first difference between two reads of a node, or null when they are the same. */
export function threadsDifference(want: ThreadsFile, got: ThreadsFile): string | null {
  const msgs = (f: ThreadsFile) => f.threads.reduce((n, t) => n + t.messages.length, 0)
  if (want.threads.length !== got.threads.length) return `${want.threads.length} threads in the file, ${got.threads.length} read back`
  if (msgs(want) !== msgs(got)) return `${msgs(want)} messages in the file, ${msgs(got)} read back`
  if (isDeepStrictEqual(want, got) && JSON.stringify(want) === JSON.stringify(got)) return null
  const at = want.threads.findIndex((t, i) => JSON.stringify(t) !== JSON.stringify(got.threads[i]))
  return at < 0 ? 'the files differ outside their threads' : `thread ${want.threads[at].id} differs`
}

class ImportMismatch extends Error {
  constructor(readonly node: string, readonly difference: string) { super(`${node}: ${difference}`) }
}

/** The one-time move: back up, import every file, read each back; only an exact match switches. */
async function importAll(): Promise<boolean> {
  const nodes = await jsonNodes()
  const files: Array<{ node: string; file: ThreadsFile; mark: { hash: string; mtime: number; size: number } }> = []
  let backup = ''
  if (nodes.length) {
    backup = path.join(WALNUT_HOME, 'org', 'threads-backup', new Date().toISOString().replace(/[:.]/g, '-'))
    try {
      await fs.cp(threadsDir(), backup, { recursive: true, errorOnExist: true, force: false })
    } catch (err) {
      // A copy cut short is no backup: it goes, and the move waits for the next start.
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
      log.task.warn('org threads: the backup of the threads files failed; Threads stay in their JSON files', { error: err instanceof Error ? err.message : String(err) })
      return false
    }
  }
  for (const node of nodes) {
    const p = threadsJsonFile(node)
    try {
      // Stat first: a write after it moves the mtime, so the next read sees the file changed.
      const st = await fs.stat(p)
      const text = await fs.readFile(p, 'utf8')
      files.push({ node, file: parseThreadsText(text, node), mark: { hash: sha256(text), mtime: st.mtimeMs, size: st.size } })
    } catch (err) {
      log.task.warn('org threads: a threads file did not read; Threads stay in their JSON files', { node, error: err instanceof Error ? err.message : String(err) })
      if (backup) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
      return false
    }
  }
  const h = threadsDb()
  try {
    h.transaction(() => {
      for (const f of files) {
        try { replaceNode(f.node, f.file, f.mark) } catch (err) { throw new ImportMismatch(f.node, err instanceof Error ? err.message : String(err)) }
      }
      for (const f of files) {
        const difference = threadsDifference(f.file, readNodeForCheck(f.node))
        if (difference) throw new ImportMismatch(f.node, difference)
      }
      setMeta('imported_at', new Date().toISOString())
      if (backup) setMeta('backup_dir', backup)
    })()
  } catch (err) {
    const m = err instanceof ImportMismatch ? err : null
    log.task.warn('org threads: the move to the database was undone; Threads stay in their JSON files until the next start', {
      ...(m ? { node: m.node, difference: m.difference } : { error: err instanceof Error ? err.message : String(err) }),
    })
    // Its files were never touched: the copy made for this try goes, so tries at each start never pile up.
    if (backup) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
    return false
  }
  log.task.info('org threads: moved to the database', { nodes: files.length, threads: files.reduce((n, f) => n + f.file.threads.length, 0), backup })
  return true
}

/** For tests: forget the switch, the readiness and a failed open (`on` forces the experiment, undefined goes back to the config). */
export function _resetThreadsBackendForTesting(on?: boolean): void {
  forced = on
  leftovers = null
  flag = undefined
  ready = null
  openFailed = false
}
