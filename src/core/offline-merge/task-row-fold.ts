/**
 * How a reader shows a task while writes to it wait in a host's journal for the Mac
 * (read-your-writes away from the Mac), in ONE place: the host replica's overlay
 * (src/replica/overlay.ts, the console and the phone on the replica) folds with the Mac's
 * full phase rules as `withValues` (write-port.ts: status, completed_at and the read marker
 * a phase implies). The daemon's own offline answers still fold with their older copy
 * (offline-host-core.ts tasksWithOverlay) until the host's Walnut server answers those calls.
 *
 * A session the host started alone for the task (away-starts.ts, ask-launch.ts) is folded in
 * too, at its place in time among the records (foldAwayStart, foldAwayTurn): the link the Mac
 * writes when it adopts the session, and the phase the Mac's session rules give its turns.
 *
 * Also the id a writer away from the Mac mints for a new task (`mintTaskId`): the
 * replica's write port uses it, and so does the Mac's drain when an id it receives is
 * taken (apply-v2.ts).
 */

import { pluginOnlyForCaller } from '../plugins/plugin-task-visibility.js'
import { pointTaskAtSession, slotOfMode } from '../sessions/task-session-link.js'
import { sessionAwaitingHumanPhase, sessionErrorPhase, sessionResultPhase, sessionTurnStartPhase } from '../phase.js'
import type { TaskPhase } from '../types.js'

/** A task row as a reader shows it. */
export type FoldRow = Record<string, unknown> & { id: string }

/** Where a create places its task (a `task-create` record's `placement`). */
export interface FoldPlacement { parentTaskId?: string; project?: string; groupId?: string; tier?: string }

/** A pending journal record, as far as the fold reads it. */
export interface FoldRecord {
  kind: string
  fields?: unknown
  placement?: unknown
  tier?: unknown
  op?: unknown
  args?: unknown
  actor?: unknown
}

/** A row with a write's values on it, and what those values imply (a phase's status, say). */
export type WithValues = (row: Record<string, unknown>, values: Record<string, unknown>, atIso: string) => Record<string, unknown>

/** A new task's id: its time, then 8 random bytes (two writers never collide). */
export function mintTaskId(now: number, randomHex: (bytes: number) => string): string {
  return `${now.toString(36)}-${randomHex(8)}`
}

/** Whether a journal record's maker gets the human create defaults (a device, a trigger, a plugin job: not a session). */
export function madeByHuman(actor: unknown): boolean {
  return !(actor && typeof actor === 'object' && (actor as { kind?: unknown }).kind === 'session')
}

/**
 * The plugin that keeps a task a plugin job made (Task.plugin_only): the function the Mac's
 * create stamps it by (journal-actor.ts createCaller), so a follower's board leaves it out too.
 */
export function keptByMaker(actor: unknown): string | undefined {
  const a = actor as { kind?: unknown; plugin?: unknown } | null | undefined
  return a && a.kind === 'plugin-job' && typeof a.plugin === 'string' ? pluginOnlyForCaller(undefined, a.plugin) : undefined
}

/**
 * A task made away from the Mac as readers show it until the Mac's row comes back in a
 * copy, by its maker (the record's actor). A maker that is not a session gets the Mac's
 * human default (pinned, on the board in Satellite, unless it said otherwise:
 * task-manager.ts newTaskPinDefault, offline-merge/apply-v2.ts createTask); a tier always
 * means pinned. A plugin job whose plugin keeps its tasks makes one kept to that plugin's
 * view (`plugin_only`), never pinned, in no tier, as the Mac's create makes it.
 */
export function createdRow(id: string, fields: Record<string, unknown>, placement: FoldPlacement, at: number, maker?: unknown): FoldRow {
  const iso = new Date(at).toISOString()
  const keptBy = keptByMaker(maker)
  const pinned = keptBy ? false : placement.tier ? true : typeof fields.pinned === 'boolean' ? fields.pinned : madeByHuman(maker) ? true : undefined
  return {
    id, phase: 'TODO', status: 'todo', priority: 'none', project: placement.project ?? '', created_at: iso, updated_at: iso,
    ...(placement.groupId ? { group_id: placement.groupId } : {}),
    ...(placement.parentTaskId ? { parent_task_id: placement.parentTaskId } : {}),
    ...(placement.tier && !keptBy ? { focus_tier: placement.tier } : {}),
    ...fields,
    ...(pinned !== undefined ? { pinned } : {}),
    ...(keptBy ? { plugin_only: keptBy } : {}),
  }
}

