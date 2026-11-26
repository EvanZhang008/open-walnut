/**
 * The engine records of the sessions in the data home, carried beside the standby copy (docs/reference/leader-switch.md,
 * "Sessions in the data home"). Claude Code keeps a session's conversation in its own dir (`$CLAUDE_CONFIG_DIR`, else
 * `~/.claude`), in a folder named by the session's cwd, not in the data home, so the copy does not hold it. What
 * travels, verified on Claude Code 2.1.322 (evidence home-cwd/resume-proof):
 *
 *   projects/<folder>/<sid>.jsonl   the transcript (grows only: taken up to its last whole line, append-only.ts)
 *   projects/<folder>/<sid>/        its subagents' transcripts (grow only), their meta files, large tool results
 *   projects/<folder>/memory/       the engine's own memory of that folder (shared by every session there)
 *   tasks/<sid>/                    the session's task list
 *
 * for `<folder>` the engine's folder name of the home and of each folder under it a session row records (computed from
 * the row's cwd, never by a name's prefix: `/a/b` is not `/a/b-c`), and `<sid>` a session of the class. Nothing else of
 * the engine's dir is read: not its settings, credentials, plugins or another project. Not carried: file-history/<sid>
 * (checkpoints keyed by the old machine's absolute paths: rewinding an edit made before the switch does not work after
 * it), session-env/<sid> (rebuilt at each start), the engine's debug logs and its live process files.
 *
 * The batches are the standby's own (src/core/standby, with this file's CopyPlace instead of the home's manifest) into
 * a second target beside the copy, `<standby dir>/carry` (carryTargetDir), never into the new machine's engine dir: until the commit the
 * new machine writes nothing outside its standby folder. A periodic batch of it rides each standby batch (its failure is
 * only logged); the final one runs after the home's final batch, until one finds nothing changed, and the final mark
 * names its batch (final-stop.ts), which the promotion checks. Only after the commit does the new leader move the
 * records from its standby folder into its engine's dir under the new folder name (placeCarriedRecords).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CarrySource, CopyPlace } from '../../standby/scan.js'
import { carryTargetDir } from '../../standby/target-files.js'
import type { SessionRecord } from '../../types.js'
import { encodeProjectPath } from '../../session-file-reader.js'
import { engineFolderName, engineOf, homeSessionRows, moveRefusal, realPath } from './home-sessions.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

/** What one carry batch takes: the engine folders (by name) and the sessions (for their task lists). */
export interface CarrySelection {
  folders: ReadonlySet<string>
  sids: ReadonlySet<string>
}

/** The engine folder of a home (its real path, encoded): the prefix of every folder under it. */
export function homeEngineFolder(home: string): string | null {
  return engineFolderName(home)
}

/** The engine folder of `rel` under a home whose own engine folder is `homeFolder` (the encoding is per character). */
export function engineFolderUnder(homeFolder: string, rel: string): string {
  return rel ? `${homeFolder}${encodeProjectPath(`/${rel}`)}` : homeFolder
}

/** The selection of a home now: its own engine folder, and each folder of a session of the class that can move. */
export function carrySelection(records: readonly SessionRecord[], home: string): CarrySelection {
  const folders = new Set<string>()
  const sids = new Set<string>()
  const own = homeEngineFolder(home)
  if (own) folders.add(own)
  for (const { rec, rel } of homeSessionRows(records, home)) {
    if (engineOf(rec) !== 'claude' || moveRefusal(rec, rel, home)) continue
    const f = engineFolderName(rec.cwd!)
    if (!f) continue
    folders.add(f)
    sids.add(rec.claudeSessionId)
  }
  return { folders, sids }
}

/** The carry's place: what a batch of the engine's dir walks and takes (src/core/standby/scan.ts CopyPlace). */
export function carryPlace(sel: CarrySelection): CopyPlace {
  const dirMayHold = (rel: string): boolean => {
    const p = rel.split('/')
    if (p[0] === 'projects') {
      if (p.length === 1) return true
      if (!sel.folders.has(p[1]!)) return false
      return p.length === 2 || UUID.test(p[2]!) || p[2] === 'memory'
    }
    if (p[0] === 'tasks') return p.length === 1 ? sel.sids.size > 0 : sel.sids.has(p[1]!)
    return false
  }
  return {
    dirMayHold,
    fileTest: () => (dir, name) => {
      if (!dir) return false
      const p = dir.split('/')
      if (p[0] === 'projects' && p.length === 2) return sel.folders.has(p[1]!) && UUID_JSONL.test(name)
      if (p[0] === 'projects' && p.length >= 3) return dirMayHold(dir)
      if (p[0] === 'tasks' && p.length >= 2) return sel.sids.has(p[1]!)
      return false
    },
    appendOnly: (rel) => {
      const p = rel.split('/')
      if (p[0] !== 'projects') return false
      if (p.length === 3) return UUID_JSONL.test(p[2]!)
      return p.length === 5 && UUID.test(p[2]!) && p[3] === 'subagents' && p[4]!.endsWith('.jsonl')
    },
    holdsDir: (rel) => rel !== 'projects' && rel !== 'tasks' && dirMayHold(rel),
  }
}

