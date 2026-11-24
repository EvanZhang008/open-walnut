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
 *
 * Before the swap, every path the batch replaces or removes is checked against what the last
 * commit wrote there (copy-stat.json): a direct edit is saved to drift/ first (drift.ts), so a
 * commit never drops one silently, and an entry that is not a dir on the way to a path (a link
 * put there) is moved aside, so nothing is written through it.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { withFileLock } from '../../utils/file-lock.js'
import { log } from '../../logging/index.js'
import { keptDirs, removeStaleDirs, sameDirs } from './batch-dirs.js'
import { saveDirectEdits, type JournalStep } from './target-edits.js'
import { CHUNK_BYTES, hashFile, sha256 } from './chunks.js'
import { limiter } from './scan.js'
import {
  EXEC_MODE, FILE_MODE, OPEN_DIR_MODE, chunkPath, closeDirs, copyStatOf, currentBatch, currentFiles, fsyncPath, manifestPath, openDirs,
  pruneEmptyParents, readCopyStats, readJson, readState, removeEmptyDirs, removeTree, safeRel, targetPaths, writeCopyStats, writeDurable, writeState,
  type TargetPaths,
} from './target-files.js'
import { chunkIds, type BatchFile, type BatchManifest, type CommitResult, type StandbyState } from './types.js'

/** A file of at least this many chunks is made from the last batch's copy, its changed chunks written. */
const PATCH_MIN_CHUNKS = 2

interface Journal {
  batch: number
  steps: JournalStep[]
}

export interface CommitHooks {
  /** Called at each named point of a commit (tests stop the process there). */
  point?: (name: 'cloned' | 'files-built' | 'journal-written' | 'half-step' | 'mid-swap' | 'swapped' | 'state-written') => Promise<void> | void
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
      // On disk before its name: a chunk lost to a power cut after the rename would never be sent again.
      try { await fh.writeFile(data); await fh.sync() } finally { await fh.close() }
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

  /**
   * Build `f` at `dest` from the last batch's file `old` in the copy (`src`): clone it (APFS and
   * reflink filesystems share the blocks; elsewhere the kernel copies them), write only the
   * chunks that differ, cut it to size, then check the whole file against its hash. Only for a
   * copy file still as commit wrote it (copy-stat), so the chunks it keeps are the batch's.
   * Returns the bytes written by hand.
   */
  async buildPatched(f: BatchFile, old: BatchFile, src: string, dest: string, hooks: CommitHooks = {}): Promise<number> {
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
    await fs.rm(dest, { force: true })
    await fs.copyFile(src, dest, fs.constants.COPYFILE_FICLONE)
    await fs.chmod(dest, 0o600)
    await hooks.point?.('cloned')
    const was = chunkIds(old)
    const now = chunkIds(f)
    let written = 0
    const fh = await fs.open(dest, 'r+')
    try {
      for (let i = 0; i < now.length; i++) {
        if (was[i] === now[i]) continue
        const data = await this.readChunk(now[i])
        await fh.write(data, 0, data.length, i * CHUNK_BYTES)
        written += data.length
      }
      await fh.truncate(f.size)
      await fh.sync()
    } finally {
      await fh.close()
    }
    const { h, size } = await hashFile(dest)
    if (size !== f.size || h !== f.h) throw new Error(`${f.p} does not match its batch's hash`)
    await fs.chmod(dest, f.x ? EXEC_MODE : FILE_MODE)
    return written
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
    for (const d of manifest.dirs ?? []) safeRel(d)
    const was = await currentBatch(this.t, state)
    const before = new Map(was.files.map((f) => [f.p, f]))
    const next = new Map(manifest.files.map((f) => [f.p, f]))
    const puts = manifest.files.filter((f) => { const b = before.get(f.p); return !b || b.h !== f.h || !!b.x !== !!f.x })
    const dels = [...before.keys()].filter((p) => !next.has(p))
    const bytes = manifest.files.reduce((n, f) => n + f.size, 0)
    const now = new Date().toISOString()

    if (!puts.length && !dels.length && sameDirs(was.dirs, manifest.dirs) && state.current) {
      // Nothing changed: only the position moves (no chunk, no file, no manifest written).
      await writeState(this.t, { ...state, current: { ...state.current, batch: manifest.batch, takenAt: manifest.takenAt, committedAt: now } })
      return { batch: manifest.batch, written: 0, deleted: 0, unchanged: true }
    }

    // Build the batch's new files beside the copy, each checked against its hash.
    await removeTree(this.t.apply)
    await fs.mkdir(this.t.applyNew, { recursive: true, mode: 0o700 })
    const slot = limiter(16)
    const copyStats = await readCopyStats(this.t)
    let patched = 0
    let patchFailed = 0
    let bytesWritten = 0
    // Every build ends before any failure is judged: a cleanup while others still write into
    // .apply/new fails (ENOTEMPTY) and hides the failure that started it.
    const built = await Promise.allSettled(puts.map((f) => slot(async () => {
        const dest = path.join(this.t.applyNew, f.p)
        const old = before.get(f.p)
        if (old && chunkIds(old).length >= PATCH_MIN_CHUNKS && chunkIds(f).length >= PATCH_MIN_CHUNKS) {
          const src = path.join(this.t.copy, f.p)
          const st = await fs.lstat(src).catch(() => null)
          const was = copyStats[f.p]
          if (st?.isFile() && was && copyStatOf(st).every((v, i) => v === was[i])) {
            try {
              bytesWritten += await this.buildPatched(f, old, src, dest, hooks)
              patched++
              return
            } catch (err) {
              // A patch that does not come out as the batch's file: build it whole instead.
              patchFailed++
              log.session.warn('standby: a patched file did not match its hash; building it whole', { path: f.p, error: String(err) })
            }
          }
        }
        await this.build(f, dest)
        bytesWritten += f.size
      })))
    const failed = built.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      await removeTree(this.t.apply)
      throw failed.reason
    }
    await hooks.point?.('files-built')
    const journal: Journal = {
      batch: manifest.batch,
      steps: [...dels.map((p) => ({ p, op: 'del' as const, existed: true })), ...puts.map((f) => ({ p: f.p, op: 'put' as const, existed: before.has(f.p) }))],
    }
    try {
      await saveDirectEdits(this.t, journal.steps, before, was.dirs, manifest.batch)
    } catch (err) {
      await removeTree(this.t.apply)
      throw err
    }
    await writeDurable(manifestPath(this.t, manifest.batch), JSON.stringify(manifest))
    await writeDurable(this.t.journal, JSON.stringify(journal))
    await hooks.point?.('journal-written')