/**
 * One pending record folded over a task's row (null: the reader has no row for it yet).
 * A create makes the row when there is none (a copy that holds it already wins); a field
 * write lays its values on through `withValues`; a move sets the tier; a v1 gateway
 * write (`op` task_update / task_complete) lays its arguments on. Any other kind leaves
 * the row as it is. Never mutates its input.
 */
export function foldTaskRecord(row: Record<string, unknown> | null, id: string, rec: FoldRecord, at: number, withValues: WithValues): Record<string, unknown> | null {
  if (rec.kind === 'task-create') {
    if (row) return row
    const placement = (rec.placement && typeof rec.placement === 'object' ? rec.placement : {}) as FoldPlacement
    const fields = (rec.fields && typeof rec.fields === 'object' ? rec.fields : {}) as Record<string, unknown>
    return createdRow(id, fields, placement, at, rec.actor)
  }
  if (!row) return null
  if (rec.kind === 'task-fields') {
    const values: Record<string, unknown> = {}
    for (const [k, w] of Object.entries((rec.fields ?? {}) as Record<string, { value?: unknown } | undefined>)) values[k] = w ? w.value : undefined
    return withValues(row, values, new Date(at).toISOString())
  }
  if (rec.kind === 'task-move') return typeof rec.tier === 'string' ? { ...row, focus_tier: rec.tier } : row
  if (rec.kind === 'op') {
    const args = (rec.args ?? {}) as Record<string, unknown>
    if (rec.op === 'task_complete') return withValues(row, { phase: 'COMPLETE' }, new Date(at).toISOString())
    if (rec.op !== 'task_update') return row
    const values: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) if (k !== 'id') values[k] = v
    return withValues(row, values, new Date(at).toISOString())
  }
  return row
}

/**
 * A session this host started alone for a task, as the reader fold takes it (a host replica's
 * session row: session-tracker.ts awaySessionsOfTask). Times are on this host's clock, as the
 * journal's record times are.
 */
export interface AwayStart {
  sid: string
  /** When it started (ms). */
  at: number
  mode?: string
  /** Its process status as this host's daemon last reported it (ask-launch.ts hostSessionStatus). */
  status?: string
  /** Its transcript's last write (ms), when known. */
  activeAt?: number
  /** A permission prompt waits for a person. */
  prompt?: boolean
}

/**
 * A start folded over the task's row: the link the Mac writes when its drain adopts the session
 * (apply-session.ts linkAdopted: the slot by its mode, then the list; task-session-link.ts), and
 * the phase the Mac's start gives it. The Mac moves that phase through the session's own events,
 * never a journal record its drain replays: the first message is a turn start (phase.ts
 * sessionTurnStartPhase, IN_PROGRESS unless done).
 */
export function foldAwayStart(row: Record<string, unknown>, s: AwayStart, withValues: WithValues): Record<string, unknown> {
  const out = { ...row }
  pointTaskAtSession(out as Parameters<typeof pointTaskAtSession>[0], s.sid, slotOfMode(s.mode))
  const iso = new Date(s.at).toISOString()
  out.last_session_update = iso
  const next = sessionTurnStartPhase(String(out.phase ?? 'TODO') as TaskPhase)
  return next ? withValues(out, { phase: next }, iso) : out
}

/**
 * The session's live state folded over the row, by the Mac's session rules (phase.ts), when its
 * transcript moved after the row's last phase change (`phaseAt`): a prompt for a person hands the
 * task back, a running turn pulls it to IN_PROGRESS, a turn that ended (idle) hands it back, a
 * process that ended mid-turn (stopped) is an error's hand-back. A later phase write (a
 * task_update of its own, a completion) is newer than the turn, and stays.
 */
export function foldAwayTurn(row: Record<string, unknown>, s: AwayStart, phaseAt: number, withValues: WithValues): Record<string, unknown> {
  if (s.activeAt === undefined || !(s.activeAt > phaseAt)) return row
  const cur = String(row.phase ?? 'TODO') as TaskPhase
  const next = s.prompt ? sessionAwaitingHumanPhase(cur)
    : s.status === 'running' ? sessionTurnStartPhase(cur)
    : s.status === 'idle' ? sessionResultPhase(cur)
    : s.status === 'stopped' || s.status === 'error' ? sessionErrorPhase(cur)
    : null
  return next ? withValues(row, { phase: next }, new Date(s.activeAt).toISOString()) : row
}
