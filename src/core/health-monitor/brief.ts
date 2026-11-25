/**
 * The words a health alarm hands a task: the fix task's brief (everything needed
 * to start without asking), the note an owner task or a reused fix task gets when
 * the alarm rings again, and the note when it is back to OK.
 */

import { fillPattern } from './evaluate.js'
import { HEALTH_ERRORS_ALARM, healthErrorEvidence } from '../notifications/health-investigate.js'
import { HOST_DOWN_ALARM, hostDownEvidence } from '../hosts/host-down-gauge.js'
import { HOUR_MS, hourStart, signatureId, type HourBuckets } from './log-alarms.js'
import type { AlarmDef, AlarmInstanceState, MinuteRow } from './types.js'
import { clause } from '../../utils/format.js'

export interface BriefInput {
  def: AlarmDef
  inst: AlarmInstanceState
  reason: string
  now: number
  rows: readonly MinuteRow[]
  hours: HourBuckets
  sample?: string
}

function evidence({ def, inst, reason, now, rows, hours, sample }: BriefInput): string[] {
  const lines = [
    ...(def.id === HEALTH_ERRORS_ALARM ? healthErrorEvidence(inst.labels?.category) : []),
    ...(def.id === HOST_DOWN_ALARM ? hostDownEvidence(inst.labels?.host) : []),
    '## The alarm',
    `What it watches: ${def.description}`,
    inst.signature ? `The log line kind: \`${inst.signature}\`` : `Metric: \`${inst.labels ? fillPattern(def.metric, inst.labels) : def.metric}\``,
    inst.signature && sample ? `A recent line: ${sample}` : '',
    `Why it is in ALARM: ${clause(reason)}.`,
    `In ALARM since ${new Date(inst.since).toISOString()}; checked ${new Date(now).toISOString()}.`,
  ]
  if (inst.signature) {
    const h = hourStart(now)
    const sid = signatureId(inst.signature)
    const counts: string[] = []
    for (let i = 23; i >= 0; i--) counts.push(String(hours[String(h - i * HOUR_MS)]?.[sid] ?? '-'))
    lines.push(`Per hour, the last 24 hours (oldest first, UTC): ${counts.join(' ')}`)
  } else {
    const key = inst.labels ? fillPattern(def.metric, inst.labels) : def.metric
    const vals = rows.slice(-120).map((r) => r.v[key]).filter((v): v is number => typeof v === 'number')
    if (vals.length) lines.push(`Last ${vals.length} minutes: ${vals.join(' ')}`)
  }
  const tried = inst.actions.filter((a) => a.kind === 'auto-fix')
  if (tried.length) lines.push(`Already tried: ${tried.map((a) => `${a.detail} (${a.ok ? 'ran' : 'failed'})`).join('; ')}`)
  return lines
}

/**
 * What an agent looking into Walnut Health's errors may do alone, and what goes to the person
 * (2026-11-17, the user: "if no risk just fix, if there is an issue, then show as a potential
 * error notification").
 */
function healthErrorsRules(): string[] {
  return [
    '## What you may do alone, and what goes to the person',
    'First check the Walnut project for an open task already on the same error (`task_list`); if one is, hand it this note with `task_send` and finish.',
    'Fix it yourself when the step is safe and can be undone: reconnect a host (its Connect now), restart a service or a daemon, clear a cache Walnut rebuilds, retry what failed, or a code fix landed the usual way. Write what you did in your task note; the error recovers in Walnut Health by itself.',
    'Do NOT do a step that touches the person\'s data, credentials, permissions, money or someone else\'s machine, deletes anything that cannot be rebuilt, or sends anything outward. Then, and when you cannot find a fix, set this task to NEED_ACTION with one sentence first: "Possible problem: <what>, because <why>. My pick: <the step>." That is the only way this reaches the person.',
    'An error that is expected and harmless: lower what is logged instead (a warn, not an error), and say why.',
  ]
}

function doneMeans(id: string): string[] {
  return [
    '## Done means',
    'The cause is fixed for its whole class (with a guard test), the fix is live, and this alarm reads OK on the Health page',
    `(\`walnut tools call health_monitor '{"alarm":"${id}"}'\`). If the line or the number is expected and harmless, change`,
    'what is logged or counted instead (a lower log level, a better threshold with `health_alarm_set`), and say why.',
  ]
}

/** A new fix task's description. */
export function fixBrief(b: BriefInput): string {
  return [
    `Walnut's health monitor raised the alarm "${b.def.title}" (${b.inst.id}) and could not clear it by itself. Find the root cause and fix it.`,
    '',
    ...evidence(b),
    '',
    ...(b.def.id === HEALTH_ERRORS_ALARM || b.def.id === HOST_DOWN_ALARM ? [...healthErrorsRules(), ''] : []),
    ...doneMeans(b.inst.id),
  ].filter((l) => l !== '').join('\n')
}

/** For a task that already has the problem: the alarm's owner, or its open fix task ringing again. */
export function ringAgainNote(b: BriefInput, owner: boolean): string {
  const head = owner
    ? `Walnut's health monitor raised the alarm "${b.def.title}" (${b.inst.id}). You own this problem, so it comes to you instead of a new fix task.`
    : `The alarm "${b.def.title}" (${b.inst.id}) this task was filed for is in ALARM again.`
  return [head, '', ...evidence(b), '', ...doneMeans(b.inst.id)].filter((l) => l !== '').join('\n')
}

/** The alarm is back to OK: the task decides whether its work is done. */
export function recoveredNote(def: AlarmDef, inst: AlarmInstanceState, now: number): string {
  return [
    `The alarm "${def.title}" (${inst.id}) is back to OK since ${new Date(now).toISOString()}.`,
    'If your fix is live and holds, finish this task; if the number only dipped, keep going: it rings again if it comes back.',
  ].join(' ')
}
