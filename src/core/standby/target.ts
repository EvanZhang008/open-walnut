/**
 * The receiving side of the standby copy: keeps complete batches only.
 *
 * A batch becomes current in one step. Its chunks arrive first, each checked against its
 * sha256 before it is kept. Commit then builds every new or changed file of the batch in
 * .apply/new from its chunks (each chunk checked again, and the whole file against its
 * hash), writes the batch's manifest and a journal of the swap, swaps the files into copy/
 * (what each one replaces moves to .apply/old), and only then writes standby.json naming the
 * batch: that write is the step. Until it lands, the previous batch is current, and a crash
 * or a failure at any point is undone by `recover` (run first by every caller): the journal
 * says which paths moved, .apply/old holds what they replaced. After it lands, recovery only
 * finishes the cleanup.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { withFileLock } from '../../utils/file-lock.js'
import { sha256 } from './chunks.js'
import { limiter } from './scan.js'
import {
  EXEC_MODE, FILE_MODE, chunkPath, closeDirs, copyStatOf, currentFiles, fsyncPath, manifestPath, openDirs,
  pruneEmptyParents, readCopyStats, readJson, readState, removeEmptyDirs, removeTree, safeRel, targetPaths, writeCopyStats, writeDurable, writeState,
  type TargetPaths,
} from './target-files.js'
import { chunkIds, type BatchFile, type BatchManifest, type CommitResult, type StandbyState } from './types.js'

interface JournalStep {
  p: string
  op: 'put' | 'del'
  /** The path held a file of the previous batch. */
  existed: boolean
}

interface Journal {
  batch: number
  steps: JournalStep[]
}

export interface CommitHooks {
  /** Called at each named point of a commit (tests stop the process there). */
  point?: (name: 'files-built' | 'journal-written' | 'half-step' | 'mid-swap' | 'swapped' | 'state-written') => Promise<void> | void
}

export class StandbyTarget {
  readonly t: TargetPaths
  constructor(root: string) {
    this.t = targetPaths(path.resolve(root))
  }

