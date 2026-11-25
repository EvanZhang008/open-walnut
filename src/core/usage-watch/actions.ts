/**
 * The `usage_watch` op's actions (POST /api/v1/usage-watch): arm a watch, record an exemption,
 * drop a watch, list watches, read a target's numbers, read failed tool calls by session, op, code
 * or host, record a ship from another release tool, and the drill's probe. Answers stay small on purpose: a report lists at most 15 rows.
 */
import { lastShipOf, recordShip } from './ships.js'
import { readRange, usageReport, targetEvents, type ReportRow } from './report.js'
import { callerSide, ownFaults } from './agg.js'
import { ERROR_GROUPS, toolErrorsReport, type ErrorGroup } from './tool-errors.js'
import {
  EXEMPT_KINDS, MAX_CHECK_AFTER_MS, MIN_CHECK_AFTER_MS, getWatch, listWatches, newWatch, putWatch, targetProblem,
  type ExemptKind, type Watch, type WatchChecks,
} from './watches.js'

export class UsageWatchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export interface ActionContext {
  /** The calling session's task, or null for a person. */
  callerTask: string | null
  taskInfo: (id: string) => Promise<{ id: string; title: string; complete: boolean } | null>
  /** Whether the calling task stands above `taskId` (Main, its lead, a task above it): only then may it act for it. */
  standsAbove?: (callerTask: string, taskId: string) => Promise<boolean>
  now?: number
}

const PROBE_MAX = 55_000

/** `24h`, `90m`, `3d` → ms, or null. */
export function parseSpan(v: unknown): number | null {
  const m = typeof v === 'string' ? /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|d)\s*$/i.exec(v) : null
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  return Math.round(n * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000))
}

function readChecks(v: unknown): WatchChecks {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'object' || Array.isArray(v)) throw new UsageWatchError(400, 'bad_checks', 'checks must be an object: {"max_answer_chars":20000,"max_fail_pct":5,"no_new_codes":true,"max_p95_ms":2000,"min_uses":20}')
  const o = v as Record<string, unknown>
  const out: WatchChecks = {}
  const num = (k: keyof WatchChecks, lo: number, hi: number) => {
    if (o[k] === undefined) return
    const n = Number(o[k])
    if (!Number.isFinite(n) || n < lo || n > hi) throw new UsageWatchError(400, 'bad_checks', `checks.${k} must be a number from ${lo} to ${hi}`)
    ;(out as Record<string, unknown>)[k] = n
  }
  num('max_answer_chars', 100, 1_000_000)
  num('max_fail_pct', 0, 100)
  num('max_p95_ms', 10, 600_000)
  num('min_uses', 1, 100_000)
  if (o.no_new_codes !== undefined) out.no_new_codes = o.no_new_codes === true
  const unknown = Object.keys(o).filter((k) => !['max_answer_chars', 'max_fail_pct', 'max_p95_ms', 'min_uses', 'no_new_codes'].includes(k))
  if (unknown.length) throw new UsageWatchError(400, 'bad_checks', `checks takes max_answer_chars, max_fail_pct, no_new_codes, max_p95_ms, min_uses; not ${unknown.join(', ')}`)
  return out
}

async function subjectTask(body: Record<string, unknown>, ctx: ActionContext): Promise<string> {
  const named = typeof body.task === 'string' && body.task.trim() ? body.task.trim() : null
  const id = named ?? ctx.callerTask
  if (!id) throw new UsageWatchError(400, 'no_task', 'Name the task ("task":"<id>"): this call comes from no task\'s session.')
  const t = await ctx.taskInfo(id)
  if (!t) throw new UsageWatchError(404, 'unknown_task', `No task ${id}.`)
  // A session acts for its own task, or for one it leads: a watch or a ship of another task changes
  // whether that task may close.
  if (ctx.callerTask && t.id !== ctx.callerTask && !(await ctx.standsAbove?.(ctx.callerTask, t.id).catch(() => false))) {
    throw new UsageWatchError(403, 'not_yours', `Task ${t.id} is not this task and not one it leads: its own session names its watch.`)
  }
  return t.id
}

