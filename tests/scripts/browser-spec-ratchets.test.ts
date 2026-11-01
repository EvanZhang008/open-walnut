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

describe('specs that pin WebKit', () => {
  // The chromium project's device (Desktop Chrome) sets a Chrome user agent, and a
  // file's `test.use({ browserName: 'webkit' })` keeps it, so WebKit ran saying it was
  // Chrome: every check of the engine by its user agent failed, and the page saw a
  // browser it was not (2026-10-31: the mail .webkit specs, "this file must really be
  // webkit"). Each pin sets Safari's user agent; `userAgent: undefined` does not
  // clear the project's (Playwright reads it as unset).
  const pins = sources.flatMap(({ file, text }) =>
    [...text.matchAll(/test\.use\(\{([^}]*browserName:\s*'webkit'[^}]*)\}/g)].map((m) => ({ file, body: m[1]! })))

  it('every one also drops the project\'s user agent', () => {
    expect(pins.length).toBeGreaterThan(30)
    expect(pins.filter((p) => !p.body.includes("userAgent: devices['Desktop Safari'].userAgent")).map((p) => p.file)).toEqual([])
  })
})

describe('specs that import Vite\'s optimized deps', () => {
  // A dep URL carries Vite's browser hash (`?v=`), and Vite optimizes its deps again when
  // the app's first load finds one it had not bundled: a hash read from a source file
  // (`fetch('/src/main.tsx')`) is then older than the page's, and Vite answers it with
  // 504 Outdated Optimize Dep (2026-11-01: all 17 settings-primitives tests failed that
  // way in CI, on five runs). Take the URL the page loaded (performance resource entries).
  const readsHashFromSource = (text: string) => /\.vite\/deps\//.test(text) && /fetch\(\s*['"`]\/src\//.test(text)

  it('no spec builds a dep URL from a hash it read out of a source file', () => {
    expect(sources.filter(({ text }) => readsHashFromSource(text)).map(({ file }) => file)).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(readsHashFromSource("const src = await (await fetch('/src/main.tsx')).text()\nimport('/node_modules/.vite/deps/react.js?v=' + v)")).toBe(true)
    expect(readsHashFromSource("performance.getEntriesByType('resource')\n.startsWith('/node_modules/.vite/deps/' + file)")).toBe(false)
  })
})

describe('calendar columns of another day', () => {
  // The week grid draws only the shown week, so a fixed offset from today (tomorrow, two
  // days on) has no column near a week's end: 2026-11-01 was a Sunday, and the quick-create
  // test's tomorrow was next week's on all five CI runs that day. Pick a day the grid shows
  // (its `.cal-day-col` data-day values), as the late-night slot test does.
  const fixedDayColumn = /localDay\(\s*-?[1-9]\d*\s*\)[\s\S]{0,300}?\b(?:columnPoint|calendarSlotPoint)\(/g

  it('no spec aims a time-grid point at a fixed offset from today', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      [...text.matchAll(fixedDayColumn)].map((m) => `${file}:${text.slice(0, m.index).split('\n').length}`))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for, and lets today and a shown day through', () => {
    expect('const day = localDay(1)\n    const point = await columnPoint(page, day, 11)'.match(fixedDayColumn)).toHaveLength(1)
    expect('const point = await columnPoint(page, localDay(0), 22)'.match(fixedDayColumn)).toBeNull()
    expect("const day = days.find((d) => d !== localDay(0))\nconst point = await columnPoint(page, day, 11)".match(fixedDayColumn)).toBeNull()
  })
})

describe('clipboard permissions', () => {
  // WebKit knows neither `clipboard-read` nor `clipboard-write`: `grantPermissions` throws
  // "Unknown permission: clipboard-write" and the case fails before it tests anything (2026-11-01:
  // two mail specs and the task id chip, in every PW_WEBKIT=1 run). A grant is made for Chromium
  // only (`browserName === 'chromium'`, or the project's name, within the three lines above it),
  // or swallows the refusal; mail-review-helpers.ts `clipboardReader` does the first and records
  // the write on WebKit.
  const grant = /grantPermissions\([^)]*clipboard-/

  it('every clipboard grant is made for Chromium only', () => {
    const offenders: string[] = []
    for (const { file, text } of sources) {
      const lines = text.split('\n')
      lines.forEach((line, i) => {
        if (!grant.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) return
        if (line.includes('.catch(')) return
        if (lines.slice(Math.max(0, i - 3), i + 1).some((one) => one.includes("=== 'chromium'"))) return
        offenders.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect(grant.test("await context.grantPermissions(['clipboard-read', 'clipboard-write'])")).toBe(true)
  })
})
describe('specs that open a gated Settings pane', () => {
  // A core Settings pane with `requires` (core-settings-registry.tsx) has no nav entry
  // while its server fact is false, and the macOS Access pane's (`macAccess`) is false
  // on every Linux runner: permissions-session-access clicked an entry that was never
  // drawn and timed out on all of CI's runs (2026-11-01). A spec that opens such a pane
  // sets the fact itself, as that spec stubs the rest of a Mac.
  const FACT_OF_GATE: Record<string, string> = { 'mac-access': 'macAccess' }
  const registry = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/settings/core-settings-registry.tsx'), 'utf8')
  const gated = [...registry.matchAll(/\bid: '([\w-]+)'[^{}]*?\brequires: '([\w-]+)'/g)].map((m) => ({ id: m[1]!, gate: m[2]! }))

  it('knows every gate a pane names', () => {
    expect(gated.map((g) => g.id)).toContain('permissions')
    for (const g of gated) expect(FACT_OF_GATE[g.gate], `gate ${g.gate} of pane ${g.id}: add its server fact here`).toBeDefined()
  })

  it('every spec that clicks a gated pane\'s nav entry sets its fact', () => {
    const offenders = gated.flatMap((g) => sources
      .filter(({ text }) => text.includes(`settings-nav-${g.id}'`) && !new RegExp(`\\b${FACT_OF_GATE[g.gate]}: true`).test(text))
      .map(({ file }) => `${file}: opens ${g.id} without ${FACT_OF_GATE[g.gate]}: true`))
    expect(offenders).toEqual([])
  })
})

describe('path list rows of a real system directory', () => {
  // The root's listing is the machine's own, so a row matched by a plain substring of a
  // system directory's name also matches its siblings there: on Ubuntu 24.04 'usr' matched
  // /bin.usr-is-merged and two more, and two path selector tests failed in strict mode on
  // every CI run (2026-11-01). Match the name as a path segment (a regex).
  const SYSTEM_DIR_ROW = /\.sps-path-item[^)]*hasText: '(?:usr|bin|sbin|lib|etc|var|tmp|opt|home)'/g

  it('no spec matches one by a plain substring', () => {
    const offenders = sources.flatMap(({ file, text }) =>
      [...text.matchAll(SYSTEM_DIR_ROW)].map((m) => `${file}:${text.slice(0, m.index).split('\n').length}`))
    expect(offenders).toEqual([])
  })

  it('catches the shape it was written for', () => {
    expect("list(page).locator('.sps-path-item.sps-live', { hasText: 'usr' })".match(SYSTEM_DIR_ROW)).toHaveLength(1)
    expect("list(page).locator('.sps-path-item.sps-live', { hasText: USR_DIR })".match(SYSTEM_DIR_ROW)).toBeNull()
  })
})
