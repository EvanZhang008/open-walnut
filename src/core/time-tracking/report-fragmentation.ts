/**
 * Fragmentation, PURE: how scattered the user's Walnut time was. Per day and for
 * the window: tasks touched, switches (glances under glanceMs ignored), the longest
 * same-task stretch (gaps under mergeGapMs joined) and the share in deep stretches.
 */

const MIN = 60_000
const minutes = (ms: number): number => Math.round(ms / MIN)
const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0)

export interface SerialRec { taskId: string; startMs: number; endMs: number; ms: number }

export interface FragmentationRules { mergeGapMs: number; longStretchMs: number; glanceMs: number }

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

export function dayFragmentation(serial: SerialRec[], opts: FragmentationRules, taskCount: number): FragmentationDay {
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

/** The window's fragmentation from its day rows. */
export function windowFragmentation(
  dayRows: ReadonlyArray<{ walnutMin: number; fragmentation: FragmentationDay }>,
  opts: FragmentationRules,
  meta: (taskId: string) => Record<string, unknown>,
): Record<string, unknown> {
  const active = dayRows.filter((d) => d.walnutMin > 0)
  const frag = active.map((d) => d.fragmentation)
  const sumMin = active.reduce((s, d) => s + d.walnutMin, 0)
  const longest = frag.reduce<FragmentationDay['longest']>((best, f) => (f.longest && (!best || f.longest.min > best.min) ? f.longest : best), null)
  return {
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
}
