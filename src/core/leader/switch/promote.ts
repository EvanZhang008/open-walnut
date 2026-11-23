/**
 * The standby copy becomes the new leader's data home, the way a restored backup does at
 * boot (src/core/backup/restore-switch.ts), the old folder kept beside it.
 *
 *   1. no folder at the new home's path: `<standby>/copy` is renamed to the home in one step
 *      (same filesystem, no copy), `local/leader-switch/promoted.json` ('promoting') put into
 *      the copy first, so the home is marked from the instant it exists;
 *   2. a folder there (the first switch's target holding only this machine's daemon state, or
 *      the handed-over home of a switch back): it is SWAPPED around this machine's daemon
 *      runtime places (home-manifest isMachineRuntimePath: the journal root, the leader book,
 *      the streams, the samples the daemon keeps in `<home>/tmp`). Everything else moves to
 *      `<home>.before-<switch>` (kept, never deleted), the copy's entries move in, and the
 *      runtime places never move: the daemon keeps writing them at the path it reads, through
 *      an open fd or by path, while the swap runs (moving them away and back would lose what
 *      it wrote by path in between, and a write through an open fd would land in the folder
 *      moved aside). The old home's `local/` goes last and the copy's (with the mark) first,
 *      so the home holds a marker but for the two renames between them;
 *   3. the copy's read-only modes (files 0400, dirs 0500) become the owner's read-write;
 *   4. what names the old machine's places is rewritten (home-path-rules.ts, the rewrite set):
 *      paths under the old home move to the new home, paths under the old account home to the
 *      new account home, among them the applied-ops ledger's `home` column (without it every
 *      op id the old leader applied would apply again here), and `standby.dir` in config.yaml
 *      becomes the old machine's standby folder (the new leader's batches go there, for the
 *      switch back). The trial's self-check scans the home for what is left (self-check.ts);
 *   5. promoted.json becomes 'promoted' (the switch's commit makes it 'led').
 * Every step is safe to run again after a kill: before the copy's mark is in the home the swap
 * is still moving the old entries aside, after it the copy's entries in.
 *
 * The standby target keeps its chunks and manifests; its `copy/` is gone until its next
 * verify pass builds it again from the chunks (verify.ts: a missing file is built again).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { holdsMachineRuntime, isMachineRuntimePath } from '../../home-manifest/index.js'
import { readPromoted, writePromoted } from './records.js'
import { pathRoots, rewriteHomePaths, type PathRoot, type RewriteDone } from './home-paths.js'
import { homePathRules, LEDGER_RULE } from './home-path-rules.js'

export interface PromoteInput {
  switchId: string
  standbyDir: string
  home: string
  /** The old leader's home path, as its data names it. */
  previousHome: string
  /** Where the new leader sends its standby batches: the old leader machine's standby_dir. */
  reverseStandbyDir: string
  /** The account home dirs of the old and the new machine (paths under the old one move). */
  previousAccountHome?: string
  accountHome?: string
  /** Tests only: leave the ledger as the old home wrote it (shows what the rewrite is for). */
  skipLedgerRewrite?: boolean
  /** Tests only: called right after the copy is in the home (the rehearsal kills the switch there). */
  afterRename?: () => void
}

export interface PromoteResult {
  /** The folder that was at the home's path, moved aside. */
  movedAside?: string
  ledgerRows: number
  /** Every file the path rewrite changed, with the rules that named it. */
  rewritten: RewriteDone[]
  alreadyDone: boolean
}

/** The roots a promotion moves: the old home to the new one, the old account home to the new one. */
export function moveRoots(o: { previousHome: string; home: string; previousAccountHome?: string; accountHome?: string }): PathRoot[] {
  return pathRoots({ fromHome: o.previousHome, toHome: o.home, fromAccount: o.previousAccountHome, toAccount: o.accountHome })
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
      // This machine's daemon state stays as its daemon keeps it.
      if (p !== root && isMachineRuntimePath(path.relative(root, p).split(path.sep).join('/'))) continue
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

const LOCAL = 'local'

/**
 * Move every entry of `src` into `dst`, but this machine's daemon runtime places (they stay in
 * `src`, with the dirs that hold them). A dir present in both is merged; any other clash is an
 * error (the swap stops; the switch rolls back). `order` puts the top-level `local/` (the
 * markers) last when moving a home's entries out, first when moving a copy's in.
 * Returns how many entries moved.
 */
async function moveAround(src: string, dst: string, rel: string, order: 'local-last' | 'local-first'): Promise<number> {
  let names: string[]
  try { names = (await fsp.readdir(path.join(src, rel))).sort() } catch { return 0 }
  if (rel === '') {
    names = names.filter((n) => n !== LOCAL)
    if (fs.existsSync(path.join(src, LOCAL))) names = order === 'local-last' ? [...names, LOCAL] : [LOCAL, ...names]
  }
  let moved = 0
  for (const name of names) {
    const r = rel ? `${rel}/${name}` : name
    if (isMachineRuntimePath(r)) continue
    const from = path.join(src, r)
    const to = path.join(dst, r)
    const st = await fsp.lstat(from)
    const isDir = st.isDirectory()
    // Moving out of a dir, or a dir to another parent (its '..'), needs the owner's write bit:
    // a copy's dirs are 0500; a home's have it already and are left as they are.
    if (isDir && !(st.mode & 0o200)) await fsp.chmod(from, (st.mode & 0o777) | 0o700)
    if (isDir && holdsMachineRuntime(r)) {
      // A dir that holds runtime places (tmp/): it stays; what else is in it moves.
      await fsp.mkdir(to, { recursive: true, mode: 0o700 })
      moved += await moveAround(src, dst, r, order)
      continue
    }
    const there = await fsp.lstat(to).catch(() => null)
    if (!there) {
      await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
      await fsp.rename(from, to)
      moved++
    } else if (isDir && there.isDirectory()) {
      moved += await moveAround(src, dst, r, order)
      await fsp.rmdir(from).catch(() => { /* a runtime place, or a new entry, is left in it */ })
    } else {
      throw new Error(`${to} exists already, and ${from} would replace it`)
    }
  }
  return moved
}

/** Remove the dirs left empty under `root` (and `root` itself when it is empty); a daemon runtime place stays, empty or not. */
async function pruneEmpty(root: string, rel = ''): Promise<void> {
  if (rel && isMachineRuntimePath(rel)) return
  const dir = rel ? path.join(root, rel) : root
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return }
  for (const n of names) {
    const r = rel ? `${rel}/${n}` : n
    if ((await fsp.lstat(path.join(root, r))).isDirectory()) await pruneEmpty(root, r)
  }
  if ((await fsp.readdir(dir).catch(() => ['?'])).length) return
  // A copy's dirs are 0500: the parent's write bit is what removing needs, and it is set by now.
  await fsp.rmdir(dir).catch(() => { /* raced by a writer */ })
}