function watchView(w: Watch): Record<string, unknown> {
  return {
    id: w.id, task: w.taskId, state: w.state, targets: w.targets, checks: w.checks, who: w.who,
    ...(w.triggerId ? { trigger: w.triggerId } : {}), ...(w.exempt ? { exempt: w.exempt } : {}),
    set_at: new Date(w.createdAt).toISOString(), check_at: new Date(w.checkAt).toISOString(),
    ...(w.result ? { result: w.result.map((r) => ({ target: r.target, uses: r.uses, ok: r.ok, ...(r.notes.length ? { notes: r.notes } : {}), ...(r.callerSide ? { caller_side: r.callerSide } : {}) })) } : {}),
  }
}

function rowView(r: ReportRow): Record<string, unknown> {
  const base = { kind: r.kind, name: r.name, calls: r.calls }
  if (r.kind === 'op') {
    // failed: Walnut's own faults only; caller_side: bad arguments and designed refusals, never failures (agg.ts).
    return { ...base, failed: ownFaults(r), caller_side: callerSide(r), refused: r.refused, bad_args: r.badArgs, errors: r.errors + r.timeouts, unreachable: r.unreachable, cut: r.cut, over_limit: r.overLimit, answer_p95: r.sizeP95, largest: r.largest, codes: r.codes }
  }
  if (r.kind === 'http') return { ...base, slow: r.slow, server_errors: r.serverErrors, unreachable: r.unreachable, p95_ms: r.msP95, codes: r.codes }
  return base
}

/** The tools with the most calls on the caller's side (bad arguments, designed refusals), five at most. */
function callerTop(rows: readonly ReportRow[]): Array<Record<string, unknown>> {
  return rows.filter((r) => r.kind === 'op' && callerSide(r) > 0)
    .sort((a, b) => callerSide(b) - callerSide(a) || b.calls - a.calls).slice(0, 5)
    .map((r) => ({ name: r.name, calls: r.calls, bad_args: r.badArgs, refused: r.refused, pct: Math.round((callerSide(r) / Math.max(1, r.calls)) * 1000) / 10 }))
}

function problemScore(r: ReportRow): number {
  // The tool's own problems; the caller's side has its own list (callerTop).
  return r.cut * 100 + (r.errors + r.timeouts) * 10 + r.serverErrors * 10 + r.slow * 3 + r.overLimit * 2 + (r.kind === 'page' ? r.calls * 5 : 0)
}

/**
 * Each action with one call that works. 2026-11-24: sessions asked `{"action":"help"}` five times in
 * a week and each was refused as a bad argument, as were exemptions under kinds they made up.
 */
const USAGE_WATCH_HELP = {
  set: '{"action":"set","targets":["op:task_send","route:GET /api/tasks/:id","page:session"],"who":"this task","check_after":"24h"}',
  exempt: `{"action":"exempt","kind":"not_shipped","reason":"Investigation only: nothing was landed or deployed."} (kind: ${EXEMPT_KINDS.join(', ')})`,
  report: '{"action":"report","target":"op:task_send","range":"24h"} (no target: the names with the most problems)',
  errors: '{"action":"errors","by":"code","op":"task_send","range":"24h"} (by: op, code, session or host; session: one session or task; code: one error code\'s)',
  get: '{"action":"get","id":"uw-..."} (one watch: its targets, state and verdict)',
  list: '{"action":"list"}',
  drop: '{"action":"drop","id":"uw-..."}',
  ship: '{"action":"ship","how":"app store release"} (a ship another release tool made)',
  probe: '{"action":"probe","chars":30000} (an answer of filler characters, for testing the alarms)',
} as const

/** Deterministic filler with no content, dense in tokens (Braille cells), for the drill. */
export function probeFiller(chars: number): string {
  let s = ''
  for (let i = 0; i < chars; i++) s += String.fromCharCode(0x2800 + ((i * 2_654_435_761) >>> 24))
  return s
}

