/**
 * trigger_update while the Mac is away, a host's own session call (task B; away-triggers.ts has
 * the other trigger calls). The op runs here as on the Mac (src/ops/triggers.ts): it reads the
 * trigger as this host shows it (the routines copy's whole row, with what this host changed and
 * switched over it) and sends its patch (core/routines/trigger-update-patch.ts) to
 * PATCH /v1/routines/:id, which lands here. The patch is checked and merged onto that row with the
 * Mac's own functions (normalizeCronJobPatch, routines-core.ts checkShapeForSave,
 * assertWakeNotOnCheck, validateExecutorForSave, cron/jobs.ts applyJobPatch), and the daemon gets,
 * through `follower.op` (offline-host-core.ts followerTriggerUpdate):
 *
 *   args   the fields the change made, as trigger_update's own arguments: the `trigger_update` op
 *          record the Mac replays through the op on its return (offline-handover.ts), so only those
 *          fields change there and a field the Mac changed meanwhile that this host did not stays
 *   def    the changed trigger as the daemon runs it (trigger-push.ts checkDefOf): armed at once
 *   on     whether it ran when changed (a change never switches it on or off)
 *
 * The Mac must drain `trigger-update` (an older one: the daemon answers needs_leader mac_too_old),
 * and the daemon must take the op (an older one: not_queueable, handed back as before).
 *
 * What only the Mac decides answers needs_leader (why `fields`) for those fields alone, naming
 * each and why (LEADER_ONLY_TRIGGER_FIELDS); a trigger whose check runs on another host, or a
 * scheduled routine with no check (its clock is placed by the Mac), needs the Mac whole.
 */

import type { Request } from 'express'
import type { ReplicaWrite } from './dispatch.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type WriteActor } from './write-port.js'
import { bodyOf, settleCall } from './away-calls.js'
import { normalizeCronJobPatch } from '../core/cron/normalize.js'
import { applyJobPatch } from '../core/cron/jobs.js'
import type { CronJob, CronJobPatch } from '../core/cron/types.js'
import { checkDefOf, type CheckJob } from '../core/routines/trigger-push.js'
import { buildTriggerUpdatePatch, triggerUpdateArgsOf, type TriggerJobLike } from '../core/routines/trigger-update-patch.js'
import { DELIVER_PROMPT_MAX } from '../providers/trigger-check-core.js'

type Job = Record<string, unknown>

/** The routine patch keys trigger_update sends (buildTriggerUpdatePatch). */
const UPDATE_PATCH_KEYS = new Set(['schedule', 'check', 'description', 'name', 'executor', 'ownWork'])

/** Why a field of a change is the Mac's alone, by trigger_update's name for it (else the patch's). */
export const LEADER_ONLY_TRIGGER_FIELDS: Readonly<Record<string, string>> = {
  host: 'moving a check to another host disarms it here and arms it there, and only your Mac reaches both',
  template: 'a template trigger\'s command is built by your Mac from its plugin\'s params',
  session: 'the task a trigger wakes is its owner, which only your Mac changes',
  prompt: `this host delivers the fires itself while your Mac is away, and a prompt over ${DELIVER_PROMPT_MAX / 1024} KB does not fit what it carries`,
  enabled: 'a pause or a resume goes alone here (trigger_pause, trigger_resume)',
  // routines-core.ts settleCheckActsFor: a new command or folder is the writer's check, so the task it
  // acts for (whose grants its `walnut` calls get: hosts/trigger-caller.ts) changes with it.
  run: 'who a check acts for is decided by your Mac when what it runs changes',
  cwd: 'who a check acts for is decided by your Mac when where it runs changes',
  check: 'removing a check makes it a scheduled routine, whose clock and grants your Mac decides',
}
const OTHER_FIELD = 'only what trigger_update changes is changed on this host'

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** `row` with a normalized patch merged by the Mac's own merge (a copy; throws its refusal). */
function merged(row: Job, patch: CronJobPatch): Job {
  const job = structuredClone(row) as unknown as CronJob
  applyJobPatch(job, patch)
  return job as unknown as Job
}

