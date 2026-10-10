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

/**
 * A list argument: "task,project" or ["task","project"]. The array form used to be
 * refused, though the description called the groups combinable (2026-10-10). The GET
 * binding sends an array as the same comma list.
 */
const LIST = (max: number) => z.union([z.string().max(max), z.array(z.string().max(20)).max(12)])

defineOp({
  name: 'time_report',
  title: 'Where the time went over a range of days',
  description:
    'Answers "where did my time go" for a range of local days (default the last 7, at most 31, inside the 90-day window): '
    + 'per-day totals, groups (task with title + project + createdAt, project, hour of day, kind, Mac app, site, '
    + 'session view such as chat/files/board, file, plugin item), '
    + 'fragmentation per day (tasks touched, switches, longest stretch, deep share) and EVERY number in two views: the '
    + 'whole day and the user\'s work hours (`workMin`, `workShare` = share of all work-hours attention; work hours from '
    + 'time_work_hours_set, default 09:00-18:00 Mon-Fri). walnutMin = the user\'s attention in Walnut (lease minutes, the '
    + 'seconds another app was frontmost cut as overlapMin); readingMin = inferred reading in Walnut without input; '
    + 'agentMin = agents running alone (costs no attention, never summed in); outside = other Mac apps from the foreground '
    + 'sampler, Walnut\'s own foreground excluded; attention = walnut + reading + outside; callMin = a call app holding a '
    + 'call on this Mac (overlaps screen time, never added); sent = messages the user sent. Echoes from/to: say the window you used. '
    + 'For WHEN things happened on a day (sleep, workouts, places, meetings, plan vs actual) use time_timeline; for one '
    + 'day of everything use day_review. Read the walnut-time-review skill before writing a time audit.',
  input: {
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('First local date YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Last local date YYYY-MM-DD (inclusive, default today)'),
    last_days: z.number().int().min(1).max(31).optional().describe('Instead of from/to: the N days ending today (default 7)'),
    kinds: LIST(60).optional().describe('Kinds counted as the user\'s time, a comma list or an array: session, triage, chat, app (a plugin view in Walnut), agent (default session,triage,chat,app)'),
    include_outside: z.boolean().optional().describe('Add other Mac apps from the foreground sampler (default true)'),
    group_by: LIST(100).optional().describe('Groups, a comma list or an array, any of: day, task, project, hour, kind, app, host, view, file, item (default task,project; days are always returned)'),
    top: z.number().int().min(1).max(100).optional().describe('Rows per group (default 15; the rest are summed in otherMin)'),
    work_start: z.string().max(5).optional().describe('Override work hours start for this report, HH:MM'),
    work_end: z.string().max(5).optional().describe('Override work hours end for this report, HH:MM'),
    work_days: LIST(40).optional().describe('Override working weekdays, a comma list or an array (mon,tue,wed,thu,fri)'),
    merge_gap_min: z.number().int().min(1).max(120).optional().describe('Same-task records closer than this join one stretch (default 5)'),
    long_min: z.number().int().min(5).max(480).optional().describe('A stretch this long counts as deep work (default 45)'),
  },
  bind: { method: 'GET', path: '/api/time/report' },
  timeoutMs: 30_000,
  tags: { readonly: true, remote: 'allow', primaryOnly: true },
})

defineOp({
  name: 'time_work_hours_set',
  title: 'Set the user\'s work hours',
  description:
    'Set the work hours every time report splits by (local time): start and end as HH:MM, days as weekday names. '
    + 'Fields left out keep their value; reset:true goes back to the default 09:00-18:00 Mon-Fri. Only when the user says '
    + 'what their hours are; a one-off question about other hours takes work_start/work_end on time_report instead.',
  input: {
    start: z.string().max(5).optional().describe('HH:MM, e.g. 09:00'),
    end: z.string().max(5).optional().describe('HH:MM, e.g. 18:00'),
    days: z.array(z.string().max(9)).max(7).optional().describe('Working weekdays, e.g. ["mon","tue","wed","thu","fri"]'),
    reset: z.boolean().optional().describe('true: back to the default'),
  },
  bind: { method: 'POST', path: '/api/time/work-hours' },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})

