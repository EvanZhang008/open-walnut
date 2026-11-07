/**
 * The Display menu holds more than one note (`.dm-note`): the order notes under Sort
 * and Group ("Lists in this view differ", "2 projects use their own order") and, in
 * the views with the layout Group row, "Group: Flat and In one list are experimental"
 * below every row (d7715e5b1, 2026-11-07). A spec that reads `.dm-note` unscoped
 * matched both and failed in strict mode on CI (display-order-every-view). Every spec
 * names the note it means: `.dm-order .dm-note` for an order note, or the
 * experimental note's own `[data-view-option="experimental-note"]`.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(import.meta.dirname, '../e2e/browser')

function specFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return specFiles(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}

describe('Display menu notes in browser specs', () => {
  it('no spec reads `.dm-note` unscoped', () => {
    const files = specFiles(DIR)
    expect(files.length).toBeGreaterThan(50)
    const hits: string[] = []
    for (const file of files) {
      fs.readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        if (/locator\(\s*['"`]\.dm-note['"`]\s*\)/.test(line)) hits.push(`${path.relative(DIR, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits, 'scope the note: `.dm-order .dm-note` or [data-view-option="experimental-note"]').toEqual([])
  })
})
