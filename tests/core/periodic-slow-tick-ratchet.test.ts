/**
 * Ratchet: a slow-tick warning in periodic work is judged against the tick's
 * budget (slowTickWarnMs), never a fixed small wall time.
 *
 * A periodic tick's wall time is mostly awaited I/O. The health monitor warned past
 * 500 ms and so warned on almost every tick (about 2,000 lines a day, 2026-11-13).
 * This scans every file that runs periodic work (runPeriodic) and fails when one of
 * its warn lines about being slow is not gated by the budget-derived threshold.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('periodic slow-tick warnings use slowTickWarnMs', () => {
  const files = walk(path.join(ROOT, 'src')).filter(f => /\brunPeriodic\(/.test(fs.readFileSync(f, 'utf8')))

  it('finds the periodic work (the scan is not vacuous)', () => {
    expect(files.some(f => f.endsWith('session-health-monitor.ts'))).toBe(true)
  })

  it('every slow-tick warn is gated by the budget threshold', () => {
    const offenders: string[] = []
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8')
      // A warn about slowness, its message possibly on the next line: a direct
      // `.warn('... slow ...')`, or a level picked into `slowLog` and called.
      const call = /(\.warn|\bslowLog)\(\s*['"`][^'"`]*\bslow\b/gi
      for (const m of text.matchAll(call)) {
        const lineNo = text.slice(0, m.index).split('\n').length
        // The gate must be CODE in the lines just before the call, not a comment.
        const code = text.split('\n').slice(Math.max(0, lineNo - 4), lineNo)
          .map(l => l.replace(/\/\/.*$/, '')).join('\n')
        if (!/SLOW_TICK_WARN_MS|slowTickWarnMs\(/.test(code)) {
          offenders.push(`${path.relative(ROOT, f)}:${lineNo}: ${m[0].replace(/\s+/g, ' ')}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('catches a fixed-threshold slow warn split over lines (the detector works)', () => {
    const sample = "if (ms > 500) log.session.warn(\n  'tick slow', { ms })\n"
    expect(/(\.warn|\bslowLog)\(\s*['"`][^'"`]*\bslow\b/i.test(sample)).toBe(true)
  })
})
