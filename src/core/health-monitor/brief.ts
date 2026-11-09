/**
 * The words a health alarm hands a task: the fix task's brief (everything needed
 * to start without asking), the note an owner task or a reused fix task gets when
 * the alarm rings again, and the note when it is back to OK.
 */

import { fillPattern } from './evaluate.js'
import { HOUR_MS, hourStart, signatureId, type HourBuckets } from './log-alarms.js'
import type { AlarmDef, AlarmInstanceState, MinuteRow } from './types.js'

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
    '## The alarm',
    `What it watches: ${def.description}`,
    inst.signature ? `The log line kind: \`${inst.signature}\`` : `Metric: \`${inst.labels ? fillPattern(def.metric, inst.labels) : def.metric}\``,
    inst.signature && sample ? `A recent line: ${sample}` : '',
    `Why it is in ALARM: ${reason}.`,
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