/** The engine's dir of this machine's local daemon (claude-config-dir.ts: its CLAUDE_CONFIG_DIR, else ~/.claude). */
export async function localEngineDir(): Promise<string> {
  const { localClaudeProjectsDir } = await import('../../claude-config-dir.js')
  return path.dirname(localClaudeProjectsDir())
}

/** Where a carry batch reads its clock: on the engine dir's filesystem (fsClock refuses another). */
export function carryStagingDir(home: string, engineDir: string): string {
  try {
    if (fs.statSync(home).dev === fs.statSync(engineDir).dev) return path.join(home, 'tmp', 'standby-carry-staging')
  } catch { /* the engine dir is not there yet: no records to carry, the home's tmp is fine */ }
  return path.join(engineDir, '.walnut-carry-staging')
}

/**
 * What a carry batch of `home` takes now (the standby runner's periodic one, the switch stop's final one): this
 * machine's engine dir with the selection of the sessions now in the home (`records`: default the session store).
 * An engine that keeps no dir here has nothing to carry: the batch is of an empty folder in the home's scratch, so
 * the final mark still names a batch.
 */
export async function carrySource(home: string, o: { records?: readonly SessionRecord[]; engineDir?: string } = {}): Promise<CarrySource> {
  const records = o.records ?? await (await import('../../session-tracker.js')).sessionStoreView()
  const engineDir = o.engineDir ?? await localEngineDir()
  const place = carryPlace(carrySelection(records, home))
  if (fs.existsSync(engineDir)) return { root: engineDir, place, stagingDir: carryStagingDir(home, engineDir) }
  const empty = path.join(home, 'tmp', 'standby-carry-empty')
  fs.mkdirSync(empty, { recursive: true, mode: 0o700 })
  return { root: empty, place, stagingDir: path.join(home, 'tmp', 'standby-carry-staging') }
}

// ---- after the commit: the records into the new leader's engine dir --------------------------------------------

export interface PlacedFolder { from: string; to: string; files: number; bytes: number }

export interface PlaceResult {
  folders: PlacedFolder[]
  /** Sessions whose records could not be put in place (neither copy is overwritten): they end there. */
  conflicts: Array<{ sid: string; why: string }>
  /** Files already at the new place that a carried one replaced, set aside as `<name>.before-<switch>`. */
  setAside: string[]
  bytes: number
}

/**
 * Move the carried records of one folder pair from the carry's copy into the engine dir: the transcripts and sidecars
 * of `sids` only (another session's file in that folder stays in the carry), and the folder's memory. Never
 * overwrites:
 *   - a transcript already there that is a byte prefix of the carried one (what a switch back left there) is set aside
 *     as `<name>.before-<switch>`; any other one is a conflict (the session ends with why, both copies kept);
 *   - any other file already there with other bytes (a memory note, a sidecar, a task: the older copy a round trip
 *     left) is set aside the same way, and the carried one, the newer, takes its place.
 * Files get the owner's read-write mode (the copy's are read-only).
 */
export function placeFolder(o: { carryCopy: string; engineDir: string; from: string; to: string; switchId: string; sids: ReadonlySet<string> }, out: PlaceResult): void {
  const src = path.join(o.carryCopy, 'projects', o.from)
  const dst = path.join(o.engineDir, 'projects', o.to)
  if (!fs.existsSync(src)) return
  const placed: PlacedFolder = { from: o.from, to: o.to, files: 0, bytes: 0 }
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isFile() && UUID_JSONL.test(e.name)) {
      const sid = e.name.slice(0, -'.jsonl'.length)
      if (!o.sids.has(sid)) continue
      const why = moveFile(s, d, o.switchId, placed, 'transcript', out.setAside)
      if (why) out.conflicts.push({ sid, why })
    } else if (e.isDirectory() && (e.name === 'memory' || (UUID.test(e.name) && o.sids.has(e.name)))) {
      mergeDir(s, d, o.switchId, placed, out.setAside)
    }
  }
  out.folders.push(placed)
  out.bytes += placed.bytes
}