/**
 * The row with the changes made here over it (followerTriggers `changes`, trigger_update's arguments);
 * null when the Mac's merge refuses them on this row (the copy changed under them: the Mac made it a
 * template check, say), which says nothing of what the daemon runs.
 */
export function withChanges(row: Job, changes: Record<string, unknown> | undefined, onRefused?: (err: unknown) => void): Job | null {
  if (!changes || Object.keys(changes).length === 0) return row
  try {
    const patch = normalizeCronJobPatch(buildTriggerUpdatePatch(row as TriggerJobLike, { ...changes, id: row.id }).patch)
    return patch ? merged(row, patch) : row
  } catch (err) {
    onRefused?.(err)
    return null
  }
}

/** What a trigger's armed def runs, laid over its row: name, interval, command, folder, time limit, target, prompt. */
export function armedOver(row: Job, def: ArmedDef): Job {
  const check: Record<string, unknown> = { ...((row.check as Record<string, unknown> | undefined) ?? {}), run: def.check.run }
  if (def.check.cwd) check.cwd = def.check.cwd
  else delete check.cwd
  if (typeof def.check.timeoutSeconds === 'number') check.timeoutSeconds = def.check.timeoutSeconds
  const executor = (row.executor ?? { type: 'session', config: {} }) as { type?: unknown; config?: Record<string, unknown> }
  const config = { ...(executor.config ?? {}) }
  if (def.deliver?.taskId) config.target = def.deliver.taskId
  if (typeof def.deliver?.prompt === 'string') config.prompt = def.deliver.prompt
  return {
    ...row, name: def.name, schedule: { ...((row.schedule as Record<string, unknown> | undefined) ?? {}), kind: 'every', everyMs: def.everyMs },
    check, executor: { ...executor, config },
  }
}

type ArmedDef = { id: string; name: string; everyMs: number; check: { run: string; cwd?: string; timeoutSeconds?: number }; deliver?: { taskId?: string; prompt?: string } }

/** Triggers whose changes here the copy's row refused, warned about once each (bounded). */
const warnedUnmerged = new Set<string>()

/**
 * A trigger's row with what this host changed: the Mac's merge of the changes, or, when that merge
 * refuses them, the def the daemon runs laid over the copy's row, so a read never shows a trigger
 * other than the one that runs here (warned once per trigger).
 */
export function rowWithHereChanges(row: Job, def: ArmedDef, changes: Record<string, unknown> | undefined, warn: (msg: string, data: Record<string, unknown>) => void): Job {
  let why = ''
  const out = withChanges(row, changes, (err) => { why = err instanceof Error ? err.message : String(err) })
  if (out) return out
  if (!warnedUnmerged.has(def.id)) {
    if (warnedUnmerged.size >= 500) warnedUnmerged.clear()
    warnedUnmerged.add(def.id)
    warn('replica: a trigger\'s changes on this host no longer merge onto the copy\'s row; it reads as its armed def', { triggerId: def.id, fields: Object.keys(changes ?? {}), error: why })
  }
  return armedOver(row, def)
}

/** Test hook: forget which triggers were warned about. */
export function _resetUnmergedWarningsForTesting(): void { warnedUnmerged.clear() }

/** The fields of a patch on `row` only the Mac may change (empty: none). */
export function leaderOnlyTriggerFields(row: TriggerJobLike, body: Record<string, unknown>): string[] {
  const out = Object.keys(body).filter((k) => body[k] !== undefined && !UPDATE_PATCH_KEYS.has(k))
  const check = body.check && typeof body.check === 'object' ? body.check as Record<string, unknown> : null
  if (check) {
    if (str(check.host) !== str(row.check?.host)) out.push('host')
    if (!same(check.template, row.check?.template)) out.push('template')
    // As check-host-policy.ts checkCommandChanged compares them (trimmed).
    if (str(check.run) !== str(row.check?.run)) out.push('run')
    if (str(check.cwd) !== str(row.check?.cwd)) out.push('cwd')
  } else if ('check' in body && body.check === null) {
    out.push('check')
  }
  const ex = body.executor && typeof body.executor === 'object' ? body.executor as { type?: unknown; config?: Record<string, unknown> } : null
  if (ex) {
    const { prompt, instructions: _ia, ...after } = ex.config ?? {}
    const { prompt: _pb, instructions: _ib, ...before } = row.executor?.config ?? {}
    if (ex.type !== row.executor?.type || !same(after, before)) out.push('session')
    if (typeof prompt === 'string' && prompt.length > DELIVER_PROMPT_MAX) out.push('prompt')
  }
  return out
}