export async function promoteCopy(o: PromoteInput): Promise<PromoteResult> {
  const copy = path.join(o.standbyDir, 'copy')
  const before = `${o.home}.before-${o.switchId}`
  const done = fs.existsSync(o.home) && promotedBy(o.home) === o.switchId && !fs.existsSync(copy)
  if (!done) {
    if (!fs.existsSync(copy)) throw new Error(`the standby copy ${copy} is gone${fs.existsSync(o.home) ? ` and ${o.home} is not this switch's` : ''}`)
    // The mark goes in first (local/ is this machine's, never in a batch).
    await fsp.chmod(copy, 0o700)
    if (fs.existsSync(path.join(copy, LOCAL))) await fsp.chmod(path.join(copy, LOCAL), 0o700)
    // (Already in the home after a kill part way through moving the copy in.)
    if (promotedBy(copy) !== o.switchId && !(fs.existsSync(o.home) && promotedBy(o.home) === o.switchId)) writePromoted(copy, { switchId: o.switchId, state: 'promoting', from: o.previousHome, at: new Date().toISOString() })
    if (!fs.existsSync(o.home)) {
      await fsp.mkdir(path.dirname(o.home), { recursive: true })
      await fsp.rename(copy, o.home)
      o.afterRename?.()
    } else {
      // Before the copy's mark is in the home, the old entries are still moving aside.
      if (promotedBy(o.home) !== o.switchId) await moveAround(o.home, before, '', 'local-last')
      await moveAround(copy, o.home, '', 'local-first')
      await pruneEmpty(copy)
      if (fs.existsSync(copy)) throw new Error(`the standby copy ${copy} still holds entries the home could not take`)
      await pruneEmpty(before)
      o.afterRename?.()
    }
  }
  await makeWritable(o.home)
  const rewritten = rewriteHomePaths(o.home, homePathRules({ skipLedgerRewrite: o.skipLedgerRewrite }), {
    roots: moveRoots(o),
    reverseStandbyDir: o.reverseStandbyDir,
  })
  const ledgerRows = rewritten.filter((d) => d.rules.includes(LEDGER_RULE)).reduce((n, d) => n + d.values, 0)
  writePromoted(o.home, { switchId: o.switchId, state: 'promoted', from: o.previousHome, at: new Date().toISOString() })
  return { ...(fs.existsSync(before) ? { movedAside: before } : {}), ledgerRows, rewritten, alreadyDone: done }
}

/**
 * Undo a promotion whose trial failed: the tried home's entries go aside as evidence
 * (`<home>.trial-failed-<switch>`), what was moved away for it comes back, and this machine's
 * daemon runtime places stay where they are, as in the promotion. The standby copy is built
 * again from its chunks by the caller's verify pass. Safe to run again after a kill: while the
 * home still holds this switch's mark (its local/ goes last) the tried entries are still going.
 */
export async function demoteTrialHome(o: { switchId: string; home: string }): Promise<{ keptAt?: string; restored?: boolean }> {
  let keptAt: string | undefined
  if (fs.existsSync(o.home) && promotedBy(o.home) === o.switchId) {
    keptAt = `${o.home}.trial-failed-${o.switchId}`
    await moveAround(o.home, keptAt, '', 'local-last')
    await pruneEmpty(o.home)
  }
  // Also after a kill part way through the promotion: whatever was moved away for this switch comes back.
  const before = `${o.home}.before-${o.switchId}`
  let restored = false
  if (fs.existsSync(before) && promotedBy(o.home) !== o.switchId) {
    if (!fs.existsSync(o.home)) await fsp.rename(before, o.home)
    else { await moveAround(before, o.home, '', 'local-first'); await pruneEmpty(before) }
    restored = true
  }
  return { ...(keptAt ? { keptAt } : {}), ...(restored ? { restored } : {}) }
}
