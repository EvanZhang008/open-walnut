/**
 * Time report: a PURE fold from a range of day records to the answer an agent
 * needs for "where did my time go": per-day totals, groups (task, project, hour,
 * kind, Mac app, site), fragmentation, and every number in two views, the whole
 * day and work hours. No fs, no config, no clock: the route reads the days and
 * passes them in (src/web/routes/time-report.ts).
 *
 * What the numbers mean (the skill repeats this to the user):
 *   - Walnut minutes are LEASE minutes: real interaction with a session, triage
 *     row or chat gives that context the next 60 s; passive reading earns 60 s.
 *     `agent` minutes are an agent running on its own and cost no attention, so
 *     they are always reported apart and never summed into attention.
 *   - Outside minutes come from the foreground sampler (Mac only): the frontmost
 *     app every ~5 s, idle over 120 s and the lock screen excluded. Walnut's own
 *     foreground is reported as `walnutForegroundMin`, a cross-check, never added:
 *     the lease clock already counts that time.
 *   - attention = Walnut minutes + outside minutes (the phone's Walnut minutes
 *     included; the phone's other apps are not seen here).
 *
 * Shares divide by the matching total of the same view: a task's `workShare` is
 * its work-hours minutes over all work-hours attention (or Walnut minutes when the
 * outside sampler is not included), so the two views can be read side by side.
 */

import { BROWSER_BUNDLE_IDS, WALNUT_DESKTOP_BUNDLE_ID } from './outside-view.js'
import type { OutsideRecord } from './outside-store.js'
import { localDateKey } from './rollup.js'
import { TIME_KINDS, type TimeKind, type TimeRecord } from './types.js'
import { isWorkday, workHoursLabel, workHoursToConfig, workMsOf, WEEKDAY_NAMES, type WorkHours } from './work-hours.js'

export const REPORT_GROUPS = ['task', 'project', 'hour', 'kind', 'app', 'host'] as const
export type ReportGroup = (typeof REPORT_GROUPS)[number]

/** What the task join supplies for a task id; absent = deleted or never a task. */
export interface ReportTaskMeta {
  title: string
  project: string
  phase?: string
  createdAt?: string
  completedAt?: string
  parentTaskId?: string
  /** Where the task came from when not made in Walnut (a sync plugin's id): inbound work. */
  source?: string
}

export interface ReportOptions {
  /** Ascending local date keys, every day of the range. */
  dates: readonly string[]
  /** Kinds counted as the user's time. Default: the three human kinds. */
  kinds: readonly TimeKind[]
  workHours: WorkHours
  workHoursSource: 'config' | 'default' | 'args'
  groupBy: readonly ReportGroup[]
  /** Rows kept per group (the rest are summed into `otherMin`). */
  top: number
  /** Same-task records closer than this join one stretch (fragmentation). */
  mergeGapMs: number
  /** A stretch at least this long counts as deep work. */
  longStretchMs: number
  /** A visit shorter than this is a glance: it does not count as a switch. */
  glanceMs: number
  includeOutside: boolean
  walnutHosts: readonly string[]
}

export const REPORT_DEFAULTS = {
  kinds: ['session', 'triage', 'chat'] as TimeKind[],
  groupBy: ['task', 'project'] as ReportGroup[],
  top: 15,
  mergeGapMs: 5 * 60_000,
  longStretchMs: 45 * 60_000,
  glanceMs: 10_000,
}

const MIN = 60_000
const minutes = (ms: number): number => Math.round(ms / MIN)
const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0)

interface Split { ms: number; workMs: number }
const zero = (): Split => ({ ms: 0, workMs: 0 })

interface TaskAcc extends Split { agentMs: number; days: Set<string> }
interface AppAcc extends Split { app: string; labelMs: number; bundleId: string; days: Set<string>; hosts: Map<string, Split> }

interface SerialRec { taskId: string; startMs: number; endMs: number; ms: number }

