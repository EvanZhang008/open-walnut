/**
 * Static guards over the browser specs (tests/e2e/browser/): mistakes that made
 * whole groups of specs fail on CI for a reason unrelated to what they test, kept
 * out by reading the spec sources.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { testMatchNames } from '../e2e/browser/side-config-specs'

const DIR = path.resolve(__dirname, '../e2e/browser')
const sources = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }))

describe('calendar time grid positions', () => {
  // The grid's hour height is `--cal-hour-px` (fitted to the window, zoomable), and it
  // starts at `data-start-minute`. A spec that moved the mouse or the scroll by a fixed
  // 48 px per hour clicked hours away from the time it meant (2026-10-31: eleven
  // quick-task-composer tests opened another event's popover). calendar-helpers.ts
  // reads the grid instead: calendarSlotPoint, calendarHourPx.
  const fixedHour = /\b48\b|\b96\b/
  const positional = /mouse\.|scrollTop|boundingBox|\.y \+|\.y\+/

  it('no spec that drives the time grid moves by a fixed 48 px hour', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (file === 'calendar-helpers.ts' || !/cal-day-col|cal-grid|cal-chip/.test(text)) continue
      text.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (fixedHour.test(line) && positional.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    const line = 'await page.mouse.click(box.x + box.width / 2, box.y + 14 * 48 + 12)'
    expect(fixedHour.test(line) && positional.test(line)).toBe(true)
  })
})

describe('a context menu heading', () => {
  // A menu's `info` rows are its title lines AND the name of a group further down (the
  // mail menu's "Walnut" group, 28df4326c). Specs that read every info row as the heading
  // counted three lines for two and read "Walnut" as the account (2026-10-31). The heading
  // is the info rows before the first item.
  const HEADING = '.wn-context-menu-info:not(.wn-context-menu-item ~ *)'
  // Reads the group's own name on purpose (its `.last()` is the "Walnut" row).
  const GROUP_NAME_READERS = new Set(['mail-ask-drawer.spec.ts'])

  it('every spec reads the heading block, not every info row', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      if (GROUP_NAME_READERS.has(file)) continue
      text.split('\n').forEach((line, i) => {
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) return
        const bare = line.replaceAll(HEADING, '')
        if (/\.wn-context-menu-info(?![-\w])/.test(bare)) offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('the project detail pane', () => {
  // A project header's name folds the project; the pane opens from its ··· menu,
  // "View project details". Three specs still clicked the name and waited 15 s for a
  // pane that never came (2026-10-31). openProjectDetails (todo-panel-helpers.ts)
  // is the way in; a spec may also take the menu item itself.
  it('every spec that reads the pane opens it from the menu', () => {
    const offenders = sources
      .filter(({ file, text }) => file !== 'todo-panel-helpers.ts' && text.includes('project-detail-pane'))
      .filter(({ text }) => !text.includes('openProjectDetails(') && !text.includes("'View project details'"))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})

describe('specs with their own config', () => {
  // A side config (replica, cloud host, host alone, ...) starts the fixtures its specs
  // need; under the main config they ran against the plain fixture and failed
  // (2026-10-31: 13 known failures). side-config-specs.ts reads each config's
  // testMatch, so the main config can leave them out.
  const configs = fs.readdirSync(DIR).filter((f) => f.endsWith('.config.ts'))

  it('every side config names its specs in a testMatch the main config can read', () => {
    for (const file of configs) {
      const names = testMatchNames(fs.readFileSync(path.join(DIR, file), 'utf8'))
      expect(names.length, `${file}: no readable testMatch`).toBeGreaterThan(0)
      for (const name of names) expect(fs.existsSync(path.join(DIR, name)), `${file} names ${name}`).toBe(true)
    }
  })

  it('every project of the main config leaves them out', () => {
    const main = fs.readFileSync(path.resolve(DIR, '../../../playwright.config.ts'), 'utf8')
    const ignores = [...main.matchAll(/testIgnore:\s*([^\n]+)/g)].map((m) => m[1]!)
    expect(ignores.length).toBeGreaterThan(0)
    for (const line of ignores) expect(line, 'a testIgnore without sideSpecs').toContain('sideSpecs')
  })
})

describe('dictation setup rows', () => {
  // The rows plan from the server's own scan (Homebrew, ffmpeg, whisper-server, uv):
  // a spec that reads them against the real scan judges the machine it runs on, and
  // on CI's Linux every row read "Install Homebrew first" (2026-10-31). Such a spec
  // routes /api/stt/detect, or is a manual real-install run that skips by default.
  it('every spec that reads a setup row fixes the scan it reads', () => {
    const offenders = sources
      .filter(({ text }) => /stt-setup-row|stt-setup-button/.test(text))
      .filter(({ text }) => !text.includes('api/stt/detect') && !/test\.skip\(!process\.env\./.test(text))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })
})
