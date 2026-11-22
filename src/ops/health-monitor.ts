/**
 * The health monitor's ops (core/health-monitor/): read Walnut's own alarms, and
 * change one the way a person does on the Health page (threshold, mute, off).
 * Named `health_monitor` because `health_*` ops are the user's Apple Health data.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { clipText } from './doc-page.js'
import { withOutcome } from './outcome.js'

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v ? clipText(v, max) : undefined
const iso = (ms: unknown): string | undefined => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined)

/** health_monitor's cap: every alarm in a line or two. */
const LIST_MAX = 10_000
const LIST_HEAD_ROOM = 1_200
/** A detail's history: its newest entries. */
const HISTORY_SHOWN = 10

/**
 * One alarm in the facts an agent decides on: its state and value against its condition, whether
 * its actions are held, its fix task and what Walnut last did. The 24-hour spark and the long
 * description are left out (health_monitor {"alarm"} reads them). An OK alarm is a shorter line.
 */
function alarmLine(value: unknown): Record<string, unknown> {
  const a = rec(value)
  const o = rec(a.override)
  const actions = Array.isArray(a.actions) ? a.actions.map(rec) : []
  const last = actions[actions.length - 1]
  const head = {
    id: a.id,
    title: a.title,
    state: a.state,
    value: a.value,
    ...(a.unit ? { unit: a.unit } : {}),
    ...(a.held ? { held: true } : {}),
  }
  if (a.state === 'OK' && !a.fixTaskId && !o.ownerTask) return head
  return {
    ...head,
    since: iso(a.since),
    condition: a.condition,
    ...(a.signature ? { signature: clip(a.signature, 120) } : {}),
    ...(a.labels ? { labels: a.labels } : {}),
    ...(a.fixTaskId ? { fixTaskId: a.fixTaskId } : {}),
    ...(o.ownerTask ? { ownerTask: o.ownerTask } : {}),
    ...(typeof o.mutedUntil === 'number' ? { mutedUntil: iso(o.mutedUntil) } : {}),
    ...(o.enabled === false ? { enabled: false } : {}),
    ...(last ? { actions: actions.length, lastAction: `${String(last.kind)} ${last.ok ? 'ok' : 'failed'} at ${iso(last.at) ?? '?'}: ${clip(last.detail, 120) ?? ''}` } : {}),
  }
}

/** A detail's minute series as a summary and its last hour; `_full` reads every point. */
function seriesSummary(series: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(series) || !series.length) return undefined
  const points = series.map(rec)
  const values = points.map((p) => p.v).filter((v): v is number => typeof v === 'number')
  return {
    points: points.length,
    from: iso(points[0].t),
    to: iso(points[points.length - 1].t),
    ...(values.length ? { min: Math.min(...values), max: Math.max(...values), last: values[values.length - 1] } : { noData: true }),
    lastPoints: points.slice(-30).map((p) => p.v ?? null),
  }
}

function alarmDetailShort(value: unknown): Record<string, unknown> {
  const d = rec(value)
  const history = Array.isArray(d.history) ? d.history.map(rec) : []
  const series = seriesSummary(d.series)
  return {
    ...alarmLine(d),
    since: iso(d.since),
    condition: d.condition,
    ...(clip(d.description, 300) ? { description: clip(d.description, 300) } : {}),
    ...(Array.isArray(d.spark) ? { spark: d.spark } : {}),
    ...(series ? { series } : {}),
    ...(history.length ? {
      history: history.slice(-HISTORY_SHOWN).reverse().map((h) => `${iso(h.at) ?? '?'} ${String(h.from)} -> ${String(h.to)} (${String(h.value)}): ${clip(h.reason, 140) ?? ''}`),
      ...(history.length > HISTORY_SHOWN ? { historyCount: history.length } : {}),
    } : {}),
    ...(clip(d.sample, 400) ? { sample: clip(d.sample, 400) } : {}),
    ...(series || history.length > HISTORY_SHOWN ? { more: 'The minute series and the whole history: repeat this call with "_full": true.' } : {}),
  }
}

/** The alarms that fit the cap, in the route's order (ALARM first); the rest are counted with the call that reads them. */
function alarmList(result: unknown, max = LIST_MAX): unknown {
  const r = rec(result)
  if (!Array.isArray(r.alarms)) return result
  const budget = Math.max(1_000, max - LIST_HEAD_ROOM)
  const kept: Record<string, unknown>[] = []
  let used = 0
  for (const a of r.alarms) {
    const line = alarmLine(a)
    const n = JSON.stringify(line).length + 1
    if (kept.length && used + n > budget) break
    kept.push(line)
    used += n
  }
  const left = r.alarms.length - kept.length
  const leftStates = [...new Set(r.alarms.slice(kept.length).map((a) => String(rec(a).state)))]
  return {
    ...r,
    alarms: kept,
    ...(left ? {
      more: `${left} more alarm(s) not shown (${leftStates.join(', ')}): health_monitor ${JSON.stringify({ state: leftStates[0] ?? 'OK' })} lists one state, `
        + 'health_monitor {"alarm":"<id>"} reads one whole.',
    } : { detail: 'health_monitor {"alarm":"<id>"} reads one alarm whole: its spark, series and history.' }),
  }
}

