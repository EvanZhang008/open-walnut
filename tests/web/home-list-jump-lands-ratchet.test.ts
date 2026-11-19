/**
 * A jump to a row in the Home task list lands on it with landOnRow (web/src/utils/scroll-land.ts),
 * never with a smooth scroll alone.
 *
 * The list's boxes keep the row being read in place by hand (web/src/hooks/useScrollAnchor.ts): when
 * a row lands above while a smooth scroll runs, the anchor's correction is a scrollTop write, which
 * ends the smooth scroll partway. 2026-11-18, CI: the Limited summary's count stopped its rows 150 to
 * 305px down the list on a busy shared server, and alone on clouddev once rows were made to land
 * above during the jump (at 522px). The count now lands with landOnRow and holds the row while its
 * rows are marked.
 *
 * Ratchet: the smooth scrolls still left in the list's components, per file, counted by their
 * literal `behavior: 'smooth'`. A new one fails; land it with landOnRow instead (or, for a reveal by
 * a few pixels, say why here). Counts only fall.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '../../web/src/components/tasks')

const LEFT: Record<string, number> = {
  // revealBelowHeadings (three branches of one nearby reveal) and the Limited count's fallback to its
  // section heading, which sticks, when none of its rows is drawn.
  'TodoPanel.tsx': 4,
  // The phone's reveal of a need-you child row after an expand.
  'PhoneRowExtras.tsx': 1,
  // The phone's queued-updates pill, back to the very top.
  'PhoneQueuedUpdatesPill.tsx': 1,
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : []
  })
}

const smooth = (code: string) => (code.match(/behavior:\s*['"]smooth['"]/g) ?? []).length

describe('a jump to a row in the Home list lands on it', () => {
  it('the Limited summary\'s count lands its first row with landOnRow', () => {
    const code = fs.readFileSync(path.join(DIR, 'TodoPanel.tsx'), 'utf8')
    const at = code.indexOf('const showLimitedSection')
    const end = code.indexOf('}, [openStatusSection]);', at)
    expect(at, 'showLimitedSection is in TodoPanel.tsx').toBeGreaterThan(0)
    expect(end, 'showLimitedSection ends with its dependency list').toBeGreaterThan(at)
    expect(code.slice(at, end)).toMatch(/\blandOnRow\(first,/)
  })

  it('no smooth scroll is added to the list\'s components, and the ones left only go', () => {
    const counts = Object.fromEntries(files(DIR).map((f) => [path.relative(DIR, f), smooth(fs.readFileSync(f, 'utf8'))] as const).filter(([, n]) => n > 0))
    expect(counts, 'land the jump with landOnRow (web/src/utils/scroll-land.ts); when one goes, lower its count here').toEqual(LEFT)
  })
})
