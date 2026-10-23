/**
 * Schedule computation — adapted from moltbot/src/cron/schedule.ts
 *
 * The math lives in src/providers/clock-schedule-core.ts, the one copy the
 * server and the daemon twins share (a routine whose work runs on a host keeps
 * its clock in that host's daemon). croner answers only for the cron syntax that
 * core does not take (a year field, W, #, L in the day of week), and such a
 * routine never leaves the server.
 */

import { Cron } from 'croner';
import { createClockSchedule } from '../../providers/clock-schedule-core.js';
import type { CronSchedule } from './types.js';

export const clockSchedule = createClockSchedule();

function resolveCronTimezone(tz?: string): string {
  const trimmed = typeof tz === 'string' ? tz.trim() : '';
  return trimmed || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The zone a cron schedule runs in when it names none: this server's. */
export function serverTimeZone(): string {
  return resolveCronTimezone(undefined);
}

/**
 * Compute the next run time in milliseconds for a given schedule.
 * Returns undefined if the schedule has no future runs.
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  const shared = clockSchedule.nextRunAtMs(schedule, nowMs);
  if (shared !== null) return shared;
  if (schedule.kind !== 'cron') return undefined;

  const expr = schedule.expr.trim();
  if (!expr) return undefined;

  const cron = new Cron(expr, {
    timezone: resolveCronTimezone(schedule.tz),
  });
  const next = cron.nextRun(new Date(nowMs - 1));
  if (!next) return undefined;
  const nextMs = next.getTime();
  return Number.isFinite(nextMs) && nextMs >= nowMs ? nextMs : undefined;
}
