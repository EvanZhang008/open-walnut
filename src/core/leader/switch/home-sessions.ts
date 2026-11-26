/**
 * Sessions whose folder is the leader's data home or under it, across a leader switch (docs/reference/leader-switch.md,
 * "Sessions in the data home"). Main, Ask Walnut, the walnut-agent and triage routines, a trigger's delivery that falls
 * back to the home, the console's subagents, and every fork or subagent of these run their CLI in the home
 * (evidence: home-cwd/sites.md). Such a CLI writes into the home (its tools, the CLI's `.claude/` under its cwd), so it
 * cannot stay on the old machine once the leader moves: the old home must not change after the final mark.
 *
 * The class is chosen by folder, never by kind: every session row the leader judges, of the leader's own daemon, whose
 * recorded cwd is the home or under it (any spelling of the home: as configured and its real path). A new kind that
 * starts there is covered without being named here.
 *
 *   old leader, switch stop's first step (stopHomeSessions): each such row gets its plan (`leaderSwitch` on the row:
 *     move, or end with why), a CLI running a turn is marked as a restart loss (cause leader_switch: resumed after, on
 *     the new leader or, after a rollback, here), and every live CLI of the class is stopped through this machine's
 *     own session runtime (stop reason leader_switch: its cron supervision is turned off with it, and the reply comes
 *     once its process group is gone). The final batch carries the rows; the sessions' engine records travel beside
 *     the copy (session-carry.ts).
 *   new leader, promotion (session-hosts.ts, the one place a switch moves sessions): a row of the class that moves runs
 *     on the new leader's own daemon, cwd the same place in the new home; one that cannot move keeps the old machine
 *     as its host (its history stays readable there) and is ended with its reason.
 *   new leader, first lead after the commit (session-carry.ts placeCarriedRecords): the records go from the standby
 *     folder into its engine's dir under the new folder name, then the interrupted turns resume.
 *   a rollback (settleHomeSessionsAfterRollback): the marker is gone first, then each session's cron supervision is
 *     on again and its interrupted turn resumes in place, as after a restart.
 *
 * With `switchable_leader` off none of this runs: only a switch stop, a promotion and a home a switch marked reach it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { LeaderSwitchSessionStamp, SessionRecord, SessionRestartLoss } from '../../types.js'
import { homePathClass, isMachineRuntimePath } from '../../home-manifest/index.js'
import { encodeProjectPath, isSafeForProjectEncoding } from '../../session-file-reader.js'

/** The ways a home's path is written: as configured (resolved) and its real path. */
export function homeSpellings(home: string): string[] {
  const out = new Set([path.resolve(home)])
  try { out.add(fs.realpathSync.native(home)) } catch { /* not there (a test's home) */ }
  return [...out]
}

/** `cwd` relative to the home ('' is the home itself) when it is the home or under it, by folder; else null. */
export function relInHome(cwd: string | null | undefined, spellings: readonly string[]): string | null {
  if (!cwd || !path.isAbsolute(cwd)) return null
  const c = path.resolve(cwd)
  for (const h of spellings) {
    const rel = path.relative(h, c)
    if (rel === '') return ''
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  }
  return null
}

/** A row of the leader's own daemon (no host, '' or '__local__'), judged by the leader. */
export function ownDaemonRow(r: Pick<SessionRecord, 'host' | 'judge'>): boolean {
  const own = !r.host || r.host === '__local__'
  return own && !(r.judge === 'host' && !!r.host)
}

/** The rows of the class in `records`: the leader's own daemon's, with the cwd in the home. */
export function homeSessionRows(records: readonly SessionRecord[], home: string): Array<{ rec: SessionRecord; rel: string }> {
  const spellings = homeSpellings(home)
  const out: Array<{ rec: SessionRecord; rel: string }> = []
  for (const rec of records) {
    if (!ownDaemonRow(rec)) continue
    const rel = relInHome(rec.cwd, spellings)
    if (rel !== null) out.push({ rec, rel })
  }
  return out
}

/** The engine a row runs (an older row names none: Claude Code). */
export function engineOf(r: Pick<SessionRecord, 'engine' | 'provider'>): string {
  return String(r.engine ?? r.provider ?? 'claude') || 'claude'
}

