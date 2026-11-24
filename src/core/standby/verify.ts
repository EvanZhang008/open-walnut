/**
 * A verify pass over a standby copy: finds what was changed in copy/ directly (A3), saves it,
 * and puts the batch's version back.
 *
 * Order matters, so nothing is ever written through an entry someone put there:
 *   1. every entry that is neither a file nor a dir (a link, a socket), every dir where a file
 *      of the batch belongs, and every dir no file of the batch lies under is moved to
 *      drift/<time>/files/ as it is (a link is moved, never followed); such a dir holding no
 *      file is removed quietly, as is a repair's temp file a crash left;
 *   2. every other file the batch does not have is moved there too;
 *   3. each file of the batch is compared with what commit wrote: its stat first (an edit, a
 *      chmod or a replace moves the ctime or the inode), then, when the stat moved or `deep` is
 *      asked, its content against the batch's sha256. A file whose content differs is copied
 *      to drift and built again from its chunks; a file that is gone is built again; a file it
 *      cannot read is opened (chmod) and read, or moved to drift and built again;
 *   4. every dir gets its read-only mode back (quietly: the edit in it is what is reported).
 * Each pass that finds drift writes one report (drift/<time>/report.json, drift.ts) and hands
 * it to `report` once (the server sends it to Walnut Health, never to the person).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { keptDirs } from './batch-dirs.js'
import { hashFile } from './chunks.js'
import { DriftRecorder, reportPendingDrift as reportPending, type DriftItem, type DriftReport } from './drift.js'
import { limiter } from './scan.js'
import { StandbyTarget } from './target.js'
import {
  DIR_MODE, EXEC_MODE, FILE_MODE, chunkPath, closeDirs, copyStatOf, currentBatch, listTree, openDirs, readCopyStats,
  readState, removeTree, targetPaths, writeCopyStats, writeState, type CopyStat,
} from './target-files.js'
import { chunkIds, type BatchFile } from './types.js'

export type { DriftItem, DriftKind, DriftReport } from './drift.js'

export interface VerifyResult {
  batch: number | null
  checked: number
  hashed: number
  drift: DriftItem[]
  /** drift/<time>/ of this pass, when it found drift. */
  reportDir?: string
  ms: number
}