export interface TriggerUpdateDeps {
  hostKey: string
  /** The trigger as this host shows it (the row a GET answers), 'deleted' when deleted here, null when it holds none. */
  row(id: string): Promise<Job | 'deleted' | null>
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

const needsMac = (message: string): PortAnswer => needsLeaderAnswer('routine_writes_need_mac', `${message} Nothing was changed.`)

/** PATCH /v1/routines/:id with any change but on/off: trigger_update, decided here. */
export async function updateHere(deps: TriggerUpdateDeps, req: Request, w: ReplicaWrite, actor: WriteActor, id: string): Promise<PortAnswer> {
  const row = await deps.row(id)
  if (row === 'deleted') return refusalAnswer('not_found', `No trigger ${id}: it was deleted on this host`)
  if (!row) return needsMac(`Trigger ${id} is not in this host's copy; changing it needs your Mac.`)
  const current = row as TriggerJobLike
  if (!current.check) return needsMac(`"${current.name ?? id}" is a scheduled routine, whose clock your Mac places; changing it needs your Mac.`)
  const checkHost = str(current.check.host) || '__local__'
  if (checkHost !== deps.hostKey) return needsMac(`Trigger ${id}'s check runs on host "${checkHost}", not on this host; changing it needs your Mac.`)
  const body = bodyOf(req)
  const mac = leaderOnlyTriggerFields(current, body)
  if (mac.length) {
    const reasons = Object.fromEntries(mac.map((f) => [f, LEADER_ONLY_TRIGGER_FIELDS[f] ?? OTHER_FIELD]))
    return needsLeaderAnswer('fields', `${mac.map((f) => `${f} (${reasons[f]})`).join('; ')}: only your Mac changes ${mac.length > 1 ? 'these' : 'this'}; nothing of this change was saved. Change the other fields alone here, or this once your Mac is back.`, { fields: mac, reasons })
  }
  let after: Job
  try {
    // The Mac's own checks of a routine patch, those that ask no daemon (patchRoutine).
    const patch = normalizeCronJobPatch(body)
    if (!patch) return refusalAnswer('bad_request', 'Invalid patch input.')
    const { assertWakeNotOnCheck, checkShapeForSave, validateExecutorForSave } = await import('../core/routines/routines-core.js')
    const { getExecutor } = await import('../core/routines/registry.js')
    const type = (patch.executor as { type?: unknown } | undefined)?.type
    if (typeof type === 'string' && getExecutor(type)) await validateExecutorForSave(patch)
    assertWakeNotOnCheck(patch, row as unknown as CronJob)
    checkShapeForSave(patch, body, row as unknown as CronJob)
    after = merged(row, patch)
  } catch (err) {
    return refusalAnswer('bad_request', err instanceof Error ? err.message : String(err))
  }
  const name = String(after.name ?? current.name ?? id)
  const on = current.enabled !== false
  const args = triggerUpdateArgsOf(current, after as TriggerJobLike)
  if (Object.keys(args).length === 0) {
    return { answered: false, status: 200, body: { id, name, state: on ? 'armed' : 'paused', changed: false, offline: true, outcome: `"${name}" already has these settings; nothing changed.`, next: 'Nothing else is required.' } }
  }
  if ((after.schedule as { kind?: unknown } | undefined)?.kind !== 'every') return needsMac(`Trigger ${id} does not poll on an interval; changing it needs your Mac.`)
  const def = checkDefOf(after as unknown as CheckJob)
  const a = settleCall(await w.submit('trigger_update', { id, args: { id, ...args }, def, on }, undefined, actor), 200)
  if (!a.answered && a.status === 200) deps.log('info', 'replica: a trigger was changed on this host while the Mac is away', { triggerId: id, fields: Object.keys(args), opId: w.opId })
  return a
}