/** `p` with symlinks resolved in the part of it that exists (a folder since removed keeps its written tail). */
export function realPath(p: string): string {
  const rest: string[] = []
  for (let cur = path.resolve(p); ;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest) } catch {
      const up = path.dirname(cur)
      if (up === cur) return path.resolve(p)
      rest.unshift(path.basename(cur))
      cur = up
    }
  }
}

/**
 * The name of the engine's folder for a session that runs in `cwd` (Claude Code: `projects/<name>/`, the real path
 * encoded, session-file-reader.ts), or null when Claude Code would hash it (over 200 characters), which Walnut does not
 * reproduce. The CLI's cwd is the real path (getcwd), so the name is of that.
 */
export function engineFolderName(cwd: string): string | null {
  const real = realPath(cwd)
  return isSafeForProjectEncoding(real) ? encodeProjectPath(real) : null
}

/**
 * Why a row of the class cannot move with the leader, in plain words, or null when it can. The checks that need the
 * new leader's machine (its engine's version, a record already in the place) are its own (session-carry.ts).
 */
export function moveRefusal(rec: Pick<SessionRecord, 'engine' | 'provider' | 'cwd'>, rel: string): string | null {
  const engine = engineOf(rec)
  if (engine !== 'claude') return `its engine (${engine}) keeps its history on this machine, which a leader switch does not carry: only Claude Code sessions move with the leader`
  if (rel) {
    if (isMachineRuntimePath(rel)) return `its folder ${rel} in the data home is this machine's runtime place, which the standby copy does not carry`
    const cls = homePathClass(rel)
    if (cls !== 'leader-data') return `its folder ${rel} in the data home is ${cls} data, which the standby copy does not carry`
  }
  if (!engineFolderName(rec.cwd ?? '')) return 'its folder\'s path is longer than Claude Code names a folder of records by (200 characters), so its history could not be found after the move'
  return null
}

