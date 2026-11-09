/**
 * The built-in alarms. Each threshold is a starting point read off the
 * maintainer's production logs (2026-11-08); a person or an agent changes one
 * through the Health page or `health_alarm_set`, which stores an override and
 * never edits this list.
 *
 * Log alarms are not listed here: every kind of warn or error line gets its own
 * instance from log-alarms.ts.
 */

import type { AlarmDef } from './types.js'
import { STALL_MACHINE_METRIC, STALL_OWN_METRIC } from '../stall-cause.js'

export const BUILTIN_ALARMS: readonly AlarmDef[] = [
  {
    id: 'disk.free',
    title: 'Disk space low',
    description: 'Free space on the disk that holds Walnut\'s data. Walnut frees what it can rebuild first.',
    metric: 'disk.free_gb', kind: 'gauge', stat: 'min', periodMin: 5, comparison: '<', threshold: 30,
    evaluationPeriods: 3, datapointsToAlarm: 3, missing: 'missing',
    also: { metric: 'disk.used_pct', stat: 'max', comparison: '>', threshold: 85 },
    unit: 'GB', action: { autoFix: 'disk-sweep', then: 'notify', graceMin: 30 },
  },
  {
    id: 'host.link',
    title: 'Host link keeps dropping',
    description: 'How often the link to a host is lost in an hour. A few a day is a network; this many is a bug or a broken route.',
    metric: 'host.link.lost{host=*}', kind: 'counter', stat: 'sum', periodMin: 60, comparison: '>', threshold: 6,
    evaluationPeriods: 2, datapointsToAlarm: 2, missing: 'notBreaching',
    unit: 'per hour', action: { autoFix: 'host-reconnect', then: 'fix-task', graceMin: 60 },
  },
  {
    id: 'eventloop.stall',
    title: 'Server event loop stalls',
    description: 'The longest event-loop hold in each minute that Walnut\'s own work caused (code, garbage collection or a blocking call). While it is high every page and every send waits.',
    metric: STALL_OWN_METRIC, kind: 'gauge', stat: 'max', periodMin: 1, comparison: '>', threshold: 1000,
    evaluationPeriods: 10, datapointsToAlarm: 6, missing: 'notBreaching',
    unit: 'ms', action: { then: 'fix-task' },
  },
  {
    // The machine's share of the stalls (stall-cause.ts): no Walnut code ran in
    // them, so there is nothing for a fix task to fix. Low memory, swap and a
    // nearly full disk have alarms of their own.
    id: 'eventloop.starved',
    title: 'Machine too busy to run the server',
    description: 'The longest event-loop delay in each minute while the machine did not run the server (CPU or memory pressure, swap). Walnut code was not running; pages and sends still wait.',
    metric: STALL_MACHINE_METRIC, kind: 'gauge', stat: 'max', periodMin: 1, comparison: '>', threshold: 1000,
    evaluationPeriods: 10, datapointsToAlarm: 6, missing: 'notBreaching',
    unit: 'ms', action: { then: 'none' },
  },
  {
    id: 'send.delivery',
    title: 'Messages slow to reach a running session',
    description: 'The slowest send into a live session (its stdin, or into a running turn) in each 10 minutes.',
    metric: 'send.delivery.live', kind: 'gauge', stat: 'max', periodMin: 10, comparison: '>', threshold: 15_000,
    evaluationPeriods: 3, datapointsToAlarm: 2, missing: 'notBreaching',
    unit: 'ms', action: { then: 'fix-task' },
  },
  {
    id: 'send.resume',
    title: 'Messages slow to wake a stopped session',
    description: 'The slowest send that had to start the session again, in each 30 minutes.',
    metric: 'send.delivery.resume', kind: 'gauge', stat: 'max', periodMin: 30, comparison: '>', threshold: 120_000,
    evaluationPeriods: 2, datapointsToAlarm: 2, missing: 'notBreaching',
    unit: 'ms', action: { then: 'fix-task' },
  },
  {
    id: 'session.hung',
    title: 'Sessions look hung',
    description: 'Sessions that gave no output for 5 minutes after a message reached them, at the 30-second session check.',
    metric: 'session.hung', kind: 'gauge', stat: 'min', periodMin: 1, comparison: '>=', threshold: 3,
    evaluationPeriods: 15, datapointsToAlarm: 15, missing: 'notBreaching',
    unit: 'sessions', action: { then: 'fix-task' },
  },
  {
    id: 'process.fd',
    title: 'Open files keep growing',
    description: 'Files and sockets the server holds open. A leak ends in EMFILE and a dead server.',
    metric: 'process.fd', kind: 'gauge', stat: 'min', periodMin: 1, comparison: '>', threshold: 1000,
    evaluationPeriods: 10, datapointsToAlarm: 10, missing: 'missing',
    unit: 'files', action: { then: 'fix-task' },
  },
  {
    id: 'memory.pressure',
    title: 'Memory pressure',
    description: 'The machine\'s memory pressure (0 normal, 1 warn, 2 critical). Walnut already sheds its own background memory.',
    metric: 'memory.pressure', kind: 'gauge', stat: 'min', periodMin: 1, comparison: '>=', threshold: 1,
    evaluationPeriods: 30, datapointsToAlarm: 30, missing: 'missing',
    unit: 'level', action: { then: 'fix-task' },
  },
  {
    id: 'server.restarts',
    title: 'Server restarts on its own',
    description: 'Times this server started again on the build it already ran (a crash and its respawn, a relaunch, a reboot) in the last 24 hours. Deploys and updates start a new build and are not counted: the deploy queue paces those.',
    metric: 'server.unplanned_restarts_24h', kind: 'gauge', stat: 'last', periodMin: 5, comparison: '>=', threshold: 2,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'missing',
    unit: 'per day', action: { then: 'fix-task' },
  },
  {
    id: 'server.shutdown',
    title: 'Server shutdown runs out of time',
    description: 'Times this server\'s graceful shutdown did not finish and was cut off, in the last 24 hours.',
    metric: 'server.shutdown_bails_24h', kind: 'gauge', stat: 'last', periodMin: 5, comparison: '>=', threshold: 1,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'missing',
    unit: 'per day', action: { then: 'fix-task' },
  },
  {
    id: 'status.mismatch',
    title: 'Task statuses disagree with their facts',
    description: 'Open tasks whose status the hourly check re-derived last time and found wrong again, so Walnut\'s own fix did not hold.',
    metric: 'status.mismatches', kind: 'gauge', stat: 'last', periodMin: 5, comparison: '>', threshold: 0,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'missing',
    unit: 'tasks', action: { autoFix: 'status-recheck', then: 'fix-task', graceMin: 60 },
  },
  {
    id: 'ssh.login',
    title: 'Remote sign-in expires soon',
    description: 'This machine\'s SSH certificate for remote hosts expires within 3 hours. Only you can renew it; its own letter tells you how.',
    metric: 'ssh.cert.expiring', kind: 'gauge', stat: 'last', periodMin: 1, comparison: '>=', threshold: 1,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching',
    unit: '', action: { then: 'none' },
  },
]

/** The person's own alarms on their own command metrics (custom-metrics.ts, from config). */
let custom: readonly AlarmDef[] = []

export function setCustomAlarms(defs: readonly AlarmDef[]): void {
  custom = defs
}

/** Every alarm with a def of its own: the built-ins, then the person's own. */
export function allAlarms(): readonly AlarmDef[] {
  return custom.length ? [...BUILTIN_ALARMS, ...custom] : BUILTIN_ALARMS
}

/** A built-in's or a custom alarm's def by its id. */
export function builtinAlarm(id: string): AlarmDef | undefined {
  return BUILTIN_ALARMS.find((d) => d.id === id) ?? custom.find((d) => d.id === id)
}