interface DayAcc {
  date: string
  workday: boolean
  counted: Split
  unplacedMs: number
  agentMs: number
  phoneMs: number
  byKind: Record<TimeKind, number>
  tasks: Map<string, TaskAcc>
  serial: SerialRec[]
  outside: { total: Split; walnutMs: number; unplacedMs: number; apps: Map<string, AppAcc> } | null
}

export interface FragmentationDay {
  /** Distinct tasks with counted time ('' = time with no task counts as one). */
  tasks: number
  /** Task changes, glances (< glanceMs) ignored. */
  switches: number
  switchesPerHour: number
  longest: { min: number; taskId: string; start: string; end: string } | null
  /** Minutes in stretches of at least longMin. */
  deepMin: number
  deepShare: number
}

/** Hour-of-day buckets (local) of [startMs, endMs). */
function addHours(into: number[], startMs: number, endMs: number): void {
  let t = startMs
  for (let guard = 0; t < endMs && guard < 200; guard++) {
    const d = new Date(t)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()
    const stop = Math.min(next, endMs)
    into[d.getHours()] = (into[d.getHours()] ?? 0) + (stop - t)
    t = stop
  }
}

/** Placeable interval of a record inside its own local day, or null (compacted / junk). */
function interval(ts: string, durationMs: number, date: string): { startMs: number; endMs: number } | null {
  // A compacted day keeps only bucket totals stamped at UTC midnight (store.ts).
  if (!ts || ts === `${date}T00:00:00.000Z`) return null
  const startMs = Date.parse(ts)
  if (!Number.isFinite(startMs)) return null
  return { startMs, endMs: startMs + durationMs }
}

function dayFragmentation(serial: SerialRec[], opts: ReportOptions, taskCount: number): FragmentationDay {
  const recs = [...serial].sort((a, b) => a.startMs - b.startMs)
  const total = recs.reduce((s, r) => s + r.ms, 0)
  // Visits: runs of the same task with nothing else in between.
  const visits: SerialRec[] = []
  for (const r of recs) {
    const last = visits[visits.length - 1]
    if (last && last.taskId === r.taskId) { last.endMs = Math.max(last.endMs, r.endMs); last.ms += r.ms } else visits.push({ ...r })
  }
  // Switches: drop glances, then join neighbours that became the same task.
  const kept: string[] = []
  for (const v of visits) {
    if (v.ms < opts.glanceMs) continue
    if (kept[kept.length - 1] !== v.taskId) kept.push(v.taskId)
  }
  const switches = Math.max(0, kept.length - 1)
  // Stretches: same task, each gap under mergeGap, another task in between breaks it.
  const stretches: SerialRec[] = []
  for (const r of recs) {
    const last = stretches[stretches.length - 1]
    if (last && last.taskId === r.taskId && r.startMs - last.endMs < opts.mergeGapMs) {
      last.endMs = Math.max(last.endMs, r.endMs)
      last.ms += r.ms
    } else stretches.push({ ...r })
  }
  let longest: SerialRec | null = null
  let deepMs = 0
  for (const s of stretches) {
    if (!longest || s.ms > longest.ms) longest = s
    if (s.ms >= opts.longStretchMs) deepMs += s.ms
  }
  return {
    tasks: taskCount,
    switches,
    switchesPerHour: total > 0 ? Math.round((switches / (total / 3_600_000)) * 10) / 10 : 0,
    longest: longest
      ? { min: minutes(longest.ms), taskId: longest.taskId, start: new Date(longest.startMs).toISOString(), end: new Date(longest.endMs).toISOString() }
      : null,
    deepMin: minutes(deepMs),
    deepShare: share(deepMs, total),
  }
}

function isWalnutOutside(rec: OutsideRecord, walnutHosts: ReadonlySet<string>): boolean {
  return rec.bundleId === WALNUT_DESKTOP_BUNDLE_ID || (!!rec.host && walnutHosts.has(rec.host.toLowerCase()))
}

const BROWSERS = new Set(BROWSER_BUNDLE_IDS)