defineOp({
  name: 'time_timeline',
  title: 'One day (or a few) as a single timeline from every source',
  description:
    'WHEN things happened: one serial timeline per local day (default today, at most 7 days) merged from every '
    + 'source: Walnut attention, other Mac apps, sleep and workouts (Apple Health), calendar meetings and planned '
    + 'blocks, places (iPhone visits, with the user\'s own labels such as home/office/gym and inferred travel), and any '
    + 'plugin source. Each block has kind (screen, sleep, workout, meeting, plan, gap…), source and confidence '
    + '(measured / planned / inferred); a screen block lists its top tasks and apps and the meeting it sat in. '
    + '`plan` compares every calendar block with what was measured inside it (verdict kept / partly / other_work / '
    + 'meeting_on_screen / not_on_screen). A meeting also gets `attendance` from the calls on this Mac: attended (a call '
    + 'ran; meetingMin = the call minus other work during it), not_attended (a recurring meeting never on a call, or other '
    + 'work on screen), needs_confirmation (no call and nothing recorded, or two meetings at once on one call: ASK the '
    + 'user, never guess; record the answer with time_meeting_attendance_set) or unknown (no call data). `summary` gives minutes per kind for the whole day '
    + 'and for work hours, plus callMin, adHocCallMin, meetingMin and needsConfirmation. '
    + '`sources[]` says what each source could see: a source with available:false is MISSING, never zero. Flags '
    + '(a workout left running, a sleep recording gap) must be passed on. For totals over weeks use time_report. '
    + 'Places and health stay on this Mac: summarise ("gym 1h05"), never paste addresses or raw values.',
  input: {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('One local date YYYY-MM-DD (default today)'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Or: first date of a range (at most 7 days)'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Last date of the range (inclusive)'),
    work_start: z.string().max(5).optional().describe('Override work hours start, HH:MM'),
    work_end: z.string().max(5).optional().describe('Override work hours end, HH:MM'),
  },
  bind: { method: 'GET', path: '/api/time/timeline' },
  timeoutMs: 30_000,
  localOnlyMessage: 'The day timeline includes places and health, so it is only available to sessions on this Mac',
  tags: { readonly: true, remote: 'deny', localHostGateway: true, primaryOnly: true },
})

defineOp({
  name: 'time_meeting_attendance_set',
  title: 'Record whether the user attended a meeting',
  description:
    'Record the user\'s own answer for ONE meeting occurrence that time_timeline marked needs_confirmation (or correct '
    + 'any other): attended true or false, null to clear. Use the meeting\'s eventId from time_timeline `plan` or '
    + '`summary.needsConfirmation`. Only with the user\'s answer; never guess. Kept on this Mac.',
  input: {
    event_id: z.string().min(1).max(200).describe('eventId of the meeting in time_timeline'),
    attended: z.boolean().nullable().describe('true = attended, false = did not attend, null = clear the answer'),
  },
  bind: { method: 'POST', path: '/api/time/meetings/attendance' },
  localOnlyMessage: 'Meeting answers are kept on this Mac, so they can only be set by sessions on this Mac',
  tags: { readonly: false, remote: 'deny', localHostGateway: true, primaryOnly: true },
})

defineOp({
  name: 'time_meetings_ignore_set',
  title: 'Leave meetings out of the time review',
  description:
    'Replace the list of meetings the time review leaves out of plan checks (config time.meetings.ignore): title words or '
    + 'phrases, case-insensitive. Only when the user asks ("ignore the team lunch"). A recurring meeting never on a call '
    + 'is already counted as not attended without this. [] clears the list.',
  input: {
    patterns: z.array(z.string().max(120)).max(50).describe('Title words or phrases, e.g. ["lunch", "office hours"]'),
  },
  bind: { method: 'POST', path: '/api/time/meetings/ignore' },
  tags: { readonly: false, remote: 'allow', primaryOnly: true },
})