/** One session's task list into the engine dir (the carried copy is the newer: one there already is set aside). */
export function placeTasks(o: { carryCopy: string; engineDir: string; sid: string; switchId: string }, out: PlaceResult): void {
  const src = path.join(o.carryCopy, 'tasks', o.sid)
  if (!fs.existsSync(src)) return
  const placed: PlacedFolder = { from: `tasks/${o.sid}`, to: `tasks/${o.sid}`, files: 0, bytes: 0 }
  mergeDir(src, path.join(o.engineDir, 'tasks', o.sid), o.switchId, placed, out.setAside)
  out.folders.push(placed)
  out.bytes += placed.bytes
}

/**
 * Move `s` to `d`. Null when placed (or the same bytes were there); else why not. A file at `d` with other bytes:
 * `transcript`, set aside only when it is a byte prefix of `s` (else a conflict); `newer`, always set aside.
 */
function moveFile(s: string, d: string, switchId: string, placed: PlacedFolder, rule: 'transcript' | 'newer', setAside: string[]): string | null {
  const size = fs.statSync(s).size
  if (fs.existsSync(d)) {
    if (sameBytes(s, d)) { fs.rmSync(s, { force: true }); return null }
    if (rule === 'transcript' && !isPrefixOf(d, s)) return `${d} is there already with other content (neither is overwritten)`
    const aside = freeName(`${d}.before-${switchId}`)
    fs.renameSync(d, aside)
    setAside.push(aside)
  }
  fs.mkdirSync(path.dirname(d), { recursive: true, mode: 0o700 })
  try {
    fs.renameSync(s, d)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL)
    fs.rmSync(s, { force: true })
  }
  fs.chmodSync(d, 0o600)
  placed.files++
  placed.bytes += size
  return null
}

/** `p`, or `p.1`, `p.2`... the first that is not there. */
function freeName(p: string): string {
  if (!fs.existsSync(p)) return p
  for (let i = 1; ; i++) if (!fs.existsSync(`${p}.${i}`)) return `${p}.${i}`
}

function mergeDir(s: string, d: string, switchId: string, placed: PlacedFolder, setAside: string[]): void {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  fs.chmodSync(d, 0o700)
  for (const e of fs.readdirSync(s, { withFileTypes: true })) {
    const sp = path.join(s, e.name)
    const dp = path.join(d, e.name)
    if (e.isDirectory()) mergeDir(sp, dp, switchId, placed, setAside)
    else if (e.isFile()) moveFile(sp, dp, switchId, placed, 'newer', setAside)
  }
}

/** Owner read-write on every dir and file under `root` (no symlink followed). */
function ownerWritable(root: string): void {
  const st = fs.lstatSync(root)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    fs.chmodSync(root, 0o700)
    for (const e of fs.readdirSync(root)) ownerWritable(path.join(root, e))
  } else if (st.isFile()) fs.chmodSync(root, 0o600)
}

function sameBytes(a: string, b: string): boolean {
  const sa = fs.statSync(a).size
  if (sa !== fs.statSync(b).size) return false
  return isPrefixOf(a, b)
}

/** Whether the bytes of `a` are the first bytes of `b`. */
function isPrefixOf(a: string, b: string): boolean {
  const sa = fs.statSync(a).size
  if (sa > fs.statSync(b).size) return false
  const fa = fs.openSync(a, 'r')
  const fb = fs.openSync(b, 'r')
  try {
    const ba = Buffer.alloc(1 << 20)
    const bb = Buffer.alloc(1 << 20)
    for (let at = 0; at < sa;) {
      const n = Math.min(ba.length, sa - at)
      fs.readSync(fa, ba, 0, n, at)
      fs.readSync(fb, bb, 0, n, at)
      if (!ba.subarray(0, n).equals(bb.subarray(0, n))) return false
      at += n
    }
    return true
  } finally {
    fs.closeSync(fa)
    fs.closeSync(fb)
  }
}

