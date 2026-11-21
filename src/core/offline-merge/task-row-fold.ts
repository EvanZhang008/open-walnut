/**
 * How a reader shows a task while writes to it wait in a host's journal for the Mac
 * (read-your-writes away from the Mac), in ONE place: the host replica's overlay
 * (src/replica/overlay.ts, the console and the phone on the replica) folds with the Mac's
 * full phase rules as `withValues` (write-port.ts: status, completed_at and the read marker
 * a phase implies). The daemon's own offline answers still fold with their older copy
 * (offline-host-core.ts tasksWithOverlay) until the host's Walnut server answers those calls.
 *
 * For readers only (never a write's base), a session the host started alone for a task its
 * journal still makes is folded in too, at its place in time among the records (foldAwayStart):
 * the link the Mac writes when its drain adopts the session.
 *
 * Also the id a writer away from the Mac mints for a new task (`mintTaskId`): the
 * replica's write port uses it, and so does the Mac's drain when an id it receives is
 * taken (apply-v2.ts).
 */

import { projectOrInbox } from '../inbox-project.js'
import { pluginOnlyForCaller } from '../plugins/plugin-task-visibility.js'
import { pointTaskAtSession, slotOfMode } from '../sessions/task-session-link.js'

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
    id, phase: 'TODO', status: 'todo', priority: 'none', project: projectOrInbox(placement.project), created_at: iso, updated_at: iso,
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
}

/**
 * A start folded over the task's row for its readers: the link the Mac writes when its drain
 * adopts the session (apply-session.ts linkAdopted: task-session-link.ts), and nothing else.
 *   - A row that already names a session keeps it (the link is never put over another one).
 *   - A stopped or errored session keeps session_id and session_ids but holds no plan/exec slot,
 *     as the Mac clears the slot when a session ends (task-manager.ts clearSessionSlot).
 *   - The phase stays the journal's: the Mac's drain adopts the session, it does not replay a
 *     start's phase, so the Mac shows the same row after it.
 */
export function foldAwayStart(row: Record<string, unknown>, s: AwayStart): Record<string, unknown> {
  const named = typeof row.session_id === 'string' && row.session_id !== ''
  if (named || (Array.isArray(row.session_ids) && row.session_ids.length > 0)) return row
  const out = { ...row }
  const ended = s.status === 'stopped' || s.status === 'error'
  pointTaskAtSession(out as Parameters<typeof pointTaskAtSession>[0], s.sid, ended ? undefined : slotOfMode(s.mode))
  if (ended) { delete out.plan_session_id; delete out.exec_session_id }
  return out
}