export async function runUsageWatchAction(body: Record<string, unknown>, ctx: ActionContext): Promise<Record<string, unknown>> {
  const now = ctx.now ?? Date.now()
  const action = String(body.action ?? '')
  switch (action) {
    case 'set': {
      const task = await subjectTask(body, ctx)
      const targets = Array.isArray(body.targets) ? body.targets.map(String) : typeof body.targets === 'string' ? [body.targets] : []
      const trigger = typeof body.trigger === 'string' && body.trigger.trim() ? body.trigger.trim() : undefined
      if (!targets.length && !trigger) throw new UsageWatchError(400, 'no_targets', 'Name what to watch: "targets":["op:<tool>","route:GET /api/...","page:<part>"] (or a "trigger" that checks it).')
      if (targets.length > 10) throw new UsageWatchError(400, 'too_many_targets', 'At most 10 targets in one watch.')
      for (const t of targets) { const p = targetProblem(t); if (p) throw new UsageWatchError(400, 'bad_target', p) }
      const span = parseSpan(body.check_after ?? '24h')
      if (span === null || span < MIN_CHECK_AFTER_MS || span > MAX_CHECK_AFTER_MS) throw new UsageWatchError(400, 'bad_check_after', 'check_after is a time from 1h to 14d, like "24h" or "3d".')
      const checks = readChecks(body.checks)
      let who = typeof body.who === 'string' && body.who.trim() ? body.who.trim() : 'this task'
      if (who !== 'this task') {
        const w = await ctx.taskInfo(who)
        if (!w || w.complete) throw new UsageWatchError(400, 'bad_who', `who is "this task" or the id of an open task that watches it; ${who} is ${w ? 'complete' : 'no task'}.`)
        who = w.id
      }
      const ship = lastShipOf(task)
      const w = newWatch({ taskId: task, targets, checks, who, ...(trigger ? { triggerId: trigger } : {}), ...(ship ? { shipAt: ship.at } : {}), checkAt: now + span, createdAt: now, by: ctx.callerTask ? `task:${ctx.callerTask}` : 'human' })
      putWatch(w)
      return {
        watch: watchView(w),
        outcome: `Watch ${w.id} armed on ${[...targets, ...(trigger ? [`trigger ${trigger}`] : [])].join(', ')} until ${new Date(w.checkAt).toISOString().slice(0, 16)} UTC.`,
        next: 'An alarm on these targets comes to this task until then; at the check time each target is judged and the result comes here.',
      }
    }
    case 'exempt': {
      const task = await subjectTask(body, ctx)
      const kind = String(body.kind ?? '') as ExemptKind
      if (!(EXEMPT_KINDS as readonly string[]).includes(kind)) throw new UsageWatchError(400, 'bad_kind', `kind is one of ${EXEMPT_KINDS.join(', ')}.`)
      const reason = typeof body.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim() : ''
      if (reason.length < 20 || reason.length > 500) throw new UsageWatchError(400, 'bad_reason', 'reason says in 20 to 500 characters why nothing in real use can show this change.')
      const w = newWatch({ taskId: task, targets: [], checks: {}, who: 'this task', checkAt: now, createdAt: now, state: 'exempt', exempt: { kind, reason }, by: ctx.callerTask ? `task:${ctx.callerTask}` : 'human' })
      putWatch(w)
      return { watch: watchView(w), outcome: `Recorded: no watch for this ship (${kind}): ${reason}`, next: 'Complete the task again.' }
    }
    case 'get': {
      // 2026-11-24: two sessions asked for a watch by the id its alarm named, and were refused.
      const id = String(body.id ?? '').trim()
      const w = id ? getWatch(id) : null
      if (!w) throw new UsageWatchError(404, 'unknown_watch', id ? `No watch ${id}.` : 'Name the watch: "id":"uw-...".')
      return { watch: watchView(w), outcome: `Watch ${id} of task ${w.taskId}: ${w.state}.` }
    }
    case 'drop': {
      const id = String(body.id ?? '')
      const w = getWatch(id)
      if (!w) throw new UsageWatchError(404, 'unknown_watch', `No watch ${id}.`)
      if (ctx.callerTask && ctx.callerTask !== w.taskId && ctx.callerTask !== w.who) throw new UsageWatchError(403, 'not_yours', `Watch ${id} belongs to task ${w.taskId}.`)
      putWatch({ ...w, state: 'dropped', checkedAt: now })
      return { watch: watchView({ ...w, state: 'dropped' }), outcome: `Watch ${id} dropped.` }
    }
    case 'list': {
      const task = typeof body.task === 'string' && body.task.trim() ? body.task.trim() : ctx.callerTask
      const rows = task ? listWatches({ taskId: task, limit: 30 }) : listWatches({ states: ['watching'], limit: 30 })
      return { watches: rows.map(watchView), outcome: `${rows.length} watch(es)${task ? ` of task ${task}` : ' armed'}.` }
    }
    case 'report': {
      const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : undefined
      if (target) { const p = targetProblem(target); if (p) throw new UsageWatchError(400, 'bad_target', p) }
      const range = readRange(body.range)
      const rep = usageReport(range, { now, ...(target ? { target } : {}) })
      const rows = rep.rows.sort((a, b) => problemScore(b) - problemScore(a) || b.calls - a.calls).slice(0, 15)
      return {
        range, from: new Date(rep.from).toISOString(), recorded: rep.recorded,
        rows: rows.map(rowView),
        // The caller's side, reported apart: the tools agents most often call wrong or a rule refuses.
        ...(target ? {} : { caller_side: callerTop(rep.rows) }),
        ...(target ? { recent_problems: targetEvents(target, 10).map((e) => ({ at: new Date(e.at).toISOString(), problem: e.problem, ...(e.code ? { code: e.code } : {}), ...(e.chars ? { size: e.chars } : {}), ...(e.ms ? { ms: e.ms } : {}) })) } : {}),
        outcome: `${rep.rows.length} name(s) recorded in ${range}${rep.rows.length > 15 ? '; the 15 with the most problems listed' : ''}.`,
      }
    }
    case 'errors': {
      const by = (body.by === undefined ? 'op' : String(body.by)) as ErrorGroup
      if (!(ERROR_GROUPS as readonly string[]).includes(by)) throw new UsageWatchError(400, 'bad_by', `by is one of ${ERROR_GROUPS.join(', ')}.`)
      const session = typeof body.session === 'string' && body.session.trim() ? body.session.trim().slice(0, 80) : undefined
      // A tool named as a report's target ("op:thread_update") is the same filter as op.
      const target = typeof body.target === 'string' ? body.target.trim() : ''
      if (target && !target.startsWith('op:')) throw new UsageWatchError(400, 'bad_target', `errors reads failed tool calls: name the tool as "op":"<tool>" (or "target":"op:<tool>"); ${target} is not one. A route's or a page's numbers are in report.`)
      const op = typeof body.op === 'string' && body.op.trim() ? body.op.trim().slice(0, 80) : target ? target.slice(3).slice(0, 80) : undefined
      const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim().slice(0, 80) : undefined
      const range = readRange(body.range)
      const rep = toolErrorsReport({ range, by, now, ...(session ? { session } : {}), ...(op ? { op } : {}), ...(code ? { code } : {}) })
      return {
        ...rep,
        outcome: `${rep.total} failed Walnut tool call(s) in ${range}${op ? ` of ${op}` : ''}${code ? ` with code ${code}` : ''}${session ? ` of ${session}` : ''}, by ${by}${rep.more ? `; the ${rep.rows.length} with the most listed` : ''}.`,
        next: 'by: op, code, session or host; op: one tool\'s failures; code: one error code\'s; session: a session or task id (or its start) for its own failures one by one.',
      }
    }
    case 'ship': {
      const task = await subjectTask(body, ctx)
      const how = typeof body.how === 'string' && body.how.trim() ? body.how.trim().slice(0, 60) : 'release tool'
      recordShip({ taskId: task, key: `op-${now}`, at: now, how, state: 'done' })
      return { outcome: `Recorded a ship of task ${task} (${how}).`, next: 'Arm a watch on what it changed (usage_watch set) before the task completes.' }
    }
    case 'probe': {
      const n = Math.round(Number(body.chars ?? 40_000))
      if (!Number.isFinite(n) || n < 1 || n > PROBE_MAX) throw new UsageWatchError(400, 'bad_chars', `chars is from 1 to ${PROBE_MAX}.`)
      return { probe: probeFiller(n), chars: n, outcome: `A probe answer of ${n} filler characters (no content), for testing the real-use alarms.` }
    }
    case 'help':
      return { actions: USAGE_WATCH_HELP, outcome: `usage_watch takes ${Object.keys(USAGE_WATCH_HELP).length} actions, each with an example.` }
    default:
      throw new UsageWatchError(400, 'bad_action', 'action is one of set, exempt, get, drop, list, report, errors, ship, probe, help.')
  }
}
