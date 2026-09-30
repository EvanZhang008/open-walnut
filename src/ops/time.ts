/**
 * Time tracking ops: the Time panel's per-day numbers as one named read, so an
 * agent (the weekly health trend, a work review) never needs the `api`
 * passthrough for them.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'

const MIN = 60_000
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})
const minutes = (ms: unknown): number => Math.round((typeof ms === 'number' ? ms : 0) / MIN)

defineOp({
  name: 'time_summary',
  title: 'Time on tasks per day',
  description:
    'Human and agent time on tasks for each of the last N local days (the Time panel\'s numbers), in minutes, plus '
    + 'totals and the share of human time spent on Focus tasks. A day with nothing tracked reads 0. The Mac keeps a '
    + '90-day window. `degraded: true` means part of the answer was not ready in time: say the numbers may be low. '
    + 'For one day in detail (top tasks, Mac apps, Screen Time) use day_review.',
  input: {
    days: z.number().int().min(1).max(90).optional().describe('How many days ending today (default 7, max 90)'),
  },
  bind: { method: 'GET', path: '/api/time/summary' },
  mapResult: ({ body }) => {
    const b = rec(body)
    const days = Array.isArray(b.days) ? b.days.map(rec) : []
    return {
      today: b.today ?? null,
      days: days.map((d) => ({
        date: d.date,
        humanMin: minutes(d.humanMs),
        agentMin: minutes(d.agentMs),
        ...(typeof d.iosMs === 'number' && d.iosMs > 0 ? { phoneMin: minutes(d.iosMs) } : {}),
      })),
      totalHumanMin: minutes(b.totalHumanMs),
      totalAgentMin: minutes(b.totalAgentMs),
      focusShare: typeof b.focusShare === 'number' ? Math.round(b.focusShare * 100) / 100 : 0,
      ...(b.degraded === true ? { degraded: true } : {}),
    }
  },
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
})
