/**
 * A verify pass over a standby copy: finds what was changed in copy/ directly (A3), saves it,
 * and puts the batch's version back.
 *
 * Each file of the current batch is compared with what commit wrote: its stat first (an edit,
 * a chmod or a replace moves the ctime or the inode), then, when the stat moved or `deep` is
 * asked, its content against the batch's sha256. A file whose content differs is copied to
 * drift/<time>/files/<path> and built again from its chunks; a file the batch does not have
 * is moved there; a file that is gone is built again. Nothing is overwritten unseen and no
 * edit stays in the copy. Each pass that finds drift writes one report (drift/<time>/report.json)
 * and hands it to `report` once (the server sends it to Walnut Health, never to the person).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { hashFile } from './chunks.js'
import { limiter } from './scan.js'
import { StandbyTarget } from './target.js'
import {
  DIR_MODE, EXEC_MODE, FILE_MODE, chunkPath, closeDirs, copyStatOf, currentFiles, listTree, openDirs, readCopyStats,
  readJson, readState, writeCopyStats, writeDurable, writeState, type CopyStat,
} from './target-files.js'
import { chunkIds, type BatchFile } from './types.js'

export type DriftKind = 'modified' | 'added' | 'deleted' | 'mode' | 'unrepaired'

export interface DriftItem {
  p: string
  kind: DriftKind
  /** Where the changed version was saved (relative to the target). */
  saved?: string
  detail?: string
}

export interface DriftReport {
  at: string
  batch: number
  items: DriftItem[]
  /** Set once the report reached Walnut Health. */
  reported?: string
}

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
const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-')

export async function verifyStandby(dir: string, opts: { deep?: boolean; now?: () => Date; report?: (r: DriftReport) => Promise<boolean> } = {}): Promise<VerifyResult> {
  const target = new StandbyTarget(dir)
  const started = performance.now()
  const result = await target.locked(async () => {
    const t = target.t
    const state = await readState(t)
    const out: VerifyResult = { batch: state.current?.batch ?? null, checked: 0, hashed: 0, drift: [], ms: 0 }
    const files = await currentFiles(t, state)
    const stats = await readCopyStats(t)
    const at = (opts.now ?? (() => new Date()))()
    const driftDir = path.join(t.drift, stamp(at))
    const save = async (rel: string, how: 'copy' | 'move'): Promise<string> => {
      const dest = path.join(driftDir, 'files', rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      if (how === 'move') await fs.rename(path.join(t.copy, rel), dest)
      else await fs.copyFile(path.join(t.copy, rel), dest)
      await fs.chmod(dest, 0o644).catch(() => {})
      return path.relative(t.root, dest)
    }
    const opened = new Set<string>()
    const rebuild = async (f: BatchFile, item: DriftItem): Promise<void> => {
      try {
        await openDirs(t.copy, f.p, opened)
        const tmp = path.join(path.dirname(path.join(t.copy, f.p)), `.${path.basename(f.p)}.standby-repair`)
        await target.build(f, tmp)
        await fs.rename(tmp, path.join(t.copy, f.p))
        stats[f.p] = copyStatOf(await fs.lstat(path.join(t.copy, f.p)))
      } catch (err) {
        out.drift.push({ ...item, kind: 'unrepaired', detail: `${item.kind}: ${err instanceof Error ? err.message : String(err)}` })
        return
      }
      out.drift.push(item)
    }

    const known = new Set(files.map((f) => f.p))
    const tree = await listTree(t.copy)
    const slot = limiter(64)
    const toRepair: Array<{ f: BatchFile; kind: 'modified' | 'deleted' | 'mode' }> = []
    await Promise.all(files.map((f) => slot(async () => {
      out.checked++
      const st = await fs.lstat(path.join(t.copy, f.p)).catch(() => null)
      if (!st || !st.isFile()) { toRepair.push({ f, kind: 'deleted' }); return }
      const now = copyStatOf(st)
      if (!opts.deep && sameCopyStat(stats[f.p], now)) return
      out.hashed++
      const { h, size } = await hashFile(path.join(t.copy, f.p))
      if (h !== f.h || size !== f.size) { toRepair.push({ f, kind: 'modified' }); return }
      if ((st.mode & 0o777) !== (f.x ? EXEC_MODE : FILE_MODE)) { toRepair.push({ f, kind: 'mode' }); return }
      stats[f.p] = now
    })))
    toRepair.sort((a, b) => (a.f.p < b.f.p ? -1 : 1))
    for (const { f, kind } of toRepair) {
      const item: DriftItem = { p: f.p, kind }
      if (kind === 'modified') {
        await openDirs(t.copy, f.p, opened)
        item.saved = await save(f.p, 'copy')
      }
      // A non-file where a file belongs (a dir, a link) is moved aside first.
      const there = await fs.lstat(path.join(t.copy, f.p)).catch(() => null)
      if (there && !there.isFile()) {
        await openDirs(t.copy, f.p, opened)
        item.saved = await save(f.p, 'move')
      }
      await rebuild(f, item)
    }
    for (const rel of [...tree.files, ...tree.others].filter((p) => !known.has(p)).sort()) {
      await openDirs(t.copy, rel, opened)
      out.drift.push({ p: rel, kind: 'added', saved: await save(rel, 'move') })
      delete stats[rel]
    }
    await closeDirs(opened)
    await fs.chmod(t.copy, DIR_MODE).catch(() => {})
    await writeCopyStats(t, stats)
    if (out.drift.length) {
      const report: DriftReport = { at: at.toISOString(), batch: out.batch ?? 0, items: out.drift }
      await writeDurable(path.join(driftDir, 'report.json'), JSON.stringify(report, null, 2))
      out.reportDir = path.relative(t.root, driftDir)
    }
    await writeState(t, { ...state, lastVerify: { at: at.toISOString(), drift: out.drift.length, deep: !!opts.deep } })
    if (opts.deep) await collectChunks(t.chunks, files, chunkPath.bind(null, t))
    return out
  })
  result.ms = performance.now() - started
  if (opts.report) await reportPendingDrift(dir, opts.report)
  return result
}

/** Remove chunks no file of the current batch uses (left by a crash between the state write and the cleanup). */
async function collectChunks(root: string, files: BatchFile[], where: (id: string) => string): Promise<void> {
  const keep = new Set<string>()
  for (const f of files) for (const id of chunkIds(f)) keep.add(path.relative(root, where(id)))
  for (const rel of (await listTree(root)).files) if (!keep.has(rel)) await fs.rm(path.join(root, rel), { force: true }).catch(() => {})
}

/** Hand every drift report not yet reported to `report`, once each (a CLI pass leaves its reports for the server). */
export async function reportPendingDrift(dir: string, report: (r: DriftReport) => Promise<boolean>): Promise<number> {
  const target = new StandbyTarget(dir)
  const names = await fs.readdir(target.t.drift).catch(() => [] as string[])
  let sent = 0
  for (const name of names.sort()) {
    const file = path.join(target.t.drift, name, 'report.json')
    const r = await readJson<DriftReport>(file).catch(() => null)
    if (!r || r.reported) continue
    if (!await report(r).catch(() => false)) continue
    await writeDurable(file, JSON.stringify({ ...r, reported: new Date().toISOString() }, null, 2))
    sent++
  }
  return sent
}