  /** Serialize writers of this target (commit, verify) across processes. */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.t.state, async () => {
      await this.recoverNow()
      return fn()
    }, { timeoutMs: 60_000 })
  }

  async init(): Promise<void> {
    // The target holds the home's credentials: only its owner may enter it.
    await fs.mkdir(this.t.root, { recursive: true, mode: 0o700 })
    await fs.chmod(this.t.root, 0o700)
    for (const d of [this.t.batches, this.t.chunks]) await fs.mkdir(d, { recursive: true, mode: 0o700 })
    await fs.mkdir(this.t.copy, { recursive: true, mode: 0o700 })
    await this.locked(async () => {})
  }

  state(): Promise<StandbyState> {
    return readState(this.t)
  }

  async current(): Promise<{ state: StandbyState; files: BatchFile[] }> {
    const state = await readState(this.t)
    return { state, files: await currentFiles(this.t, state) }
  }

  async missing(ids: string[]): Promise<Set<string>> {
    const out = new Set<string>()
    const slot = limiter(64)
    await Promise.all([...new Set(ids)].map((id) => slot(async () => {
      if (!await fs.access(chunkPath(this.t, id)).then(() => true, () => false)) out.add(id)
    })))
    return out
  }

  /** Keep one chunk, once its bytes hash to its id. */
  async putChunk(id: string, data: Buffer): Promise<void> {
    const file = chunkPath(this.t, id)
    if (sha256(data) !== id) throw new Error(`chunk ${id} does not match its hash`)
    if (await fs.access(file).then(() => true, () => false)) return
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    try {
      const fh = await fs.open(tmp, 'w', 0o400)
      try { await fh.writeFile(data) } finally { await fh.close() }
      await fs.rename(tmp, file)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * Read a chunk back and check it. A damaged one (a power loss can leave a chunk written but
   * not on disk) is removed, so `missing` asks the leader for it again.
   */
  async readChunk(id: string): Promise<Buffer> {
    const file = chunkPath(this.t, id)
    const data = await fs.readFile(file)
    if (sha256(data) !== id) {
      await fs.rm(file, { force: true }).catch(() => {})
      throw new Error(`chunk ${id} is damaged; removed, to be sent again`)
    }
    return data
  }

  /** Build `f` at `dest` from its chunks, checked; mode read-only. */
  async build(f: BatchFile, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
    await fs.rm(dest, { force: true })
    const whole = crypto.createHash('sha256')
    const fh = await fs.open(dest, 'w', 0o600)
    let size = 0
    try {
      for (const id of chunkIds(f)) {
        const data = await this.readChunk(id)
        whole.update(data)
        size += data.length
        await fh.write(data)
      }
      await fh.sync()
    } finally {
      await fh.close()
    }
    if (size !== f.size || whole.digest('hex') !== f.h) throw new Error(`${f.p} does not match its batch's hash`)
    await fs.chmod(dest, f.x ? EXEC_MODE : FILE_MODE)
  }

  async commit(manifest: BatchManifest, hooks: CommitHooks = {}): Promise<CommitResult> {
    return this.locked(() => this.commitNow(manifest, hooks))
  }

  private async commitNow(manifest: BatchManifest, hooks: CommitHooks): Promise<CommitResult> {
    const state = await readState(this.t)
    const expected = (state.current?.batch ?? 0) + 1
    if (manifest.batch !== expected) throw new Error(`batch ${manifest.batch} is not the next one (${expected})`)
    for (const f of manifest.files) safeRel(f.p)
    const before = new Map((await currentFiles(this.t, state)).map((f) => [f.p, f]))
    const next = new Map(manifest.files.map((f) => [f.p, f]))
    const puts = manifest.files.filter((f) => { const b = before.get(f.p); return !b || b.h !== f.h || !!b.x !== !!f.x })
    const dels = [...before.keys()].filter((p) => !next.has(p))
    const bytes = manifest.files.reduce((n, f) => n + f.size, 0)
    const now = new Date().toISOString()

    if (!puts.length && !dels.length && state.current) {
      // Nothing changed: only the position moves (no chunk, no file, no manifest written).
      await writeState(this.t, { ...state, current: { ...state.current, batch: manifest.batch, takenAt: manifest.takenAt, committedAt: now } })
      return { batch: manifest.batch, written: 0, deleted: 0, unchanged: true }
    }

    // Build the batch's new files beside the copy, each checked against its hash.
    await removeTree(this.t.apply)
    await fs.mkdir(this.t.applyNew, { recursive: true, mode: 0o700 })
    const slot = limiter(16)
    try {
      await Promise.all(puts.map((f) => slot(() => this.build(f, path.join(this.t.applyNew, f.p)))))
    } catch (err) {
      await removeTree(this.t.apply)
      throw err
    }
    await hooks.point?.('files-built')
    await writeDurable(manifestPath(this.t, manifest.batch), JSON.stringify(manifest))
    const journal: Journal = {
      batch: manifest.batch,
      steps: [...dels.map((p) => ({ p, op: 'del' as const, existed: true })), ...puts.map((f) => ({ p: f.p, op: 'put' as const, existed: before.has(f.p) }))],
    }
    await writeDurable(this.t.journal, JSON.stringify(journal))
    await hooks.point?.('journal-written')

    const opened = new Set<string>()
    try {
      let i = 0
      for (const step of journal.steps) {
        await this.swapIn(step, opened, hooks)
        if (++i === Math.ceil(journal.steps.length / 2)) await hooks.point?.('mid-swap')
      }
      for (const dir of opened) await fsyncPath(dir).catch(() => {})
      await hooks.point?.('swapped')
    } catch (err) {
      await closeDirs(opened)
      await this.rollBack(journal)
      throw err
    }
    await closeDirs(opened)

    // The one step: name the new batch current.
    await writeState(this.t, {
      ...state,
      current: { batch: manifest.batch, takenAt: manifest.takenAt, manifest: manifest.batch, fileCount: manifest.files.length, bytes, committedAt: now },
    })
    await hooks.point?.('state-written')
    await this.finish(journal, before, next)
    return { batch: manifest.batch, written: puts.length, deleted: dels.length, unchanged: false }
  }

  private async swapIn(step: JournalStep, opened: Set<string>, hooks: CommitHooks): Promise<void> {
    const dest = path.join(this.t.copy, step.p)
    await openDirs(this.t.copy, step.p, opened)
    if (step.existed) {
      const old = path.join(this.t.applyOld, step.p)
      await fs.mkdir(path.dirname(old), { recursive: true, mode: 0o700 })
      await fs.rename(dest, old).catch((err) => { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err })
    }
    if (step.op === 'put') {
      if (step.existed) await hooks.point?.('half-step')
      // A dir left where the new file goes (its files went in this batch's deletes) is empty now.
      const there = await fs.lstat(dest).catch(() => null)
      if (there?.isDirectory()) await removeEmptyDirs(dest)
      await fs.rename(path.join(this.t.applyNew, step.p), dest)
    }
  }

  /** Undo a swap that did not reach its state write: every path back to the previous batch. */
  private async rollBack(journal: Journal): Promise<void> {
    const opened = new Set<string>()
    for (const step of [...journal.steps].reverse()) {
      const dest = path.join(this.t.copy, step.p)
      const old = path.join(this.t.applyOld, step.p)
      const hasOld = await fs.lstat(old).then(() => true, () => false)
      if (hasOld) {
        await openDirs(this.t.copy, step.p, opened)
        await removeTree(dest)
        await fs.rename(old, dest)
      } else if (step.op === 'put' && !step.existed) {
        await openDirs(this.t.copy, step.p, opened)
        await removeTree(dest)
      }
      // A step that existed and has no pre-image never moved: the old file is still in place.
    }
    await closeDirs(opened)
    await removeTree(this.t.apply)
    await fs.rm(manifestPath(this.t, journal.batch), { force: true })
  }

  /** After the state write: record the new files' stats, drop what the batch replaced. */
  private async finish(journal: Journal, before: Map<string, BatchFile>, next: Map<string, BatchFile>): Promise<void> {
    const stats = await readCopyStats(this.t)
    for (const step of journal.steps) {
      if (step.op === 'del') { delete stats[step.p]; continue }
      const st = await fs.lstat(path.join(this.t.copy, step.p)).catch(() => null)
      if (st) stats[step.p] = copyStatOf(st)
    }
    await writeCopyStats(this.t, stats)
    await removeTree(this.t.apply)
    for (const step of journal.steps) if (step.op === 'del') await pruneEmptyParents(this.t.copy, step.p).catch(() => {})
    // Only the current batch's manifest stays.
    for (const name of await fs.readdir(this.t.batches).catch(() => [] as string[])) {
      if (name !== `${journal.batch}.json`) await fs.rm(path.join(this.t.batches, name), { force: true })
    }
    // Chunks only the replaced versions used.
    const keep = new Set<string>()
    for (const f of next.values()) for (const id of chunkIds(f)) keep.add(id)
    for (const step of journal.steps) {
      const old = before.get(step.p)
      if (!old) continue
      for (const id of chunkIds(old)) if (!keep.has(id)) await fs.rm(chunkPath(this.t, id), { force: true }).catch(() => {})
    }
  }

  /** Bring the target back to one complete batch after a crash (callers hold the lock). */
  private async recoverNow(): Promise<void> {
    const journal = await readJson<Journal>(this.t.journal).catch(() => null)
    if (!journal) {
      // Files built before the journal was written: never part of the copy.
      await removeTree(this.t.apply)
      return
    }
    const state = await readState(this.t)
    if (state.current?.batch === journal.batch && state.current.manifest === journal.batch) {
      const next = new Map((await currentFiles(this.t, state)).map((f) => [f.p, f]))
      await this.finish(journal, new Map(), next)
      return
    }
    await this.rollBack(journal)
  }
}
