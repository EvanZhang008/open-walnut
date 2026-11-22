/**
 * Static guards over the browser specs that drive the calendar (tests/e2e/browser/):
 * the ways a calendar spec aimed at the wrong place or the wrong side of the new-item
 * popover and failed for a reason unrelated to what it tests, kept out by reading the
 * spec sources. The other browser-spec guards are in browser-spec-ratchets.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

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


describe('a task made from the calendar\'s new-item popover', () => {
  // The popover opens on Event and keeps the side picked last (6974c18ae4). Two specs that
  // filled the task composer right after the slot click failed on every run from then on
  // (private-tasks, voice-field-commit, 2026-11-17), and six others carried their own copy of
  // the Task-tab click. calendar-helpers.ts pickCalendarTaskSide (and openCalendarTaskCreator,
  // the slot click with it) is the one way to the Task side.
  /** A test that opens the popover from the grid... */
  const OPENS = /\b(?:calendarEmptySlotPoint|calendarSlotPoint|columnPoint)\(|cal-allday-cell|cal-day-col/
  /** ...and works in the task composer... */
  const TASK_SIDE = /\.qtc-|quick-task-composer|'Task title'/
  /** ...goes there through the helper, or picks Event itself (a test of the switch's own fallback). */
  const PICKS = /\b(?:openCalendarTaskCreator|pickCalendarTaskSide)\(/
  const PICKS_EVENT = /cal-create-tabs[^\n]*Event|\btab\(\s*\w+\s*,\s*['"]Event['"]\s*\)\.click\(|getByRole\(\s*['"](?:tab|radio)['"]\s*,\s*\{\s*name:\s*['"]Event['"][^\n]*\.click\(/
  /** A hand-written click on the Task side (a segment of the Event | Task switch; a tab before 2026-11-21). */
  const HAND_CLICK = /(?:cal-create-tabs[^\n]*Task[^\n]*|\btab\(\s*\w+\s*,\s*['"]Task['"]\s*\)|getByRole\(\s*['"](?:tab|radio)['"]\s*,\s*\{\s*name:\s*['"]Task['"][^)]*\)\s*)\.click\(/

  /** The text of the function or closure defined on line `i`, to its closing brace at the same indent. */
  function bodyFrom(lines: string[], i: number): string {
    const indent = lines[i]!.match(/^\s*/)![0]
    const out = [lines[i]!]
    for (let j = i + 1; j < lines.length; j++) {
      out.push(lines[j]!)
      if (lines[j]!.startsWith(`${indent}}`)) break
    }
    return out.join('\n')
  }

  /** The tests of a spec that open the popover and use its task composer without the helper. */
  function offendersOf(text: string): string[] {
    const lines = text.split('\n')
    // A spec's own opener (quick-task-composer's openComposer) counts when it calls the helper.
    const wrappers = lines.flatMap((line, i) => {
      const m = line.match(/^\s*(?:export\s+)?(?:async\s+function\s+(\w+)|const\s+(\w+)\s*=\s*async\b)/)
      return m && PICKS.test(bodyFrom(lines, i)) ? [m[1] ?? m[2]!] : []
    })
    const picks = (body: string) => PICKS.test(body) || PICKS_EVENT.test(body) || wrappers.some((n) => new RegExp(`\\b${n}\\(`).test(body))
    const starts = lines.flatMap((line, i) => (/^\s*test(?:\.only|\.fixme)?\(/.test(line) ? [i] : []))
    return starts.flatMap((start, k) => {
      const body = lines.slice(start, starts[k + 1] ?? lines.length).join('\n')
      return OPENS.test(body) && TASK_SIDE.test(body) && !picks(body) ? [`${start + 1}: ${lines[start]!.trim().slice(0, 80)}`] : []
    })
  }

  it('every test that makes a task from the popover picks the Task side through the helper', () => {
    const makers = sources.filter(({ file, text }) => file !== 'calendar-helpers.ts' && (OPENS.test(text) || PICKS.test(text)) && TASK_SIDE.test(text))
    expect(makers.map(({ file }) => file)).toEqual(expect.arrayContaining(['private-tasks.spec.ts', 'voice-field-commit.spec.ts', 'quick-task-composer.spec.ts']))
    expect(makers.flatMap(({ file, text }) => offendersOf(text).map((o) => `${file}:${o}`))).toEqual([])
  })

  it('no spec clicks the Task tab by hand', () => {
    const offenders = sources.filter(({ file }) => file !== 'calendar-helpers.ts').flatMap(({ file, text }) => text.split('\n')
      .flatMap((line, i) => (HAND_CLICK.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])))
    expect(offenders).toEqual([])
  })

  it('catches the shapes it was written for, and lets the helper and a test of the switch through', () => {
    const slot = "  const slot = await calendarEmptySlotPoint(page, day)\n  await page.mouse.click(slot.x, slot.y)\n"
    // The two specs that failed: the composer read right after the slot click.
    expect(offendersOf(`test('quick add', async ({ page }) => {\n${slot}  await page.locator('.qtc-input').fill('x')\n})`)).toHaveLength(1)
    expect(offendersOf("test('quick add', async ({ page }) => {\n  await openCalendarTaskCreator(page, day)\n  await page.locator('.qtc-input').fill('x')\n})")).toEqual([])
    // A spec's own opener that calls the helper, used by its tests.
    const wrapped = `async function openComposer(page) {\n${slot}  await pickCalendarTaskSide(page)\n}\n\ntest('parse', async ({ page }) => {\n  await openComposer(page)\n  await page.locator('.cal-day-col').count()\n  await page.locator('.qtc-chip').first().click()\n})`
    expect(offendersOf(wrapped)).toEqual([])
    expect(offendersOf(wrapped.replace('  await pickCalendarTaskSide(page)\n', ''))).toHaveLength(1)
    // A test of the switch that picks Event and waits for the fallback to Task.
    expect(offendersOf(`test('fallback', async ({ page }) => {\n${slot}  await popover.locator('.cal-create-tabs [role="radio"]:has-text("Event")').click()\n  await expect(popover.locator('.quick-task-composer')).toBeVisible()\n})`)).toEqual([])
    for (const line of [
      "await page.locator('.cal-create-popover').getByRole('tab', { name: 'Task', exact: true }).click()",
      "await page.locator('.cal-create-popover').getByRole('radio', { name: 'Task', exact: true }).click()",
      "await creator.getByRole('tab', { name: 'Task', exact: true }).click();",
      "await tab(page, 'Task').click()",
      "await popover.locator('.cal-create-tabs button:has-text(\"Task\")').click()",
    ]) expect(HAND_CLICK.test(line), line).toBe(true)
    expect(HAND_CLICK.test("await expect(tab(page, 'Task')).toHaveAttribute('aria-checked', 'true')")).toBe(false)
    expect(HAND_CLICK.test("await expect(tabs.getByRole('radio', { name: 'Task', exact: true }), `${where}: kind`).toHaveAttribute('aria-checked', 'true')")).toBe(false)
  })
})