    const opened = new Set<string>()
    try {
      let i = 0
      for (const step of journal.steps) {
        await this.swapIn(step, opened, hooks)
        if (++i === Math.ceil(journal.steps.length / 2)) await hooks.point?.('mid-swap')
      }
      // The batch's empty dirs, before the state write names it (a crash before leaves at most an
      // empty dir more, which verify removes).
      for (const d of manifest.dirs ?? []) await openDirs(this.t.copy, `${d}/.`, opened)
      for (const dir of opened) await fsyncPath(dir).catch(() => {})
      await hooks.point?.('swapped')
    } catch (err) {
      await closeDirs(opened)
      await this.rollBack(journal)
      throw err
    }
    await closeDirs(opened)

    // The one step: name the new batch current.
    try {
      await writeState(this.t, {
        ...state,
        current: { batch: manifest.batch, takenAt: manifest.takenAt, manifest: manifest.batch, fileCount: manifest.files.length, bytes, committedAt: now },
      })
    } catch (err) {
      // The write may have landed before it failed (the dir's fsync): only a state that still
      // names the previous batch is rolled back.
      if ((await readState(this.t).catch(() => state)).current?.batch !== manifest.batch) {
        await this.rollBack(journal)
        throw err
      }
    }
    await hooks.point?.('state-written')
    // The batch is current: a cleanup that fails is finished by the next caller's recovery.
    await this.finish(journal, before, next, manifest.dirs ?? [], was.dirs).catch((err) => log.session.warn('standby: cleanup after commit failed', { error: String(err) }))
    return { batch: manifest.batch, written: puts.length, deleted: dels.length, unchanged: false, patched, patchFailed, bytesWritten }
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
      } else if (step.op === 'put' && !step.existed && (await fs.lstat(dest).catch(() => null))?.isFile()) {
        // Only the file the swap put: a dir there is the previous batch's, not yet replaced.
        await openDirs(this.t.copy, step.p, opened)
        await removeTree(dest)
      }
      // A step that existed and has no pre-image never moved: the old file is still in place.
    }
    // The previous batch's dirs: the swap removed one where this batch put a file.
    const { dirs } = await currentBatch(this.t, await readState(this.t))
    for (const d of dirs) await openDirs(this.t.copy, `${d}/.`, opened)
    await closeDirs(opened)
    await removeTree(this.t.apply)
    await fs.rm(manifestPath(this.t, journal.batch), { force: true })
  }

  /** After the state write: record the new files' stats, drop what the batch replaced. */
  private async finish(journal: Journal, before: Map<string, BatchFile>, next: Map<string, BatchFile>, dirs: string[], dirsBefore: string[]): Promise<void> {
    const stats = await readCopyStats(this.t)
    for (const step of journal.steps) {
      if (step.op === 'del') { delete stats[step.p]; continue }
      const st = await fs.lstat(path.join(this.t.copy, step.p)).catch(() => null)
      if (st) stats[step.p] = copyStatOf(st)
    }
    await writeCopyStats(this.t, stats)
    await removeTree(this.t.apply)
    // A delete leaves no empty dir the batch does not list; one it lists stays.
    const kept = keptDirs(dirs)
    for (const step of journal.steps) if (step.op === 'del') await pruneEmptyParents(this.t.copy, step.p, kept).catch(() => {})
    await removeStaleDirs(this.t.copy, dirsBefore, kept, next.keys())
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

  /**
   * Empty the target: every batch it holds goes (standby.json, manifests, chunks, the copy and
   * its stats), drift/ stays. A sender after it finds no batch and sends a whole one. Under the
   * target's lock; `refuse(state)` read there says why not (null: go on). Each entry is first
   * renamed into `.discard-<time>/` in the target, standby.json first, then that folder removed:
   * a failure or a kill leaves either the old target or a `.discard-*` folder that
   * finishDiscard completes. A top-level entry that is a link (or resolves outside the target) is
   * refused and left as it is; below, removeTree removes a link as a link and never follows it.
   */
  async discard(refuse: (s: StandbyState) => string | null): Promise<{ ok: true; bytes: number; refused: string[] } | { ok: false; why: string }> {
    return this.locked(async () => {
      const s = await readState(this.t)
      const why = refuse(s)
      if (why) return { ok: false as const, why }
      const bin = path.join(this.t.root, `.discard-${Date.now()}`)
      await fs.mkdir(bin, { mode: OPEN_DIR_MODE })
      const refused = await this.moveBatchesInto(bin)
      await this.removeBins()
      return { ok: true as const, bytes: s.current?.bytes ?? 0, refused }
    })
  }

  /**
   * What a discard that failed or was killed partway left: with no standby.json (it goes first),
   * the batch entries still there join its `.discard-*` folder, then those folders go. A target
   * with no such folder is not touched (a sender's first batch may be arriving). True when there
   * was one.
   */
  async finishDiscard(): Promise<boolean> {
    if (!(await this.bins()).length) return false
    await this.locked(async () => {
      const bins = await this.bins()
      if (!bins.length) return
      const stateThere = await fs.lstat(this.t.state).then(() => true, () => false)
      if (!stateThere) await this.moveBatchesInto(bins[0]!)
      await this.removeBins()
    })
    return true
  }

  /** The `.discard-*` folders of this target (real folders only). */
  private async bins(): Promise<string[]> {
    const out: string[] = []
    for (const name of (await fs.readdir(this.t.root).catch(() => [] as string[])).sort()) {
      if (!/^\.discard-\d+$/.test(name)) continue
      const p = path.join(this.t.root, name)
      if ((await fs.lstat(p).catch(() => null))?.isDirectory()) out.push(p)
    }
    return out
  }

  private async removeBins(): Promise<void> {
    for (const p of await this.bins()) await removeTree(p)
  }

  /**
   * Rename the batch entries (standby.json first) into `bin`, a folder of this target. Only real
   * entries inside the real root move; a link, or one that resolves outside, is refused (named).
   */
  private async moveBatchesInto(bin: string): Promise<string[]> {
    const root = await fs.realpath(this.t.root)
    const refused: string[] = []
    for (const p of [this.t.state, this.t.batches, this.t.chunks, this.t.copy, this.t.copyStat, this.t.apply]) {
      const st = await fs.lstat(p).catch(() => null)
      if (!st) continue
      if (st.isSymbolicLink() || !(await fs.realpath(p)).startsWith(`${root}${path.sep}`)) { refused.push(path.basename(p)); continue }
      if (st.isDirectory()) await fs.chmod(p, OPEN_DIR_MODE).catch(() => {})
      await fs.rename(p, path.join(bin, path.basename(p)))
      if (p === this.t.state) await fsyncPath(this.t.root)
    }
    return refused
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
      const now = await currentBatch(this.t, state)
      await this.finish(journal, new Map(), new Map(now.files.map((f) => [f.p, f])), now.dirs, [])
      return
    }
    await this.rollBack(journal)
  }
}