/** The stop's id at the daemon for one session of one switch (a UUID: the daemon takes no other), the same every time. */
export function stopRequestIdFor(switchId: string, sid: string): string {
  const h = createHash('sha256').update(`leader-switch\0${switchId}\0${sid}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h.slice(16, 17), 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** A live CLI of a row: what the record says (the stop asks the runtime, which knows for sure). */
export function liveState(r: Pick<SessionRecord, 'process_status' | 'archived'>): 'turn' | 'idle' | 'none' {
  if (r.archived) return 'none'
  if (r.process_status === 'running') return 'turn'
  if (r.process_status === 'idle') return 'idle'
  return 'none'
}

// ---- the old leader's switch stop --------------------------------------------------------------------------------

/** What a switch would do with the sessions in the home now (the preflight says it; the stop does it). */
export interface HomeSessionsPlan {
  /** Rows of the class (archived ones included: they follow by their folder). */
  rows: number
  moves: number
  /** Live CLIs the stop ends, by what they do. */
  live: { turn: number; idle: number }
  ends: Array<{ sid: string; title?: string; why: string }>
}

export function planHomeSessions(records: readonly SessionRecord[], home: string): HomeSessionsPlan {
  const rows = homeSessionRows(records, home)
  const out: HomeSessionsPlan = { rows: rows.length, moves: 0, live: { turn: 0, idle: 0 }, ends: [] }
  for (const { rec, rel } of rows) {
    const why = moveRefusal(rec, rel)
    if (why) out.ends.push({ sid: rec.claudeSessionId, ...(rec.title ? { title: rec.title } : {}), why })
    else out.moves++
    const live = liveState(rec)
    if (live !== 'none') out.live[live]++
  }
  return out
}

/** The plan in one line (the switch's step log and notes). */
export function planLine(p: HomeSessionsPlan): string {
  if (!p.rows) return 'no session works in the data home'
  const live = p.live.turn + p.live.idle ? `; the switch stop ends ${p.live.turn} running turn(s) and ${p.live.idle} idle CLI(s), resumed after it` : ''
  const ends = p.ends.length ? `; ${p.ends.length} end instead: ${p.ends.slice(0, 5).map((e) => `${e.title ?? e.sid} (${e.why})`).join('; ')}${p.ends.length > 5 ? '; ...' : ''}` : ''
  return `sessions in the data home: ${p.moves} move with the leader${live}${ends}`
}

export interface HomeStopDeps {
  list(): Promise<SessionRecord[]>
  save(sid: string, patch: Partial<SessionRecord>): Promise<void>
  /** Whether this machine's runtime supervises a session cron of `sid` (false when it keeps none). */
  supervised(sid: string): Promise<boolean>
  /** Stop `sid` through this machine's own session runtime, reason leader_switch: resolves once its process is gone. */
  stop(rec: SessionRecord, stopRequestId: string): Promise<{ ok: true } | { ok: false; why: string }>
  /** The processes of this machine whose cwd is in the home: pid and program name (home-processes.ts). */
  processesInHome(spellings: readonly string[]): Promise<Array<{ pid: number; name: string }>>
  now(): number
}

export interface HomeStopResult {
  ok: boolean
  /** Rows of the class (archived ones included). */
  rows: number
  /** CLIs stopped, by what they were doing. */
  stopped: { turn: number; idle: number }
  moves: number
  ends: Array<{ sid: string; why: string }>
  /** Processes still in the home after the stops that are no session of this server's (a person's shell): named. */
  others: Array<{ pid: number; name: string }>
  ms: number
  why?: string
}

/**
 * The switch stop's first step on the old leader: plan, mark and stop every session of the class, within `budgetMs`.
 * Not ok when a CLI of the class did not end (named): the switch stop then does not go on (no CLI is ever killed by
 * force; the switch waits for its stop again or rolls back, and the session resumes here).
 */
export async function stopHomeSessions(o: { switchId: string; home: string; machine: string; budgetMs: number; deps: HomeStopDeps }): Promise<HomeStopResult> {
  const t0 = o.deps.now()
  const at = new Date(t0).toISOString()
  const rows = homeSessionRows(await o.deps.list(), o.home)
  const out: HomeStopResult = { ok: true, rows: rows.length, stopped: { turn: 0, idle: 0 }, moves: 0, ends: [], others: [], ms: 0 }
  const live = rows.filter(({ rec }) => liveState(rec) !== 'none')
  // Every row of the class that is not archived gets its plan (an archived one follows by its folder at the promotion).
  const stamps = new Map<string, LeaderSwitchSessionStamp>()
  for (const { rec, rel } of rows) {
    if (rec.archived) continue
    const why = moveRefusal(rec, rel)
    // A stop asked again (the source job resumed): what the first one found stands (a turn it ended stays a turn).
    const prev = rec.leaderSwitch?.switchId === o.switchId && !rec.leaderSwitch.rolledBack ? rec.leaderSwitch : undefined
    const now = liveState(rec)
    const stopped = prev && prev.stopped !== 'none' ? prev.stopped : now
    const stamp: LeaderSwitchSessionStamp = {
      switchId: o.switchId, plan: why ? 'end' : 'move', ...(why ? { why } : {}),
      from: { machine: o.machine, home: o.home, cwd: rec.cwd! }, rel, stopped, at: prev?.at ?? at,
      ...(stopped !== 'none' ? { stopRequestId: stopRequestIdFor(o.switchId, rec.claudeSessionId) } : {}),
      ...(prev?.supervised !== undefined ? { supervised: prev.supervised } : {}),
    }
    stamps.set(rec.claudeSessionId, stamp)
    if (why) out.ends.push({ sid: rec.claudeSessionId, why })
    else out.moves++
  }
  // The rows first, then the stops: a stop's death edge finds the plan, and a turn that dies is a restart loss
  // (state pending: the next lead of the session, there or here, resumes it).
  await Promise.all(live.map(async ({ rec }) => {
    const stamp = stamps.get(rec.claudeSessionId)!
    if (stamp.supervised === undefined) stamp.supervised = await o.deps.supervised(rec.claudeSessionId).catch(() => false)
  }))
  for (const { rec } of rows) {
    const stamp = stamps.get(rec.claudeSessionId)
    if (!stamp) continue
    const patch: Partial<SessionRecord> = { leaderSwitch: stamp }
    if (stamp.stopped === 'turn' && !(rec.restartLoss?.cause === 'leader_switch' && rec.restartLoss.state === 'pending')) patch.restartLoss = turnLoss(rec, at)
    await o.deps.save(rec.claudeSessionId, patch)
  }
  const deadline = t0 + o.budgetMs
  const failed: string[] = []
  await Promise.all(live.map(async ({ rec }) => {
    const stamp = stamps.get(rec.claudeSessionId)!
    const left = Math.max(1, deadline - o.deps.now())
    const r = await withDeadline(o.deps.stop(rec, stamp.stopRequestId!), left, () => ({ ok: false as const, why: `it did not end within ${Math.round(o.budgetMs / 1000)} s` }))
      .catch((err: unknown) => ({ ok: false as const, why: err instanceof Error ? err.message : String(err) }))
    if (r.ok) out.stopped[stamp.stopped === 'turn' ? 'turn' : 'idle']++
    else failed.push(`${rec.title ?? rec.claudeSessionId} (${rec.claudeSessionId}): ${r.why}`)
  }))
  // What is still in the home: a session CLI the runtime did not end fails the stop; anything else is named.
  const known = new Map(rows.filter(({ rec }) => typeof rec.pid === 'number').map(({ rec }) => [rec.pid as number, rec]))
  const left = await o.deps.processesInHome(homeSpellings(o.home)).catch(() => [])
  for (const p of left) {
    const rec = known.get(p.pid)
    if (rec && liveState(rec) !== 'none') failed.push(`${rec.title ?? rec.claudeSessionId} (${rec.claudeSessionId}): its process ${p.pid} still runs in the data home`)
    else out.others.push(p)
  }
  out.ms = o.deps.now() - t0
  if (failed.length) {
    out.ok = false
    out.why = `a session in the data home did not stop for the switch, so the old home could still change after the final batch: ${failed.join('; ')}`
  }
  return out
}

/** A turn the switch stop ends: a restart loss, decided at the session's next lead (restart-loss.ts). */
function turnLoss(rec: SessionRecord, at: string): SessionRestartLoss {
  return {
    at, cause: 'leader_switch', lost: [], state: 'pending',
    before: { status: rec.process_status, ...(rec.lastActiveAt ? { lastActiveAt: rec.lastActiveAt } : {}), permission: !!rec.pendingPermission },
    ...(rec.statusRevision !== undefined ? { revision: rec.statusRevision } : {}),
  }
}

function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => resolve(onTimeout()), ms)
    t.unref?.()
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

// ---- a rollback -------------------------------------------------------------------------------------------------

export interface RollbackDeps {
  list(): Promise<SessionRecord[]>
  save(sid: string, patch: Partial<SessionRecord>): Promise<void>
  /** Cron supervision of `sid` on again, fenced by the stop's id (daemon cron.supervision). */
  reenable(sid: string, stopRequestId: string): Promise<void>
  /** Restart recovery's pass over pending losses (session-auto-recover.ts resumeUnfinished). */
  resume(): Promise<void>
  /** Release the messages held for the move (engine-switch-io.ts releaseMoveHeldRows). */
  release(sid: string): Promise<void>
}

/**
 * A switch that did not commit: the sessions its stop ended go on here, in place (their records never moved). Called
 * only once the home carries no marker of that switch (the marker goes first: else the spawn guard refuses them). Each
 * row keeps its stamp, marked rolled back, so this runs once. Returns how many were settled.
 */
export async function settleHomeSessionsAfterRollback(o: { home: string; isOpenSwitch: (switchId: string) => boolean; deps: RollbackDeps; now?: () => number }): Promise<number> {
  const at = new Date((o.now ?? Date.now)()).toISOString()
  let n = 0
  for (const { rec } of homeSessionRows(await o.deps.list(), o.home)) {
    const st = rec.leaderSwitch
    if (!st || st.rolledBack || st.moved || o.isOpenSwitch(st.switchId)) continue
    if (st.supervised && st.stopRequestId) await o.deps.reenable(rec.claudeSessionId, st.stopRequestId).catch(() => {})
    // Settled first, so the delivery the release starts finds the session free.
    await o.deps.save(rec.claudeSessionId, { leaderSwitch: { ...st, rolledBack: at } })
    await o.deps.release(rec.claudeSessionId).catch(() => {})
    n++
  }
  if (n) await o.deps.resume().catch(() => {})
  return n
}