defineOp({
  name: 'health_monitor',
  title: 'Walnut\'s own health alarms',
  description:
    'Read-only. Walnut\'s health monitor, like CloudWatch alarms for Walnut itself: every built-in alarm (disk, host '
    + 'links, event-loop stalls, slow sends, hung sessions, open files, memory pressure, restarts, cut-off shutdowns, '
    + 'status drift, the SSH certificate) and every log alarm (a kind of warn/error line far above its normal, or high '
    + 'every day), each with its state (OK, ALARM, INSUFFICIENT_DATA), value, condition, a 24-hour spark and what '
    + 'Walnut did about it (an auto-fix, a fix task, a notification). `state` lists only the alarms in that state. Give '
    + '`alarm` for one alarm with its minute series and its history. Runs on the primary.',
  input: {
    alarm: z.string().max(200).optional().describe('One alarm id (as listed), for its series and history'),
    state: z.enum(['ALARM', 'INSUFFICIENT_DATA', 'OK']).optional().describe('Only the alarms in this state'),
  },
  bind: { method: 'GET', path: '/health-monitor', query: ['alarm'] },
  mapResult: ({ body, args }) => {
    const b = rec(body)
    if (args.alarm) return withOutcome({ ...b }, `Alarm ${String(args.alarm)} is ${String(b.state)}.`, 'Change it with health_alarm_set.')
    const c = rec(b.counts)
    const n = Number(c.ALARM ?? 0)
    // `state` narrows the list here, for every caller; the counts stay the whole monitor's.
    const view = typeof args.state === 'string' && Array.isArray(b.alarms)
      ? { ...b, alarms: b.alarms.filter((a) => rec(a).state === args.state) }
      : { ...b }
    return withOutcome(view, n ? `${n} alarm${n === 1 ? '' : 's'} in ALARM.` : 'No alarm is in ALARM.',
      n ? 'Each one names what Walnut did (actions) and its fix task, if any.' : 'Nothing else is required.')
  },
  answer: {
    kind: 'content',
    max: LIST_MAX,
    shape: ({ result, args, max }) => (args.alarm ? alarmDetailShort(result) : alarmList(result, max)),
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
})

defineOp({
  name: 'health_alarm_set',
  title: 'Change a health alarm',
  description:
    'Change one of Walnut\'s health alarms, as a person can on Settings > Health: a new `threshold` (null = back to '
    + 'the default; a built-in\'s id changes all its instances, a host\'s instance id only that host), `enabled:false` '
    + 'to stop its actions, or `muted_for` ("2h", "3d") / `muted_until` (ISO, null = unmute) to hold its actions for a '
    + 'while. It still evaluates and shows. `owner_task` names a task that owns the problem: the alarm is sent to '
    + 'that task instead of a new fix task being filed (null = file fix tasks again). The change records who made '
    + 'it. Use it when an alarm is expected and harmless, or another task already works on it, with the reason in '
    + 'your reply.',
  input: {
    id: z.string().min(1).max(200).describe('The alarm id (from health_monitor)'),
    threshold: z.number().nullable().optional().describe('New threshold, or null for the default'),
    enabled: z.boolean().optional().describe('false: no actions for this alarm'),
    muted_for: z.string().max(10).optional().describe('Hold actions for a while: "90m", "2h", "3d" (at most 30 days)'),
    muted_until: z.string().nullable().optional().describe('Hold actions until this ISO time; null unmutes'),
    owner_task: z.string().max(80).nullable().optional().describe('A task id that owns this problem: it hears the alarm instead of a new fix task; null clears'),
  },
  bind: { method: 'PATCH', path: '/health-monitor/alarms/:id' },
  mapResult: ({ body }) => withOutcome({ ...rec(body) }, 'The alarm was changed.', 'Read it back with health_monitor.'),
  // A receipt: the change and the alarm's state now, never the alarm's whole minute series (2026-11-21: up to 40,000 characters).
  answer: {
    kind: 'receipt',
    whole: 'health_monitor {"alarm":"<id>"}',
    shape: ({ result }) => {
      const r = rec(result)
      if (!('alarm' in r)) return result
      const a = r.alarm ? alarmLine(r.alarm) : null
      return { ...r, alarm: a && { state: a.state, value: a.value, ...(a.held ? { held: true } : {}), ...(a.condition ? { condition: a.condition } : {}), ...(a.fixTaskId ? { fixTaskId: a.fixTaskId } : {}) } }
    },
  },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})

defineOp({
  name: 'health_monitor_settings',
  title: 'Health monitor: what an alarm does',
  description:
    'Set what Walnut\'s health monitor does when an alarm needs a fix, as the switch on Settings > Walnut Health does: '
    + '`record` files a fix task in the Walnut project and starts nothing, `start` also starts a session on it (at most '
    + '5 new fix tasks a day; each session costs model usage), `off` files none. Stored as config health_monitor.fix_tasks.',
  input: {
    fix_tasks: z.enum(['record', 'start', 'off']).describe('record, start or off'),
  },
  bind: { method: 'PUT', path: '/health-monitor/settings' },
  mapResult: ({ body }) => withOutcome({ ...rec(body) }, `Fix tasks: ${String(rec(body).fixTasks)}.`, 'Nothing else is required.'),
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})
