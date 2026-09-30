/**
 * Apple Health ops: read what the iPhone uploaded (src/core/health/), plus
 * day_review, which joins health with the rest of a day.
 *
 * Every op here is read-only and primary-only, and runs only for a caller on
 * this Mac: `localHostGateway` lets a session running here (Ask Walnut, a morning
 * routine) read it, and the executor refuses every other origin, whatever the
 * path (the gateway from another host, an action card from a paired phone, the
 * cloud bridge, a nested op call). See src/lib/caller-origin.ts.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { runDayReview, DAY_REVIEW_SECTIONS } from './day-review.js'
import { HEALTH_METRICS } from '../core/health/catalog.js'
import { HEALTH_LOCAL_ONLY_MESSAGE } from '../lib/caller-origin.js'

const HEALTH_TAGS = { readonly: true, remote: 'deny', localHostGateway: true, primaryOnly: true } as const
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const SERIES_METRICS = Object.keys(HEALTH_METRICS).filter((m) => m !== 'sleep') as [string, ...string[]]

const PRIVACY =
  'Health data is personal. Walnut serves it only to sessions on this Mac and never syncs or relays the samples; '
  + 'if a read is refused, say so, and do not look for another way to it. What you write about the data (a reply, '
  + 'a letter) is ordinary Walnut content that syncs like any other, so summarize and never paste raw series, and '
  + 'never write health numbers into MEMORY.md, USER.md, notes or tasks unless the user asks.'

defineOp({
  name: 'health_status',
  title: 'Apple Health connection status',
  description:
    'Is Apple Health connected, when did the iPhone last upload, which types have data, and from which sources. '
    + 'A type in state `unknown_or_denied` has had no sample for 14 days: iOS never tells an app about a denied read, so '
    + 'this may mean permission is off OR the user simply has no such data; say so, do not guess which. '
    + `Call this first when a health read comes back empty. ${PRIVACY}`,
  input: {},
  bind: { method: 'GET', path: '/api/health/status' },
  localOnlyMessage: HEALTH_LOCAL_ONLY_MESSAGE,
  tags: HEALTH_TAGS,
})

defineOp({
  name: 'health_sleep',
  title: 'Sleep nights from Apple Health',
  description:
    'Nights by WAKE date: bedtime, wake, in-bed / asleep / awake minutes, stages (deep, core, REM) where a stage-capable '
    + 'source covered the night (stagesCoverage 0..1, stages null when none), efficiency, awakenings, sleeping heart rate, '
    + 'HRV (SDNN), respiratory rate, SpO2, wrist temperature, other sources and naps, plus averages, a 28-night baseline '
    + 'before the window, and caveats you MUST pass on (consumer stage accuracy, SDNN is not RMSSD, no medical claims). '
    + 'status `in_bed_only`: only time in bed was recorded (an iPhone without a Watch), so bedtime, wake and inBedMin are '
    + 'real and asleepMin is null: say "only time in bed was recorded", never invent sleep. status `no_main_night`: only '
    + 'naps. `unrecordedGaps` on a night: sleep was recorded close to it with nothing in between (listed under naps); Walnut '
    + 'cannot tell a real wake from a recording gap, so say the recording has a gap and never state that night\'s wake time, '
    + `bedtime or length as fact. Default: the last 7 nights. ${PRIVACY}`,
  input: {
    last_nights: z.number().int().min(1).max(90).optional().describe('How many nights ending today (default 7, max 90)'),
    from: DATE.optional().describe('First wake date YYYY-MM-DD (instead of last_nights)'),
    to: DATE.optional().describe('Last wake date YYYY-MM-DD'),
    detail: z.enum(['summary', 'stages']).optional().describe('`stages` adds each night\'s stage timeline (hypnogram)'),
  },
  bind: { method: 'GET', path: '/api/health/sleep' },
  localOnlyMessage: HEALTH_LOCAL_ONLY_MESSAGE,
  tags: HEALTH_TAGS,
})

defineOp({
  name: 'health_daily',
  title: 'Daily activity and vitals from Apple Health',
  description:
    'Per local day: activity (steps, distance, active/basal energy, exercise, stand, daylight minutes), vitals (resting, '
    + 'walking and average heart rate, HRV SDNN, respiratory rate, SpO2, VO2 max), workouts, State of Mind and mindful '
    + `minutes, and audio exposure, with a units block. A day with nothing uploaded reads status: missing. ${PRIVACY}`,
  input: {
    last_days: z.number().int().min(1).max(90).optional().describe('How many days ending today (default 7, max 90)'),
    from: DATE.optional().describe('First date YYYY-MM-DD'),
    to: DATE.optional().describe('Last date YYYY-MM-DD'),
    metrics: z.string().max(300).optional().describe('Comma list of sections (activity, vitals, workouts, mind, audio) or metric names; default all'),
  },
  bind: { method: 'GET', path: '/api/health/daily' },
  localOnlyMessage: HEALTH_LOCAL_ONLY_MESSAGE,
  tags: HEALTH_TAGS,
})

defineOp({
  name: 'health_series',
  title: 'One Apple Health metric over time',
  description:
    'Points for ONE metric (e.g. heart_rate, steps, hrv_sdnn) between two dates or instants, folded into 5m, 1h or 1d '
    + 'buckets (default picked from the range). Sums for additive metrics, avg/min/max otherwise. At most 2000 points: '
    + `a longer answer keeps the latest points and says truncated. ${PRIVACY}`,
  input: {
    metric: z.enum(SERIES_METRICS).describe('Catalog metric name'),
    from: z.string().max(40).optional().describe('YYYY-MM-DD or ISO-8601 instant (default today)'),
    to: z.string().max(40).optional().describe('YYYY-MM-DD (inclusive) or ISO-8601 instant (default today)'),
    bucket: z.enum(['5m', '1h', '1d']).optional().describe('Bucket width (default from the range)'),
  },
  bind: { method: 'GET', path: '/api/health/series' },
  localOnlyMessage: HEALTH_LOCAL_ONLY_MESSAGE,
  tags: HEALTH_TAGS,
})

defineOp({
  name: 'day_review',
  title: 'Review one day across Walnut',
  description:
    'One day in one call: tasks completed, time on tasks, Mac app time, Screen Time, calendar events, Rhythm focus, '
    + 'last night\'s sleep and the day\'s activity. Default date: today, or yesterday before noon, in the phone\'s time zone. '
    + '`sleep` is the most recent COMPLETED night: the one ending the morning after the date once it has settled, else '
    + 'the one ending on the date (`wakeDate` says which; `note` says when only time in bed was recorded or the recording has a gap). Every source that is '
    + 'off, not installed, has no data, or has not answered when the review\'s 10s budget ends is listed in `unavailable` with the '
    + 'reason (`timezone` there means the phone\'s zone could not be read and this Mac\'s was used): report it as missing and '
    + `NEVER invent that section. ${PRIVACY}`,
  input: {
    date: DATE.optional().describe('YYYY-MM-DD (default today; yesterday before noon)'),
    sections: z.string().max(200).optional().describe(`Comma list, any of: ${DAY_REVIEW_SECTIONS.join(', ')} (default all)`),
  },
  // Local-only for its health sections alone: the other sections read public routes.
  routes: [
    { method: 'GET', path: '/api/health/status' },
    { method: 'GET', path: '/api/health/sleep' },
    { method: 'GET', path: '/api/health/daily' },
  ],
  handler: (args, call) => runDayReview(args, call),
  timeoutMs: 30_000,
  localOnlyMessage: HEALTH_LOCAL_ONLY_MESSAGE,
  tags: HEALTH_TAGS,
})
