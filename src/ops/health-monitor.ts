/**
 * The health monitor's ops (core/health-monitor/): read Walnut's own alarms, and
 * change one the way a person does on the Health page (threshold, mute, off).
 * Named `health_monitor` because `health_*` ops are the user's Apple Health data.
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { withOutcome } from './outcome.js'

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

defineOp({
  name: 'health_monitor',
  title: 'Walnut\'s own health alarms',
  description:
    'Read-only. Walnut\'s health monitor, like CloudWatch alarms for Walnut itself: every built-in alarm (disk, host '
    + 'links, event-loop stalls, slow sends, hung sessions, open files, memory pressure, restarts, cut-off shutdowns, '
    + 'status drift, the SSH certificate) and every log alarm (a kind of warn/error line far above its normal, or high '
    + 'every day), each with its state (OK, ALARM, INSUFFICIENT_DATA), value, condition, a 24-hour spark and what '
    + 'Walnut did about it (an auto-fix, a fix task, a notification). Give `alarm` for one alarm with its minute series '
    + 'and its history. Runs on the primary.',
  input: {
    alarm: z.string().max(200).optional().describe('One alarm id (as listed), for its series and history'),
  },
  bind: { method: 'GET', path: '/health-monitor', query: ['alarm'] },
  mapResult: ({ body, args }) => {
    const b = rec(body)
    if (args.alarm) return withOutcome({ ...b }, `Alarm ${String(args.alarm)} is ${String(b.state)}.`, 'Change it with health_alarm_set.')
    const c = rec(b.counts)
    const n = Number(c.ALARM ?? 0)
    return withOutcome({ ...b }, n ? `${n} alarm${n === 1 ? '' : 's'} in ALARM.` : 'No alarm is in ALARM.',
      n ? 'Each one names what Walnut did (actions) and its fix task, if any.' : 'Nothing else is required.')
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
