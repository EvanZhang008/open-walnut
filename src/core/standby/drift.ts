/**
 * What was changed in a standby copy directly, saved before anything puts the batch's version
 * back: drift/<time>/files/<path> holds the changed versions, drift/<time>/report.json lists
 * them. Both the verify pass (verify.ts) and a commit that is about to replace an edited file
 * (target.ts) record drift this way; the server hands each report to Walnut Health once.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { readJson, writeDurable, type TargetPaths } from './target-files.js'

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

const stamp = (d: Date): string => d.toISOString().replace(/[:.]/g, '-')

export class DriftRecorder {
  readonly items: DriftItem[] = []
  readonly dir: string
  constructor(private readonly t: TargetPaths, readonly at: Date, suffix = '') {
    this.dir = path.join(t.drift, stamp(at) + suffix)
  }

  /** Save `rel` of the copy (a copy of a file, or the entry itself moved: a link, a dir); returns where. */
  async save(rel: string, how: 'copy' | 'move'): Promise<string> {
    let dest = path.join(this.dir, 'files', rel)
    for (let n = 1; await fs.lstat(dest).then(() => true, () => false); n++) dest = path.join(this.dir, 'files', `${rel}.${n}`)
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 })
    const src = path.join(this.t.copy, rel)
    if (how === 'move') await fs.rename(src, dest)
    else await fs.copyFile(src, dest)
    // What is saved belongs to the person now: owner read and write, so it can be read and removed.
    await ownerWritable(dest)
    return path.relative(this.t.root, dest)
  }

  add(item: DriftItem): void {
    this.items.push(item)
  }

  /** Write the report when there is anything in it; returns its dir (relative to the target). */
  async write(batch: number): Promise<string | undefined> {
    if (!this.items.length) return undefined
    const report: DriftReport = { at: this.at.toISOString(), batch, items: this.items }
    await writeDurable(path.join(this.dir, 'report.json'), JSON.stringify(report, null, 2))
    return path.relative(this.t.root, this.dir)
  }
}

async function ownerWritable(p: string): Promise<void> {
  const st = await fs.lstat(p).catch(() => null)
  if (!st || st.isSymbolicLink()) return
  if (!st.isDirectory()) { await fs.chmod(p, 0o600).catch(() => {}); return }
  await fs.chmod(p, 0o700).catch(() => {})
  for (const name of await fs.readdir(p).catch(() => [] as string[])) await ownerWritable(path.join(p, name))
}

/** Hand every drift report not yet reported to `report`, once each. */
export async function reportPendingDrift(t: TargetPaths, report: (r: DriftReport) => Promise<boolean>): Promise<number> {
  const names = await fs.readdir(t.drift).catch(() => [] as string[])
  let sent = 0
  for (const name of names.sort()) {
    const file = path.join(t.drift, name, 'report.json')
    const r = await readJson<DriftReport>(file).catch(() => null)
    if (!r || r.reported) continue
    if (!await report(r).catch(() => false)) continue
    await writeDurable(file, JSON.stringify({ ...r, reported: new Date().toISOString() }, null, 2))
    sent++
  }
  return sent
}
