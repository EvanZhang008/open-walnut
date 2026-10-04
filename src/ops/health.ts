/**
 * Apple Health ops: read what the iPhone has synced to this Mac (src/core/health/),
 * plus day_review, which joins health with the rest of a day.
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
import { HEALTH_MAX_SAMPLE_ROWS as MAX_SAMPLE_ROWS, HEALTH_MAX_TYPE_LENGTH, HEALTH_METRICS } from '../core/health/catalog.js'
import { HEALTH_LOCAL_ONLY_MESSAGE } from '../lib/caller-origin.js'

const HEALTH_TAGS = { readonly: true, remote: 'deny', localHostGateway: true, primaryOnly: true } as const
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
// A string, not an enum: a generic q. type is a metric too. The route validates it.
const SERIES_METRICS = Object.keys(HEALTH_METRICS).filter((m) => m !== 'sleep').join(', ')
const RAW_TYPES = Object.entries(HEALTH_METRICS).filter(([, s]) => s.raw).map(([n]) => n).join(', ')

const PRIVACY =
  'Health data is personal. Walnut serves it only to sessions on this Mac and never syncs or relays the samples; '
  + 'if a read is refused, say so, and do not look for another way to it. What you write about the data (a reply, '
  + 'a letter) is ordinary Walnut content that syncs like any other, so summarize and never paste raw series, and '
  + 'never write health numbers into MEMORY.md, USER.md, notes or tasks unless the user asks.'

defineOp({
  name: 'health_status',
  title: 'Apple Health connection status',
  description:
    'Is Apple Health connected (`connected` false: nothing has synced for 3 days, or never), when the phone last synced '
    + '(`lastUploadAt` is the last sync), and every type Walnut has: the catalog types (sleep, heart_rate, steps, …) and '
    + 'every other HealthKit type the phone syncs under a generic name (`q.<Suffix>` quantity, e.g. q.BodyMass, '
    + 'q.BloodPressureSystolic, q.DietaryProtein; `c.<Suffix>` category, e.g. c.MenstrualFlow, c.Headache; `x.<Name>` other '
    + 'kinds: x.Electrocardiogram, x.GAD7, x.PHQ9, x.BloodType, x.DateOfBirth …), each with lastSampleAt and, for generic '
    + 'types, its unit. Call this to discover what exists, then read rows with health_samples or a quantity over time with '
    + 'health_series. A catalog type in state `unknown_or_denied` has had no sample for 14 days: iOS never tells an app '
    + 'about a denied read, so this may mean permission is off OR the user simply has no such data; say so, do not guess '
    + `which. A generic type is listed only when it has data. Call this first when a health read comes back empty. ${PRIVACY}`,
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
    + `minutes, and audio exposure, with a units block. A day with nothing synced reads status: missing. ${PRIVACY}`,
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
    'Points for ONE metric between two dates or instants, folded into 5m, 1h or 1d buckets (default picked from the '
    + 'range). The metric is a catalog name (e.g. heart_rate, steps, hrv_sdnn) or any generic quantity type health_status '
    + 'lists (`q.<Suffix>`, e.g. q.BodyMass, q.BloodGlucose, q.FlightsClimbed), in the `unit` the answer names. Catalog '
    + 'metrics: sums for additive ones, avg/min/max otherwise. Generic types: buckets fold the way the phone set (`agg`: '
    + 'sum or avg); raw samples give avg/min/max and a sum (the sum means something only for cumulative types such as '
    + 'dietary intake). Category and other kinds (c., x.) have no series: use health_samples. At most 2000 points: '
    + `a longer answer keeps the latest points and says truncated. ${PRIVACY}`,
  input: {
    metric: z.string().min(1).max(HEALTH_MAX_TYPE_LENGTH).describe(`Catalog metric (${SERIES_METRICS}) or a q.<Suffix> type from health_status`),
    from: z.string().max(40).optional().describe('YYYY-MM-DD or ISO-8601 instant (default today)'),
    to: z.string().max(40).optional().describe('YYYY-MM-DD (inclusive) or ISO-8601 instant (default today)'),
    bucket: z.enum(['5m', '1h', '1d']).optional().describe('Bucket width (default from the range)'),
  },
  bind: { method: 'GET', path: '/api/health/series' },
  localOnlyMessage: HEALTH_LOCAL_ONLY_MESSAGE,
  tags: HEALTH_TAGS,
})

defineOp({
  name: 'health_samples',
  title: 'Stored Apple Health samples of one type',
  description:
    'The rows of ONE raw type, newest first: any catalog raw type or any generic type health_status lists. Each row has '
    + 'start, end, value, code, unit, source (app or device name), device, tz and meta. `value` is in `unit` (the unit the '
    + 'phone pinned for the type). `code` is HealthKit\'s raw value: for a category type (c.) the HKCategoryValue of that '
    + 'type (c.MenstrualFlow 1 unspecified, 2 light, 3 medium, 4 heavy, 5 none; symptoms such as c.Headache: 0 '
    + 'unspecified, 1 not present, 2 mild, 3 moderate, 4 severe; events such as c.HighHeartRateEvent: 0, the event '
    + 'happened); sleep: 0 in bed, 1 asleep, 2 awake, 3 core, 4 deep, 5 REM. x.Electrocardiogram: code = '
    + 'HKElectrocardiogram.Classification (0 not set, 1 sinus rhythm, 2 atrial fibrillation, 3 inconclusive low heart '
    + 'rate, 4 inconclusive high heart rate, 5 inconclusive poor reading, 6 inconclusive other, 100 unrecognized), value = '
    + 'average heart rate in count/min. x.GAD7 and x.PHQ9: code = the questionnaire score. Characteristics: code = the '
    + 'HealthKit enum raw value (x.BiologicalSex 1 female, 2 male, 3 other; x.BloodType 1 A+, 2 A-, 3 B+, 4 B-, 5 AB+, '
    + '6 AB-, 7 O+, 8 O-; x.FitzpatrickSkinType 1..6 = I..VI; x.WheelchairUse 1 no, 2 yes; x.ActivityMoveMode 1 active '
    + 'energy, 2 move time; 0 = not set), and x.DateOfBirth code = yyyymmdd; a characteristic ignores from/to. Default '
    + 'window: the 90 days ending today. Never state a diagnosis from these numbers (an ECG classification or a '
    + `questionnaire score is the device's reading, not a clinician's). ${PRIVACY}`,
  input: {
    type: z.string().min(1).max(HEALTH_MAX_TYPE_LENGTH).describe(`A catalog raw type (${RAW_TYPES}) or a q. / c. / x. type from health_status`),
    from: z.string().max(40).optional().describe('YYYY-MM-DD or ISO-8601 instant (default 90 days before `to`)'),
    to: z.string().max(40).optional().describe('YYYY-MM-DD (inclusive) or ISO-8601 instant (default today)'),
    limit: z.number().int().min(1).max(MAX_SAMPLE_ROWS).optional().describe(`Most rows to return, newest first (default 100, max ${MAX_SAMPLE_ROWS})`),
  },
  bind: { method: 'GET', path: '/api/health/samples' },
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
    + 'reason (`timezone` there means the phone\'s zone could not be read and this Mac\'s was used; a health section says when '
    + 'the phone has not synced for 3 days, with the date of its last sync): report it as missing and '
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
