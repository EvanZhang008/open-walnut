/**
 * A row's "running" pulse for a call still out stops when the turn is over.
 * Stream blocks are never finalized at a turn end (only a tool result flips a
 * call), so a call that was out when the CLI died or the turn was cut stays
 * `calling` in the buffer, and a row asking `streamRunHasCallingTool` alone kept
 * pulsing in an idle session, then lost the dot when history took it over
 * (2026-11-02: streaming and finished must look exactly the same). The saved
 * rows gate on `isStreaming`; every live caller must too. Enumerated from the
 * source, so a new caller fails here until it is gated.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../../../web/src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.tsx?$/.test(name) ? [p] : []
  })
}

describe('live running pulse', () => {
  it('every streamRunHasCallingTool call is gated on isStreaming', () => {
    const ungated: string[] = []
    let calls = 0
    for (const file of sources(ROOT)) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        for (const m of line.matchAll(/streamRunHasCallingTool\(/g)) {
          const before = line.slice(0, m.index)
          // The definition and the import are not calls.
          if (/export function\s*$/.test(before) || /^import\b/.test(line)) continue
          calls++
          if (!/isStreaming && $/.test(before)) ungated.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
        }
      })
    }
    expect(calls).toBeGreaterThan(0)
    expect(ungated).toEqual([])
  })
})
