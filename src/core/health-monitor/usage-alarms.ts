/**
 * Walnut Health's real-use alarms: they read the minute counters the real-use recorder writes
 * (core/usage-watch/record.ts) and send an alarm to whoever owns its target (usage-watch/route.ts,
 * the `route` action) instead of opening a fix task. With the `real_use_watch` experiment off
 * they still evaluate and show on the Health page, and tell nobody.
 */
import type { AlarmDef } from './types.js'

const route = { then: 'route' as const }

export const USAGE_ALARMS: readonly AlarmDef[] = [
  {
    id: 'usage.cut',
    title: 'A tool\'s answers get cut',
    description: 'Claude Code saved an answer of this Walnut tool to a file instead of passing it on, so the agent read only its start: the call failed for it.',
    metric: 'usage.op.cut{op=*}', kind: 'counter', stat: 'sum', periodMin: 60, comparison: '>=', threshold: 1,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: 'confirmed cuts', action: route,
  },
  {
    id: 'usage.errors',
    title: 'A tool keeps failing',
    description: 'Server errors and timeouts of this Walnut tool (not a host being away, not a designed refusal).',
    metric: 'usage.op.errors{op=*}', kind: 'counter', stat: 'sum', periodMin: 60, comparison: '>=', threshold: 5,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: 'errors', action: route,
  },
  {
    id: 'usage.errors.watched',
    title: 'A watched tool fails',
    description: 'Server errors and timeouts of a tool a shipped change is watching: a low-traffic tool rings on fewer.',
    metric: 'usage.op.watched_errors{op=*}', kind: 'counter', stat: 'sum', periodMin: 60, comparison: '>=', threshold: 2,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: 'errors', action: route,
  },
  {
    id: 'usage.bad_args',
    title: 'Agents often call a tool wrong',
    description: 'Calls this tool refused for their arguments, as a share of its calls in 24 hours (10 or more): its description or its shape leads agents to call it wrong.',
    metric: 'usage.op.bad_args_pct{op=*}', kind: 'gauge', stat: 'last', periodMin: 5, comparison: '>=', threshold: 20,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: '% of calls', action: route,
  },
  {
    id: 'usage.slow',
    title: 'Reads are slow',
    description: 'Reads from the browser or the phone that took more than 5 s (long polls and streams not counted).',
    metric: 'usage.http.slow{route=*}', kind: 'counter', stat: 'sum', periodMin: 60, comparison: '>=', threshold: 10,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: 'slow reads', action: route,
  },
  {
    id: 'usage.server_errors',
    title: 'A request fails on the server',
    description: 'Server errors (5xx) of one request from the browser or the phone. 501 is a designed answer and not counted.',
    metric: 'usage.http.server_errors{route=*}', kind: 'counter', stat: 'sum', periodMin: 60, comparison: '>=', threshold: 5,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: 'server errors', action: route,
  },
  {
    id: 'usage.page',
    title: 'A page keeps failing',
    description: 'The same error in Walnut\'s pages (a timed-out request, a request the browser refused, or the same thrown error). A request that never reached the server (rejected or failed) is not counted, nor one whose route already rings for server errors; timeouts of several requests together count once as a stall, and none right after a restart.',
    metric: 'usage.page.errors{kind=*}', kind: 'counter', stat: 'sum', periodMin: 360, comparison: '>=', threshold: 5,
    evaluationPeriods: 1, datapointsToAlarm: 1, missing: 'notBreaching', unit: 'errors in 6 h', action: route,
  },
]

/** The usage kind and recorded name an alarm instance's labels name. */
export function usageTargetOf(defId: string, labels: Record<string, string> | undefined): { kind: 'op' | 'http' | 'page'; name: string } | null {
  if (!defId.startsWith('usage.') || !labels) return null
  if (labels.op) return { kind: 'op', name: labels.op }
  if (labels.route) return { kind: 'http', name: labels.route }
  if (labels.kind) return { kind: 'page', name: labels.kind }
  return null
}
