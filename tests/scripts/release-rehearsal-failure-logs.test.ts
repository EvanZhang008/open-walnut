/**
 * A failed rehearsal scenario prints its own walnuts' logs (scripts/release-rehearsal/failure-logs.mjs).
 * 2026-11-04: three 0.6.19 field scenarios failed on their npm install, and the job printed
 * 0.6.25's logs under their names, so npm's own error never reached the job log.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_FAILURES_LOGGED, failureLogs } from '../../scripts/release-rehearsal/failure-logs.mjs'

const REPO = path.resolve(__dirname, '../..')
const w = (name: string) => ({ name, logFile: `/x/${name}/log.txt` })

describe('release rehearsal · the logs a failure prints', () => {
  const a = w('field-0.6.25'), b = w('field-work-0.6.25'), c = w('field-0.6.19'), d = w('field-work-0.6.19')
  const all = [a, b, c, d]

  it('a failed scenario prints the walnuts it made, never an earlier scenario\'s', () => {
    const results = [
      { name: 'field (0.6.25)', ok: true, made: [a] },
      { name: 'field-work (0.6.25)', ok: true, made: [b] },
      { name: 'field (0.6.19)', ok: false, made: [c] },
      { name: 'field-work (0.6.19)', ok: false, made: [d] },
    ]
    expect(failureLogs(results, all)).toEqual([
      { name: 'field (0.6.19)', walnuts: [c] },
      { name: 'field-work (0.6.19)', walnuts: [d] },
    ])
  })

  it('a scenario that made none prints every walnut, once, and ends the list', () => {
    const results = [
      { name: 'install', ok: false, made: [a] },
      { name: 'update', ok: false, made: [] },
      { name: 'restart', ok: false },
    ]
    expect(failureLogs(results, all)).toEqual([
      { name: 'install', walnuts: [a] },
      { name: 'update', walnuts: all },
    ])
  })

  it('prints at most a few failures, and nothing when all passed', () => {
    const results = Array.from({ length: 6 }, (_, i) => ({ name: `s${i}`, ok: false, made: [w(`s${i}`)] }))
    expect(failureLogs(results, all)).toHaveLength(MAX_FAILURES_LOGGED)
    expect(failureLogs([{ name: 'ok', ok: true, made: [a] }], all)).toEqual([])
  })

  it('run.mjs records what each scenario made and prints through failureLogs alone', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/release-rehearsal/run.mjs'), 'utf8')
    const pushes = src.match(/results\.push\(\{[^}]*\}\)/g) ?? []
    expect(pushes.length).toBeGreaterThanOrEqual(2)
    for (const p of pushes) expect(p, p).toContain('made: walnuts.slice(mine)')
    expect(src).toMatch(/for \(const r of failureLogs\(results, walnuts\)\) \{\n {4}for \(const x of r\.walnuts\)/)
    // Only failureLogs decides whose tail is printed.
    expect(src.match(/\(tail, for /g)).toHaveLength(1)
  })
})
