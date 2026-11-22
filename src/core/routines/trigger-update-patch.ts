/**
 * trigger_update's one rule for turning its arguments into a routine patch, and back
 * (src/ops/triggers.ts): the op builds the patch from the trigger as the server shows it,
 * and a host's follower, which answers trigger_update while the Mac is away
 * (replica/away-trigger-update.ts), names what a patch changed in the op's own arguments,
 * so the Mac replays exactly those (offline-handover.ts replays a `trigger_update` record
 * through this op) and the follower shows the changes it holds the same way.
 * Pure: no node imports.
 */

import { TRIGGER_DESCRIPTION_MAX, parseEveryMs } from './trigger-fields.js'
import { triggerWatchesOwnWork } from '../task-wait-wake.js'

/**
 * What trigger_update may change, by its input field. A trigger_create field that is
 * neither here nor in TRIGGER_UPDATE_NOT_EDITABLE fails tests/unit/ops/trigger-update.test.ts:
 * a new way to set up a trigger must be a way to change one too, or say why not
 * (2026-11-04: a too-short time limit could only be fixed by delete and arm again,
 * which lost the trigger's id and what it had seen).
 */
export const TRIGGER_UPDATE_FIELDS = [
  'every', 'timeoutSeconds', 'maxFiresPerDay', 'prompt', 'description', 'name', 'run', 'cwd', 'watches',
] as const

export type TriggerUpdateField = (typeof TRIGGER_UPDATE_FIELDS)[number]

/** What trigger_update changes on a scheduled routine: its words, never a check or its schedule. */
export const ROUTINE_UPDATE_FIELDS = ['prompt', 'description', 'name'] as const

export interface TriggerJobLike {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  ownWork?: boolean
  schedule?: { kind?: string; everyMs?: number }
  check?: { run?: string; cwd?: string; host?: string; timeoutSeconds?: number; maxFiresPerDay?: number; template?: unknown }
  executor?: { type?: string; config?: Record<string, unknown> }
}

/**
 * The routine patch for `args` on `current` (throws the op's own refusal): the fields named, and the
 * check carried over whole when one of its fields changes (the server replaces `check` wholesale).
 */
export function buildTriggerUpdatePatch(current: TriggerJobLike, args: Record<string, unknown>): { patch: Record<string, unknown>; given: TriggerUpdateField[] } {
  const id = String(args.id ?? current.id ?? '')
  const given = TRIGGER_UPDATE_FIELDS.filter((f) => args[f] !== undefined)
  if (!current.check) {
    // A scheduled routine (no check script): only its words change here; its schedule is the routine's own.
    const fixed = given.filter((f) => !ROUTINE_UPDATE_FIELDS.includes(f as never))
    if (current.executor?.type !== 'session') throw new Error(`${id} ("${current.name ?? ''}") is a scheduled routine that starts no session turn; change it in Routines`)
    if (fixed.length) throw new Error(`${id} ("${current.name ?? ''}") is a scheduled routine: only ${ROUTINE_UPDATE_FIELDS.join(', ')} change here, not ${fixed.join(', ')}`)
  }
  if (given.length === 0) {
    throw new Error(`nothing to change: pass at least one of ${TRIGGER_UPDATE_FIELDS.join(', ')}`)
  }
  if (current.check?.template && (args.run !== undefined || args.cwd !== undefined)) {
    throw new Error(`${id} is built from a plugin template, so Walnut writes its command; change its other fields here`)
  }
  const patch: Record<string, unknown> = {}
  if (args.watches !== undefined) patch.ownWork = args.watches === 'own'
  if (args.every !== undefined) {
    const everyMs = parseEveryMs(args.every)
    if (everyMs === null) throw new Error('every must be milliseconds, or a duration like "30s" / "5m" / "1h"')
    patch.schedule = { kind: 'every', everyMs }
  }
  if (args.description !== undefined) {
    const description = String(args.description).replace(/\s+/g, ' ').trim()
    if (!description) throw new Error('description cannot be blank: one or two plain sentences saying what it watches')
    if (description.length > TRIGGER_DESCRIPTION_MAX) {
      throw new Error(`description is ${description.length} characters; the limit is ${TRIGGER_DESCRIPTION_MAX} (one or two sentences)`)
    }
    patch.description = description
  }
  if (args.name !== undefined) {
    const name = String(args.name).trim()
    if (!name) throw new Error('name cannot be blank: a few plain words naming what it watches')
    patch.name = name
  }
  if (args.prompt !== undefined) {
    if (!String(args.prompt).trim()) throw new Error('prompt cannot be blank: what the session should do when it fires')
    const executor = current.executor ?? { type: 'session', config: {} }
    patch.executor = { ...executor, config: { ...(executor.config ?? {}), prompt: String(args.prompt) } }
  }
  const checkFields = (['run', 'cwd', 'timeoutSeconds', 'maxFiresPerDay'] as const).filter((f) => args[f] !== undefined)
  if (checkFields.length > 0) {
    const check: Record<string, unknown> = { ...current.check }
    for (const f of checkFields) check[f] = f === 'run' ? String(args.run).trim() : args[f]
    if (check.run === '') throw new Error('run cannot be blank: the shell command that decides whether to fire')
    if (check.cwd === '') delete check.cwd
    patch.check = check
  }
  return { patch, given }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const promptOf = (j: TriggerJobLike): string => text(j.executor?.config?.prompt)

/**
 * What changed from `before` to `after`, as trigger_update's own arguments (the inverse of
 * buildTriggerUpdatePatch): `{}` when nothing it can change did. Replayed on another row, it
 * changes only these fields there.
 */
export function triggerUpdateArgsOf(before: TriggerJobLike, after: TriggerJobLike): Partial<Record<TriggerUpdateField, unknown>> {
  const out: Partial<Record<TriggerUpdateField, unknown>> = {}
  const b = before.check ?? {}
  const a = after.check ?? {}
  if (typeof after.schedule?.everyMs === 'number' && after.schedule.everyMs !== before.schedule?.everyMs) out.every = after.schedule.everyMs
  if (typeof a.timeoutSeconds === 'number' && a.timeoutSeconds !== b.timeoutSeconds) out.timeoutSeconds = a.timeoutSeconds
  if (typeof a.maxFiresPerDay === 'number' && a.maxFiresPerDay !== b.maxFiresPerDay) out.maxFiresPerDay = a.maxFiresPerDay
  if (text(a.run).trim() !== text(b.run).trim()) out.run = text(a.run).trim()
  if (text(a.cwd) !== text(b.cwd)) out.cwd = text(a.cwd)
  if (promptOf(after) && promptOf(after) !== promptOf(before)) out.prompt = promptOf(after)
  if (text(after.description) && text(after.description) !== text(before.description)) out.description = text(after.description)
  if (text(after.name) && text(after.name) !== text(before.name)) out.name = text(after.name)
  const own = triggerWatchesOwnWork(after)
  if (own !== triggerWatchesOwnWork(before)) out.watches = own ? 'own' : 'outside'
  return out
}
