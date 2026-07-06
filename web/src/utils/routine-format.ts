/**
 * Human-readable schedule formatting for routine cards, in the style of the
 * Claude cloud app: "Weekdays at 5:30 AM · Next run tomorrow at 5:30 AM".
 * Lives in the frontend so phrasing uses the viewer's locale/clock.
 */

import type { RoutineSchedule, RoutineState } from '@/api/routines';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Describe a 5-field cron expr in plain English; null if it's not a simple daily/weekly pattern. */
function describeCronExpr(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(min)) return null;
  if (dom !== '*' || mon !== '*') return null;
  // Hourly pattern: fixed minute, any hour
  if (hour === '*') {
    return dow === '*' ? `Hourly at :${min.padStart(2, '0')}` : null;
  }
  if (!/^\d{1,2}$/.test(hour)) return null;
  const time = formatTime(Number(hour), Number(min));

  if (dow === '*') return `Every day at ${time}`;
  if (dow === '1-5') return `Weekdays at ${time}`;
  if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
  if (/^\d$/.test(dow)) return `${DAY_NAMES[Number(dow)]}s at ${time}`;
  if (/^\d(,\d)+$/.test(dow)) {
    const days = dow.split(',').map((d) => DAY_NAMES[Number(d)]?.slice(0, 3)).filter(Boolean);
    return `${days.join('/')} at ${time}`;
  }
  return null;
}

export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === 'at') {
    const d = new Date(schedule.at);
    return `Once at ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }
  if (schedule.kind === 'every') {
    const mins = Math.round(schedule.everyMs / 60_000);
    if (mins < 60) return `Every ${mins} min`;
    const hours = mins / 60;
    return Number.isInteger(hours) ? `Every ${hours} hour${hours > 1 ? 's' : ''}` : `Every ${mins} min`;
  }
  return describeCronExpr(schedule.expr) ?? `Cron: ${schedule.expr}`;
}

export function describeNextRun(state: RoutineState | undefined): string | null {
  const next = state?.nextRunAtMs;
  if (!next) return null;
  const d = new Date(next);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  if (dayDiff === 0) {
    const inMs = next - now.getTime();
    if (inMs < 60_000) return 'Next run in <1 min';
    if (inMs < 3_600_000) return `Next run in ${Math.round(inMs / 60_000)} min`;
    return `Next run today at ${time}`;
  }
  if (dayDiff === 1) return `Next run tomorrow at ${time}`;
  if (dayDiff < 7) return `Next run ${DAY_NAMES[d.getDay()]} at ${time}`;
  return `Next run ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/** "Weekdays at 5:30 AM · Next run tomorrow at 5:30 AM" */
export function describeRoutineTiming(schedule: RoutineSchedule, state?: RoutineState): string {
  const parts = [describeSchedule(schedule)];
  const next = describeNextRun(state);
  if (next) parts.push(next);
  return parts.join(' · ');
}

/** Badge text: "Claude Code @ clouddev" / "Main Agent" / "Walnut Agent". */
export function describeExecutorBadge(
  executor: { type: string; config: Record<string, unknown> } | undefined,
  executorLabels: Record<string, string>,
): string {
  if (!executor) return 'Walnut Agent';
  const label = executorLabels[executor.type] ?? executor.type;
  const host = executor.config?.host;
  if (executor.type === 'claude-code') {
    return typeof host === 'string' && host ? `${label} @ ${host}` : `${label} @ local`;
  }
  return label;
}
