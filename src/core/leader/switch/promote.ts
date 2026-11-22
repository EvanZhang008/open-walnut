/**
 * The standby copy becomes the new leader's data home, the way a restored backup does at
 * boot (src/core/backup/restore-switch.ts): one rename, the old folder kept beside it.
 *
 *   1. a folder already at the new home's path is moved aside to `<home>.before-<switch>`
 *      (kept, never deleted);
 *   2. `local/leader-switch/promoted.json` ('promoting') goes into the copy first, then
 *      `<standby>/copy` is renamed to the home (same filesystem: one step, no copy), so the
 *      home is marked from the instant it exists: a rerun after a kill anywhere from here on
 *      knows it as this switch's, and a server started on it by hand refuses (records.ts);
 *   3. the copy's read-only modes (files 0400, dirs 0500) become the owner's read-write;
 *   4. what names the old home's path is rewritten to the new one: the applied-ops ledger's
 *      `home` column (cache/applied-ops.sqlite: without it every op id the old leader applied
 *      would apply again here) and `standby.dir` in config.yaml (the new leader's batches go
 *      to the old leader's machine, for the switch back);
 *   5. promoted.json becomes 'promoted' (the switch's commit makes it 'led').
 * Every step is safe to run again after a kill.
 *
 * The standby target keeps its chunks and manifests; its `copy/` is gone until its next
 * verify pass builds it again from the chunks (verify.ts: a missing file is built again).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import Database from '../../../lib/sqlite.js'
import { readPromoted, writePromoted } from './records.js'

export interface PromoteInput {
  switchId: string
  standbyDir: string
  home: string
  /** The old leader's home path, as its data names it. */
  previousHome: string
  /** Where the new leader sends its standby batches: the old leader machine's standby_dir. */
  reverseStandbyDir: string
  /** Tests only: leave the ledger as the old home wrote it (shows what the rewrite is for). */
  skipLedgerRewrite?: boolean
  /** Tests only: called right after the copy's rename (the rehearsal kills the switch there). */
  afterRename?: () => void
}

export interface PromoteResult {
  /** The folder that was at the home's path, moved aside. */
  movedAside?: string
  ledgerRows: number
  alreadyDone: boolean
}

export function promotedBy(home: string): string | null {
  return readPromoted(home)?.switchId ?? null
}

/**
 * Owner read-write on every dir and file (executables keep their x). Many at a time: a home of
 * 100k files is otherwise seconds of downtime spent in one chmod after another.
 */
async function makeWritable(root: string): Promise<void> {
  const queue: string[] = [root]
  const work = async (): Promise<void> => {
    for (let p = queue.pop(); p !== undefined; p = queue.pop()) {
      const st = await fsp.lstat(p)
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        await fsp.chmod(p, 0o700)
        for (const e of await fsp.readdir(p)) queue.push(path.join(p, e))
      } else if (st.isFile()) {
        await fsp.chmod(p, (st.mode & 0o100) ? 0o700 : 0o600)
      }
    }
  }
  // Workers end when the queue is momentarily empty; run rounds until no work is left.
  while (queue.length) await Promise.all(Array.from({ length: 32 }, work))
}

/** Rewrite the ledger's home column; rows already under the new home win. */
export function rewriteLedgerHome(home: string, from: string, to: string): number {
  const file = path.join(home, 'cache', 'applied-ops.sqlite')
  if (!fs.existsSync(file) || from === to) return 0
  const db = new Database(file)
  try {
    let n = 0
    db.exec('BEGIN IMMEDIATE')
    for (const table of ['applied_ops', 'create_remap']) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
      if (!exists) continue
      n += Number(db.prepare(`UPDATE OR IGNORE ${table} SET home = ? WHERE home = ?`).run(to, from).changes ?? 0)
      db.prepare(`DELETE FROM ${table} WHERE home = ?`).run(from)
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

/** Point config.yaml's standby.dir at `dir`, keeping the rest of the file as it is. */
export function rewriteStandbyDir(home: string, dir: string): void {
  const file = path.join(home, 'config.yaml')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const doc = YAML.parseDocument(text)
  doc.setIn(['standby', 'dir'], dir)
  const tmp = `${file}.switch.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try { fs.writeSync(fd, String(doc)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
}

export async function promoteCopy(o: PromoteInput): Promise<PromoteResult> {
  const copy = path.join(o.standbyDir, 'copy')
  let movedAside: string | undefined
  const done = fs.existsSync(o.home) && promotedBy(o.home) === o.switchId
  if (!done) {
    if (fs.existsSync(o.home)) {
      if (!fs.existsSync(copy)) throw new Error(`the standby copy ${copy} is gone and ${o.home} is not this switch's`)
      movedAside = `${o.home}.before-${o.switchId}`
      if (fs.existsSync(movedAside)) throw new Error(`${movedAside} already exists`)
      await fsp.rename(o.home, movedAside)
    }
    if (!fs.existsSync(o.home)) {
      if (!fs.existsSync(copy)) throw new Error(`the standby copy ${copy} is gone`)
      await fsp.mkdir(path.dirname(o.home), { recursive: true })
      // Moving a dir to another parent rewrites its '..': the copy's own 0500 must allow it.
      await fsp.chmod(copy, 0o700)
      // The mark goes in before the rename (local/ is this machine's, never in a batch).
      if (fs.existsSync(path.join(copy, 'local'))) await fsp.chmod(path.join(copy, 'local'), 0o700)
      writePromoted(copy, { switchId: o.switchId, state: 'promoting', from: o.previousHome, at: new Date().toISOString() })
      await fsp.rename(copy, o.home)
      o.afterRename?.()
    }
  }
  await makeWritable(o.home)
  const ledgerRows = o.skipLedgerRewrite ? 0 : rewriteLedgerHome(o.home, path.resolve(o.previousHome), path.resolve(o.home))
  rewriteStandbyDir(o.home, o.reverseStandbyDir)
  writePromoted(o.home, { switchId: o.switchId, state: 'promoted', from: o.previousHome, at: new Date().toISOString() })
  return { ...(movedAside ? { movedAside } : {}), ledgerRows, alreadyDone: done }
}

/**
 * Undo a promotion whose trial failed: the tried home goes aside as evidence, a folder that
 * was moved away for it comes back. The standby copy is built again from its chunks by the
 * caller's verify pass.
 */
export async function demoteTrialHome(o: { switchId: string; home: string }): Promise<{ keptAt?: string; restored?: boolean }> {
  let keptAt: string | undefined
  if (fs.existsSync(o.home) && promotedBy(o.home) === o.switchId) {
    keptAt = `${o.home}.trial-failed-${o.switchId}`
    for (let i = 1; fs.existsSync(keptAt); i++) keptAt = `${o.home}.trial-failed-${o.switchId}-${i}`
    await fsp.rename(o.home, keptAt)
  }
  // Also after a kill between the two renames (or between moving the old folder aside and the
  // copy's rename): whatever was moved away for this switch comes back.
  const before = `${o.home}.before-${o.switchId}`
  let restored = false
  if (!fs.existsSync(o.home) && fs.existsSync(before)) { await fsp.rename(before, o.home); restored = true }
  return { ...(keptAt ? { keptAt } : {}), ...(restored ? { restored } : {}) }
}