export interface PlaceDeps {
  list(): Promise<SessionRecord[]>
  save(sid: string, patch: Partial<SessionRecord>): Promise<void>
  /** End a session that cannot continue here: archived, with why on its record. */
  end(sid: string, why: string): Promise<void>
  /** Messages held for the move go out again (engine-switch-io.ts releaseMoveHeldRows). */
  release(sid: string): Promise<void>
  /** Start a supervised session idle (its CLI rebuilds its session crons from the transcript). */
  startIdle(sid: string): Promise<void>
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

/**
 * The new leader, once committed (its first lead: web/server.ts, before the sessions are reconciled and resumed): the
 * records of every session the promotion moved here go from the carry's copy into this machine's engine dir under the
 * new folder name, then the carry is removed. Each session's records come from the folder the old leader named in its
 * stamp (`engineFolder`, of its real cwd there); `homeFolderFrom`, the old home's engine folder as the final mark names
 * it, is the source of the home's own memory and of a row the old leader did not stamp. A session whose transcript the
 * old machine kept but is not at its new place afterwards is ended with why, and the carry stays (nothing of it is
 * lost). Idempotent: a session whose records are placed is not touched again.
 */
export async function placeCarriedRecords(o: { switchId: string; home: string; standbyDir: string; homeFolderFrom: string; engineDir: string; deps: PlaceDeps }): Promise<PlaceResult & { sessions: number; missing: string[] }> {
  const out: PlaceResult & { sessions: number; missing: string[] } = { folders: [], conflicts: [], setAside: [], bytes: 0, sessions: 0, missing: [] }
  const rows = (await o.deps.list()).filter((r) => r.leaderSwitch?.switchId === o.switchId && r.leaderSwitch.moved?.records === 'pending')
  if (!rows.length) return out
  const carryCopy = path.join(carryTargetDir(o.standbyDir), 'copy')
  // The copy is read-only on disk (dirs 0500, files 0400): its records leave it, so it opens first.
  if (fs.existsSync(carryCopy)) ownerWritable(carryCopy)
  const toFolderOfHome = engineFolderName(o.home)
  if (!toFolderOfHome) throw new Error(`the new home's path ${o.home} is longer than Claude Code names a folder of records by`)
  // Folder pairs, each with the sessions it moves (the home's own folder moves its memory even with none).
  const pairs = new Map<string, { to: string; sids: Set<string> }>([[o.homeFolderFrom, { to: toFolderOfHome, sids: new Set() }]])
  const toOf = new Map<string, string>()
  for (const r of rows) {
    const st = r.leaderSwitch!
    const from = st.engineFolder ?? engineFolderUnder(o.homeFolderFrom, st.rel)
    const to = engineFolderName(path.join(realPath(o.home), ...st.rel.split('/').filter(Boolean))) ?? engineFolderUnder(toFolderOfHome, st.rel)
    const pair = pairs.get(from) ?? { to, sids: new Set<string>() }
    pair.sids.add(r.claudeSessionId)
    pairs.set(from, pair)
    toOf.set(r.claudeSessionId, pair.to)
  }
  for (const [from, p] of pairs) placeFolder({ carryCopy, engineDir: o.engineDir, from, to: p.to, switchId: o.switchId, sids: p.sids }, out)
  for (const r of rows) placeTasks({ carryCopy, engineDir: o.engineDir, sid: r.claudeSessionId, switchId: o.switchId }, out)
  const conflicted = new Map(out.conflicts.map((c) => [c.sid, c.why]))
  let keepCarry = out.conflicts.length > 0
  for (const r of rows) {
    const st = r.leaderSwitch!
    const sid = r.claudeSessionId
    let why = conflicted.get(sid)
    const there = fs.existsSync(path.join(o.engineDir, 'projects', toOf.get(sid)!, `${sid}.jsonl`))
    if (!why && !there && st.transcript !== false) {
      why = `its transcript was not among the records carried from ${st.from.machine} (folder ${st.engineFolder ?? st.rel}), so its history is not on this machine`
      out.missing.push(sid)
      if (r.archived) {
        // An archived session with no transcript left: nothing to resume; named, and the carry need not stay for it.
        await o.deps.save(sid, { leaderSwitch: { ...st, moved: { ...st.moved!, records: 'missing' }, why } })
        continue
      }
    }
    if (why) {
      keepCarry = true
      await o.deps.end(sid, `Ended by the leader switch ${o.switchId}: its history could not be put in place on this machine (${why}).`)
      await o.deps.save(sid, { leaderSwitch: { ...st, plan: 'end', why, moved: { ...st.moved!, records: 'missing' } } })
      continue
    }
    await o.deps.save(sid, { leaderSwitch: { ...st, moved: { ...st.moved!, records: 'placed' } } })
    out.sessions++
    if (r.archived) continue
    await o.deps.release(sid)
    if (st.supervised && st.stopped === 'idle') await o.deps.startIdle(sid).catch((err: unknown) => o.deps.log('warn', 'leader switch: a supervised session did not start idle after the move', { sid, error: String(err) }))
  }
  if (!keepCarry) {
    if (fs.existsSync(carryTargetDir(o.standbyDir))) ownerWritable(carryTargetDir(o.standbyDir))
    fs.rmSync(carryTargetDir(o.standbyDir), { recursive: true, force: true })
  }
  o.deps.log(keepCarry ? 'warn' : 'info', 'leader switch: the sessions\' records are in place on this machine', { switchId: o.switchId, sessions: out.sessions, bytes: out.bytes, folders: out.folders, conflicts: out.conflicts, missing: out.missing, setAside: out.setAside, carryKept: keepCarry })
  return out
}