const sameCopyStat = (a: CopyStat | undefined, b: CopyStat): boolean => !!a && a.every((v, i) => v === b[i])
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function verifyStandby(dir: string, opts: { deep?: boolean; now?: () => Date; report?: (r: DriftReport) => Promise<boolean> } = {}): Promise<VerifyResult> {
  const target = new StandbyTarget(dir)
  const started = performance.now()
  const result = await target.locked(async () => {
    const t = target.t
    const state = await readState(t)
    const out: VerifyResult = { batch: state.current?.batch ?? null, checked: 0, hashed: 0, drift: [], ms: 0 }
    const { files, dirs } = await currentBatch(t, state)
    const stats = await readCopyStats(t)
    const rec = new DriftRecorder(t, (opts.now ?? (() => new Date()))())
    const opened = new Set<string>()
    const known = new Set(files.map((f) => f.p))
    // Dirs some file of the batch lies under.
    const needed = new Set<string>()
    for (const f of files) for (let d = path.posix.dirname(f.p); d !== '.'; d = path.posix.dirname(d)) needed.add(d)
    for (const d of keptDirs(dirs)) needed.add(d)

    const moveAside = async (rel: string, item: Omit<DriftItem, 'saved'>): Promise<void> => {
      try {
        await openDirs(t.copy, rel, opened)
        rec.add({ ...item, saved: await rec.save(rel, 'move') })
      } catch (err) {
        rec.add({ ...item, kind: 'unrepaired', detail: `${item.kind}: ${errText(err)}` })
      }
      delete stats[rel]
    }

    // 1. What is not a plain file or a needed dir, top-down (a moved dir takes what is in it).
    const tree = await listTree(t.copy, opened)
    const wrongModeDirs = tree.dirs.filter((d) => d.mode !== DIR_MODE && !opened.has(path.join(t.copy, d.rel)))
    const movedDirs: string[] = []
    const under = (rel: string) => movedDirs.some((d) => rel.startsWith(`${d}/`))
    for (const rel of tree.others.sort()) await moveAside(rel, { p: rel, kind: 'added', detail: 'not a file or dir' })
    const holdsEntries = (dir: string) => tree.files.some((p) => p.startsWith(`${dir}/`)) || tree.others.some((p) => p.startsWith(`${dir}/`))
    for (const d of [...tree.dirs].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      if (under(d.rel) || needed.has(d.rel)) continue
      movedDirs.push(d.rel)
      if (!known.has(d.rel) && !holdsEntries(d.rel)) {
        // Empty (a crash between a dir's making and its file's swap leaves one): nothing to save.
        await openDirs(t.copy, d.rel, opened).then(() => removeTree(path.join(t.copy, d.rel))).catch(() => {})
        continue
      }
      await moveAside(d.rel, known.has(d.rel) ? { p: d.rel, kind: 'modified', detail: 'a dir where the file belongs' } : { p: `${d.rel}/`, kind: 'added' })
    }
    // 2. Files the batch does not have (a repair's temp file a crash left is removed quietly).
    for (const rel of tree.files.filter((p) => !known.has(p) && !under(p)).sort()) {
      const m = /^(.*\/)?\.(.+)\.standby-repair$/.exec(rel)
      if (m && known.has(`${m[1] ?? ''}${m[2]}`)) {
        await openDirs(t.copy, rel, opened).then(() => fs.rm(path.join(t.copy, rel), { force: true })).catch(() => {})
        continue
      }
      await moveAside(rel, { p: rel, kind: 'added' })
    }
    // The batch's empty dirs: one gone from the copy is made again.
    for (const d of dirs) {
      if ((await fs.lstat(path.join(t.copy, d)).catch(() => null))?.isDirectory()) continue
      try {
        await openDirs(t.copy, `${d}/.`, opened)
        rec.add({ p: `${d}/`, kind: 'deleted' })
      } catch (err) {
        rec.add({ p: `${d}/`, kind: 'unrepaired', detail: `deleted: ${errText(err)}` })
      }
    }
    // A dir's mode is put back quietly: opening a dir is how anyone edits a file in it, and the
    // edit itself is what is reported.
    for (const d of wrongModeDirs) if (!under(d.rel) && !movedDirs.includes(d.rel)) opened.add(path.join(t.copy, d.rel))

    // 3. Each file of the batch.
    const slot = limiter(64)
    const toRepair: Array<{ f: BatchFile; kind: 'modified' | 'deleted' | 'mode'; how?: 'copy' | 'move'; detail?: string }> = []
    await Promise.all(files.map((f) => slot(async () => {
      out.checked++
      const abs = path.join(t.copy, f.p)
      const st = await fs.lstat(abs).catch(() => null)
      if (!st || !st.isFile()) { toRepair.push({ f, kind: 'deleted' }); return }
      const now = copyStatOf(st)
      if (!opts.deep && sameCopyStat(stats[f.p], now)) return
      out.hashed++
      let got: { h: string; size: number }
      try {
        got = await hashFile(abs).catch(async (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'EACCES') throw err
          await fs.chmod(abs, FILE_MODE)
          return hashFile(abs)
        })
      } catch (err) {
        toRepair.push({ f, kind: 'modified', how: 'move', detail: `could not read it: ${errText(err)}` })
        return
      }
      if (got.h !== f.h || got.size !== f.size) { toRepair.push({ f, kind: 'modified', how: 'copy' }); return }
      if ((st.mode & 0o777) !== (f.x ? EXEC_MODE : FILE_MODE)) { toRepair.push({ f, kind: 'mode' }); return }
      stats[f.p] = now
    })))
    toRepair.sort((a, b) => (a.f.p < b.f.p ? -1 : 1))
    for (const { f, kind, how, detail } of toRepair) {
      const item: DriftItem = { p: f.p, kind, ...(detail ? { detail } : {}) }
      try {
        await openDirs(t.copy, f.p, opened)
        if (how) item.saved = await rec.save(f.p, how)
        const dest = path.join(t.copy, f.p)
        const tmp = path.join(path.dirname(dest), `.${path.basename(f.p)}.standby-repair`)
        await target.build(f, tmp)
        await fs.rename(tmp, dest)
        stats[f.p] = copyStatOf(await fs.lstat(dest))
        rec.add(item)
      } catch (err) {
        rec.add({ ...item, kind: 'unrepaired', detail: `${kind}: ${errText(err)}` })
      }
    }

    // 4. Modes back.
    await closeDirs(opened)
    await fs.chmod(t.copy, DIR_MODE).catch(() => {})
    await writeCopyStats(t, stats)
    out.drift = rec.items
    out.reportDir = await rec.write(out.batch ?? 0)
    const at = rec.at.toISOString()
    await writeState(t, { ...state, lastVerify: { at, drift: out.drift.length, deep: !!opts.deep } })
    if (opts.deep) await collectChunks(t.chunks, files, chunkPath.bind(null, t), rec.at.getTime())
    return out
  })
  result.ms = performance.now() - started
  if (opts.report) await reportPendingDrift(dir, opts.report)
  return result
}

/**
 * A chunk no file of the current batch uses, written this recently, is kept: a batch cut off
 * part way (its link went) sent it, and the next batch takes it instead of sending it again.
 */
export const ORPHAN_CHUNK_KEEP_MS = 6 * 60 * 60_000

/**
 * Remove chunks no file of the current batch uses (left by a crash between the state write and
 * the cleanup, or sent for a batch that never came), once they are older than ORPHAN_CHUNK_KEEP_MS.
 */
async function collectChunks(root: string, files: BatchFile[], where: (id: string) => string, now: number): Promise<void> {
  const keep = new Set<string>()
  for (const f of files) for (const id of chunkIds(f)) keep.add(path.relative(root, where(id)))
  for (const rel of (await listTree(root)).files) {
    if (keep.has(rel)) continue
    const st = await fs.lstat(path.join(root, rel)).catch(() => null)
    if (st && now - st.mtimeMs > ORPHAN_CHUNK_KEEP_MS) await fs.rm(path.join(root, rel), { force: true }).catch(() => {})
  }
}

/** Hand every drift report not yet reported to `report`, once each (a CLI pass or a commit leaves its reports for the server). */
export function reportPendingDrift(dir: string, report: (r: DriftReport) => Promise<boolean>): Promise<number> {
  return reportPending(targetPaths(path.resolve(dir)), report)
}