/** The local day a task was created ('' when the stamp is junk). */
function createdLocalDate(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? localDateKey(new Date(ms)) : ''
}

export interface ReportInput {
  records: ReadonlyMap<string, readonly TimeRecord[]>
  outside?: ReadonlyMap<string, readonly OutsideRecord[]>
  tasks: ReadonlyMap<string, ReportTaskMeta>
}

/** Fold the range. Returns the JSON body the route serves (minus route-level flags). */
export function buildTimeReport(input: ReportInput, opts: ReportOptions): Record<string, unknown> {
  const counted = new Set<string>(opts.kinds)
  const walnutHosts = new Set(opts.walnutHosts.map((h) => h.toLowerCase()))
  const days = new Map<string, DayAcc>()
  for (const date of opts.dates) {
    days.set(date, {
      date, workday: isWorkday(date, opts.workHours), counted: zero(), unplacedMs: 0, agentMs: 0, phoneMs: 0,
      byKind: { session: 0, triage: 0, chat: 0, agent: 0 }, tasks: new Map(), serial: [],
      outside: opts.includeOutside ? { total: zero(), walnutMs: 0, unplacedMs: 0, apps: new Map() } : null,
    })
  }
  const taskAcc = new Map<string, TaskAcc>()
  const hours = new Array<number>(24).fill(0)
  const hoursOutside = new Array<number>(24).fill(0)
  const kindAcc = new Map<TimeKind, Split>()
  const appAcc = new Map<string, AppAcc>()
  const hostAcc = new Map<string, Split & { days: Set<string> }>()

  for (const [date, recs] of input.records) {
    const day = days.get(date)
    if (!day) continue
    for (const rec of recs) {
      if (!(rec.durationMs > 0) || !(TIME_KINDS as readonly string[]).includes(rec.kind)) continue
      const kind = rec.kind
      const taskId = rec.taskId ?? ''
      const span = interval(rec.ts, rec.durationMs, date)
      const workMs = span ? workMsOf(span.startMs, span.endMs, opts.workHours) : 0
      day.byKind[kind] += rec.durationMs
      const k = kindAcc.get(kind) ?? zero()
      k.ms += rec.durationMs
      k.workMs += workMs
      kindAcc.set(kind, k)
      const dayTask = day.tasks.get(taskId) ?? { ...zero(), agentMs: 0, days: new Set<string>() }
      const rangeTask = taskAcc.get(taskId) ?? { ...zero(), agentMs: 0, days: new Set<string>() }
      day.tasks.set(taskId, dayTask)
      taskAcc.set(taskId, rangeTask)
      if (kind === 'agent') {
        day.agentMs += rec.durationMs
        dayTask.agentMs += rec.durationMs
        rangeTask.agentMs += rec.durationMs
      }
      if (!counted.has(kind)) continue
      day.counted.ms += rec.durationMs
      day.counted.workMs += workMs
      if (rec.source === 'ios') day.phoneMs += rec.durationMs
      dayTask.ms += rec.durationMs
      dayTask.workMs += workMs
      rangeTask.ms += rec.durationMs
      rangeTask.workMs += workMs
      rangeTask.days.add(date)
      if (span) {
        addHours(hours, span.startMs, span.endMs)
        if (kind !== 'agent') day.serial.push({ taskId, startMs: span.startMs, endMs: span.endMs, ms: rec.durationMs })
      } else day.unplacedMs += rec.durationMs
    }
  }

  if (opts.includeOutside && input.outside) {
    for (const [date, recs] of input.outside) {
      const day = days.get(date)
      if (!day?.outside) continue
      for (const rec of recs) {
        if (!(rec.durationMs > 0)) continue
        if (isWalnutOutside(rec, walnutHosts)) { day.outside.walnutMs += rec.durationMs; continue }
        const span = interval(rec.ts, rec.durationMs, date)
        const workMs = span ? workMsOf(span.startMs, span.endMs, opts.workHours) : 0
        day.outside.total.ms += rec.durationMs
        day.outside.total.workMs += workMs
        if (span) addHours(hoursOutside, span.startMs, span.endMs)
        else day.outside.unplacedMs += rec.durationMs
        const key = rec.bundleId ? `b:${rec.bundleId}` : `n:${rec.app}`
        for (const map of [day.outside.apps, appAcc]) {
          const a = map.get(key) ?? { ...zero(), app: rec.app, labelMs: 0, bundleId: rec.bundleId ?? '', days: new Set<string>(), hosts: new Map() }
          if (rec.app && rec.durationMs > a.labelMs) { a.app = rec.app; a.labelMs = rec.durationMs }
          a.ms += rec.durationMs
          a.workMs += workMs
          a.days.add(date)
          if (rec.host) {
            const h = a.hosts.get(rec.host) ?? zero()
            h.ms += rec.durationMs
            h.workMs += workMs
            a.hosts.set(rec.host, h)
          }
          map.set(key, a)
        }
        if (rec.host && BROWSERS.has(rec.bundleId ?? '')) {
          const h = hostAcc.get(rec.host) ?? { ...zero(), days: new Set<string>() }
          h.ms += rec.durationMs
          h.workMs += workMs
          h.days.add(date)
          hostAcc.set(rec.host, h)
        }
      }
    }
  }

  // ── totals ──
  let walnut = zero()
  let outside = zero()
  let agentMs = 0
  let phoneMs = 0
  let unplacedMs = 0
  let walnutForegroundMs = 0
  for (const day of days.values()) {
    walnut = { ms: walnut.ms + day.counted.ms, workMs: walnut.workMs + day.counted.workMs }
    agentMs += day.agentMs
    phoneMs += day.phoneMs
    unplacedMs += day.unplacedMs
    if (day.outside) {
      outside = { ms: outside.ms + day.outside.total.ms, workMs: outside.workMs + day.outside.total.workMs }
      walnutForegroundMs += day.outside.walnutMs
    }
  }
  const attention: Split = opts.includeOutside
    ? { ms: walnut.ms + outside.ms, workMs: walnut.workMs + outside.workMs }
    : walnut
  const denominator = opts.includeOutside ? 'attention' : 'walnut'

  const meta = (taskId: string): Record<string, unknown> => {
    if (!taskId) return { taskId: '', title: '(no task: home chat, Inbox triage)', project: '' }
    const m = input.tasks.get(taskId)
    if (!m) return { taskId, title: null, project: null, missing: true }
    const first = opts.dates[0]
    return {
      taskId, title: m.title, project: m.project,
      ...(m.phase ? { phase: m.phase } : {}),
      ...(m.createdAt ? { createdAt: m.createdAt, createdBeforeRange: !!first && createdLocalDate(m.createdAt) < first } : {}),
      ...(m.completedAt ? { completedAt: m.completedAt } : {}),
      ...(m.parentTaskId ? { parentTaskId: m.parentTaskId } : {}),
      ...(m.source ? { source: m.source } : {}),
    }
  }
  const splitRow = (s: Split): Record<string, number> => ({
    min: minutes(s.ms), workMin: minutes(s.workMs), offMin: minutes(s.ms - s.workMs),
    shareOfDay: share(s.ms, attention.ms), workShare: share(s.workMs, attention.workMs),
  })
  const topRows = <T>(rows: Array<[T, number]>, n: number): { kept: T[]; otherMin: number; more: number } => {
    const sorted = rows.sort((a, b) => b[1] - a[1])
    const kept = sorted.slice(0, n).map(([row]) => row)
    const rest = sorted.slice(n)
    return { kept, otherMin: minutes(rest.reduce((s, [, ms]) => s + ms, 0)), more: rest.length }
  }

  // ── days ──
  const dayRows = [...days.values()].map((day) => {
    const fragmentation = dayFragmentation(day.serial, opts, [...day.tasks.values()].filter((t) => t.ms > 0).length)
    const top = [...day.tasks.entries()].filter(([, t]) => t.ms > 0).sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
    const weekday = WEEKDAY_NAMES[new Date(`${day.date}T12:00:00`).getDay()]
    const out = day.outside
    return {
      date: day.date,
      weekday,
      workday: day.workday,
      walnutMin: minutes(day.counted.ms),
      workMin: minutes(day.counted.workMs),
      offMin: minutes(day.counted.ms - day.counted.workMs - day.unplacedMs),
      ...(day.unplacedMs > 0 ? { unplacedMin: minutes(day.unplacedMs) } : {}),
      agentMin: minutes(day.agentMs),
      ...(day.phoneMs > 0 ? { phoneMin: minutes(day.phoneMs) } : {}),
      byKind: Object.fromEntries(TIME_KINDS.map((k) => [k, minutes(day.byKind[k])])),
      ...(out ? {
        outside: {
          min: minutes(out.total.ms), workMin: minutes(out.total.workMs), walnutForegroundMin: minutes(out.walnutMs),
          topApps: [...out.apps.values()].sort((a, b) => b.ms - a.ms).slice(0, 5).map((a) => ({ app: a.app, min: minutes(a.ms), workMin: minutes(a.workMs) })),
        },
        attentionMin: minutes(day.counted.ms + out.total.ms),
        attentionWorkMin: minutes(day.counted.workMs + out.total.workMs),
      } : {}),
      topTasks: top.map(([taskId, t]) => ({ ...meta(taskId), min: minutes(t.ms), workMin: minutes(t.workMs) })),
      fragmentation,
    }
  })

  // ── groups ──
  const groups: Record<string, unknown> = {}
  const want = new Set(opts.groupBy)
  if (want.has('task')) {
    const t = topRows([...taskAcc.entries()].filter(([, a]) => a.ms > 0 || a.agentMs > 0).map(([id, a]) => [{ id, a }, a.ms] as [{ id: string; a: TaskAcc }, number]), opts.top)
    groups.task = {
      rows: t.kept.map(({ id, a }) => ({ ...meta(id), ...splitRow(a), agentMin: minutes(a.agentMs), days: a.days.size })),
      otherMin: t.otherMin, more: t.more,
    }
  }
  if (want.has('project')) {
    const proj = new Map<string, TaskAcc & { tasks: Set<string> }>()
    for (const [id, a] of taskAcc) {
      const m = id ? input.tasks.get(id) : undefined
      const name = !id ? '(no task)' : m ? (m.project || 'Inbox') : '(deleted or unknown task)'
      const p = proj.get(name) ?? { ...zero(), agentMs: 0, days: new Set<string>(), tasks: new Set<string>() }
      p.ms += a.ms
      p.workMs += a.workMs
      p.agentMs += a.agentMs
      if (a.ms > 0) p.tasks.add(id)
      for (const d of a.days) p.days.add(d)
      proj.set(name, p)
    }
    const t = topRows([...proj.entries()].filter(([, p]) => p.ms > 0 || p.agentMs > 0).map(([name, p]) => [{ name, p }, p.ms] as [{ name: string; p: TaskAcc & { tasks: Set<string> } }, number]), opts.top)
    groups.project = {
      rows: t.kept.map(({ name, p }) => ({ project: name, ...splitRow(p), agentMin: minutes(p.agentMs), tasks: p.tasks.size, days: p.days.size })),
      otherMin: t.otherMin, more: t.more,
    }
  }
  if (want.has('hour')) {
    groups.hour = hours.map((ms, hour) => ({
      hour, walnutMin: minutes(ms), ...(opts.includeOutside ? { outsideMin: minutes(hoursOutside[hour] ?? 0) } : {}),
    })).filter((h) => h.walnutMin > 0 || ('outsideMin' in h && (h.outsideMin as number) > 0))
  }
  if (want.has('kind')) {
    groups.kind = TIME_KINDS.map((kind) => {
      const s = kindAcc.get(kind) ?? zero()
      return { kind, min: minutes(s.ms), workMin: minutes(s.workMs), counted: counted.has(kind) }
    })
  }
  if (want.has('app') && opts.includeOutside) {
    const t = topRows([...appAcc.values()].map((a) => [a, a.ms] as [AppAcc, number]), opts.top)
    groups.app = {
      rows: t.kept.map((a) => ({
        app: a.app, ...(a.bundleId ? { bundleId: a.bundleId } : {}), ...splitRow(a), days: a.days.size,
        ...(a.hosts.size ? { topHosts: [...a.hosts.entries()].sort((x, y) => y[1].ms - x[1].ms).slice(0, 5).map(([host, h]) => ({ host, min: minutes(h.ms), workMin: minutes(h.workMs) })) } : {}),
      })),
      otherMin: t.otherMin, more: t.more,
    }
  }
  if (want.has('host') && opts.includeOutside) {
    const t = topRows([...hostAcc.entries()].map(([host, h]) => [{ host, h }, h.ms] as [{ host: string; h: Split & { days: Set<string> } }, number]), opts.top)
    groups.host = {
      rows: t.kept.map(({ host, h }) => ({ host, ...splitRow(h), days: h.days.size })),
      otherMin: t.otherMin, more: t.more,
    }
  }

  // ── window fragmentation ──
  const active = dayRows.filter((d) => d.walnutMin > 0)
  const frag = active.map((d) => d.fragmentation)
  const sumMin = active.reduce((s, d) => s + d.walnutMin, 0)
  const longest = frag.reduce<FragmentationDay['longest']>((best, f) => (f.longest && (!best || f.longest.min > best.min) ? f.longest : best), null)
  const fragmentation = {
    activeDays: active.length,
    avgTasksPerDay: active.length ? Math.round((frag.reduce((s, f) => s + f.tasks, 0) / active.length) * 10) / 10 : 0,
    avgSwitchesPerDay: active.length ? Math.round(frag.reduce((s, f) => s + f.switches, 0) / active.length) : 0,
    switchesPerHour: sumMin > 0 ? Math.round((frag.reduce((s, f) => s + f.switches, 0) / (sumMin / 60)) * 10) / 10 : 0,
    deepShare: share(frag.reduce((s, f) => s + f.deepMin, 0), sumMin),
    longest: longest ? { ...longest, ...meta(longest.taskId) } : null,
    rules: {
      mergeGapMin: Math.round(opts.mergeGapMs / MIN),
      longMin: Math.round(opts.longStretchMs / MIN),
      glanceSec: Math.round(opts.glanceMs / 1000),
    },
  }

  return {
    from: opts.dates[0],
    to: opts.dates[opts.dates.length - 1],
    dayCount: dayRows.length,
    workHours: { ...workHoursToConfig(opts.workHours), label: workHoursLabel(opts.workHours), source: opts.workHoursSource },
    kinds: [...opts.kinds],
    totals: {
      denominator,
      wholeDay: {
        walnutMin: minutes(walnut.ms),
        ...(opts.includeOutside ? { outsideMin: minutes(outside.ms), attentionMin: minutes(attention.ms), walnutForegroundMin: minutes(walnutForegroundMs) } : {}),
        agentMin: minutes(agentMs),
        ...(phoneMs > 0 ? { phoneMin: minutes(phoneMs) } : {}),
        ...(unplacedMs > 0 ? { unplacedMin: minutes(unplacedMs) } : {}),
      },
      workHours: {
        walnutMin: minutes(walnut.workMs),
        ...(opts.includeOutside ? { outsideMin: minutes(outside.workMs), attentionMin: minutes(attention.workMs) } : {}),
        shareOfDay: share(attention.workMs, attention.ms),
      },
      offHours: {
        walnutMin: minutes(walnut.ms - walnut.workMs - unplacedMs),
        ...(opts.includeOutside ? { outsideMin: minutes(outside.ms - outside.workMs) } : {}),
      },
      byKind: Object.fromEntries(TIME_KINDS.map((k) => [k, minutes((kindAcc.get(k) ?? zero()).ms)])),
    },
    days: dayRows,
    groups,
    fragmentation,
  }
}
