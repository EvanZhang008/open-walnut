/**
 * A warn line that records one event of what a built-in alarm measures belongs to
 * that alarm (AlarmDef.logLines), never also to the log alarms.
 *
 * 2026-11-16: the log spike alarm rang on "web: event-loop blocked (probe late)",
 * 30 lines in an hour against a normal of 4, and opened a fix task. The stall
 * alarm, which judges each of those holds by its length and its cause, read OK:
 * 24 were under a second and 6 were the machine's (stall-cause.ts). Counted again
 * by volume alone, the same events rang where their own alarm had decided not to.
 *
 * The class: a warn or error line logged where a metric a built-in alarm watches
 * is emitted. This test finds every such emission in src/ (observe, count,
 * metricsCount, reportGauge), reads the warn and error lines logged near it, and
 * fails for one that is neither in an alarm's logLines nor listed below as a line
 * that reports something else. It also fails for a logLines entry no log call writes.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_ALARMS, logLineOwners } from '../../../src/core/health-monitor/alarms.js'
import { healthSeriesNamesOf, RESUME_MACHINE_METRIC } from '../../../src/core/health-monitor/collect.js'
import { parseSeriesKey } from '../../../src/core/health-monitor/evaluate.js'
import { signatureKey } from '../../../src/core/health-monitor/signature.js'
import * as stallCause from '../../../src/core/stall-cause.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** How many lines around an emission count as logged with it. */
const NEAR = 20

/**
 * Warn/error lines near an alarm metric's emission that report something other
 * than the event the alarm measures (so the log alarms keep watching them), each
 * with why. Empty today.
 */
const INDEPENDENT_LINES: Record<string, string> = {
  'task: status check: mismatches':
    'written for every mismatch a pass finds, first sightings fixed on the spot and parks on nothing too; '
    + 'the status.mismatch alarm counts only the ones that came back, so a flood of new ones is the log alarms\' to see',
  'obs: invariant violation':
    'a turn record that breaks an invariant (a bug in the recorder or its caller), not a slow delivery the send alarms judge',
}

/** Upper-case constants an emission or a log call may name, resolved to their values. */
const CONSTANTS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(stallCause).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
  RESUME_MACHINE_METRIC,
}

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) srcFiles(p, out)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The series names the built-in alarms read. */
const ALARM_SERIES = new Set(BUILTIN_ALARMS.flatMap((d) => [d.metric, ...(d.also ? [d.also.metric] : [])]).map((m) => parseSeriesKey(m).name))

function feedsAlarm(name: string): boolean {
  return healthSeriesNamesOf(name).some((k) => ALARM_SERIES.has(parseSeriesKey(k).name))
}

// A bare call only: `tracker.observe(...)` is another object's method, not the metrics registry.
const EMIT = /(?<![.\w])(?:observe|count|metricsCount|reportGauge)\(\s*(?:'([^']+)'|"([^"]+)"|([A-Z][A-Z0-9_]+)\b|(stallMetricOf)\()/g
// Across lines (a message on the line after the call), and the `log.x[cond ? 'error' : 'warn'](` form.
const LOG = /\blog\.(\w+)(?:\.(?:warn|error)|\[[^\]]*'(?:warn|error)'[^\]]*\])\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([A-Z][A-Z0-9_]+)\b)/g

interface Found { file: string; line: number; sig: string }

function scan(): { near: Found[]; unresolved: string[]; allLogSigs: Set<string> } {
  const near: Found[] = []
  const unresolved: string[] = []
  const allLogSigs = new Set<string>()
  for (const file of srcFiles(path.join(repoRoot, 'src'))) {
    const text = fs.readFileSync(file, 'utf-8')
    const rel = path.relative(repoRoot, file)
    const lines = text.split('\n')
    // sig null: a log call naming a constant this test cannot resolve (only an error near an emission)
    const logs: Array<{ line: number; sig: string | null; name?: string }> = []
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
    const lineAt = (index: number): number => {
      let lo = 0, hi = starts.length - 1
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= index) lo = mid; else hi = mid - 1 }
      return lo + 1
    }
    for (const m of text.matchAll(LOG)) {
      const line = lineAt(m.index!)
      const msg = m[2] ?? m[3] ?? m[4] ?? (m[5] ? CONSTANTS[m[5]] : undefined)
      if (msg === undefined) { logs.push({ line, sig: null, name: m[5] }); continue }
      const sig = signatureKey(m[1]!, msg)
      allLogSigs.add(sig)
      logs.push({ line, sig })
    }
    if (rel === 'src/core/observability/metrics.ts') continue // the registry itself
    lines.forEach((l, i) => {
      for (const m of l.matchAll(EMIT)) {
        let names: string[]
        if (m[4]) names = [stallCause.STALL_OWN_METRIC, stallCause.STALL_MACHINE_METRIC]
        else if (m[3]) {
          const v = CONSTANTS[m[3]]
          if (v === undefined) { unresolved.push(`${rel}:${i + 1} metric constant ${m[3]}`); continue }
          names = [v]
        } else names = [m[1] ?? m[2]!]
        if (!names.some(feedsAlarm)) continue
        for (const lg of logs) {
          if (Math.abs(lg.line - (i + 1)) > NEAR) continue
          if (lg.sig === null) unresolved.push(`${rel}:${lg.line} log constant ${lg.name}`)
          else near.push({ file: rel, line: lg.line, sig: lg.sig })
        }
      }
    })
  }
  return { near, unresolved, allLogSigs }
}

describe('log lines an alarm already judges', () => {
  const { near, unresolved, allLogSigs } = scan()
  const owners = logLineOwners(BUILTIN_ALARMS)

  it('finds the event-loop stall emission and its warn line (the scan works)', () => {
    expect(near.some((f) => f.file === 'src/core/event-loop-monitor.ts'
      && f.sig === signatureKey('web', stallCause.PROBE_LATE_MESSAGE))).toBe(true)
  })

  it('every constant an emission or a log call names resolves', () => {
    expect(unresolved, 'add the constant to CONSTANTS in this test').toEqual([])
  })

  it('every warn/error line logged with an alarm metric is in that alarm\'s logLines', () => {
    const missing = near.filter((f) => !owners.has(f.sig) && !(f.sig in INDEPENDENT_LINES))
    expect(missing.map((f) => `${f.file}:${f.line} "${f.sig}"`), [
      'A warn/error line is logged where a metric a built-in alarm watches is emitted.',
      'If it records the event that alarm measures, add its signatureKey to the alarm\'s logLines',
      '(src/core/health-monitor/alarms.ts), so the log alarms do not count it again by volume.',
      'If it reports something else, list it in INDEPENDENT_LINES here with why.',
    ].join('\n')).toEqual([])
  })

  it('every INDEPENDENT_LINES entry is still logged with an alarm metric', () => {
    const stale = Object.keys(INDEPENDENT_LINES).filter((sig) => !near.some((f) => f.sig === sig))
    expect(stale).toEqual([])
  })

  it('every logLines entry is a line some log call writes', () => {
    const stale = [...owners.keys()].filter((sig) => !allLogSigs.has(sig))
    expect(stale).toEqual([])
  })
})
