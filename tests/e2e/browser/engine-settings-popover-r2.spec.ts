/**
 * Engine settings popover, review round two (chromium): the fixes for the
 * nitpicks and the failed checks, each pinned by the
 * measurement that found it. WebKit twins live in engine-settings-popover.webkit.spec.ts.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  HOST_LABEL, NEW_SOURCES, REPO, banner, claimUserFile, composerTextarea, fixtureRoot,
  makeGitProject, openPanels, openPopover, plusButton, popoverRow, popoverSources, readExclude, readLocal, rect,
  restoreSeed, rowControl, rowsArea, rowsGeometry, savedLine, savedProjectBase, scopeOption, shortCwd, shot, startSessionAt, stubPatch,
  waitForRows,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repoA = ''
let repoB = ''
let sidA = ''
let sidB = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  await claimUserFile(request)
  const root = await fixtureRoot()
  repoA = await makeGitProject(root, `r2-repo-a-${Date.now().toString(36)}`)
  repoB = await makeGitProject(root, `r2-repo-b-${Date.now().toString(36)}`)
  sidA = await startSessionAt(request, repoA)
  sidB = await startSessionAt(request, repoB)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const LINE = 17.4

/** Text fits its box: nothing hidden by overflow in either direction. */
const fits = (loc: Locator) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)

/** An element's box lies inside another's (a control the user can reach with the mouse). */
async function expectInside(inner: Locator, outer: Locator, label: string): Promise<void> {
  const i = await rect(inner)
  const o = await rect(outer)
  expect(i.left, `${label} left`).toBeGreaterThanOrEqual(o.left - 0.5)
  expect(i.right, `${label} right`).toBeLessThanOrEqual(o.right + 0.5)
  expect(i.top, `${label} top`).toBeGreaterThanOrEqual(o.top - 0.5)
  expect(i.bottom, `${label} bottom`).toBeLessThanOrEqual(o.bottom + 0.5)
}

const subtitleParts = (dialog: Locator) => dialog.locator('.engine-settings-popover-subtitle').evaluate((el) => {
  const head = el.querySelector<HTMLElement>('.engine-settings-subtitle-head')!
  const tail = el.querySelector<HTMLElement>('.engine-settings-subtitle-tail')!
  return {
    text: el.textContent, tail: tail.textContent, tailFits: tail.scrollWidth <= tail.clientWidth + 1,
    tailRight: tail.getBoundingClientRect().right, boxRight: el.getBoundingClientRect().right, headWidth: head.clientWidth,
  }
})

const activeDescription = (page: Page) => page.evaluate(() => {
  const a = document.activeElement
  if (!a || a === document.body) return 'body'
  return `${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[${a.getAttribute('role')}]` : ''}${a.classList.contains('engine-settings-popover') ? '.root' : ''}`
})

test.describe('engine settings popover: review round two', () => {
  test('rows get more than half the box, the repo segment always shows, About is a glyph after the switch', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const [panelA, panelB] = await openPanels(page, [sidA, sidB])
    let dialog = await openPopover(page, panelA)
    await waitForRows(dialog)

    // The box uses the room above the composer box (a one-line draft), rows > half of it, three rows fully visible.
    const d = await rect(dialog)
    const boxTop = (await rect(panelA.locator('.chat-input-box'))).top
    expect(Math.abs(d.height - Math.min(720, boxTop - 2 - 12))).toBeLessThanOrEqual(2)
    const geometry = await rowsGeometry(dialog)
    test.info().annotations.push({ type: 'measurement', description: `1280x800 dialog ${Math.round(d.height)}px, rows area ${geometry.area.height}px, fully visible rows ${geometry.visible}` })
    expect(geometry.area.height, JSON.stringify(geometry)).toBeGreaterThan(d.height / 2)
    expect(geometry.visible).toBeGreaterThanOrEqual(3)
    // No blank band under the switch: the notes block is its content plus at most a few px of reserve.
    const notes = dialog.locator('.engine-settings-popover-notes')
    const notesBox = await notes.evaluate((el) => {
      const kids = Array.from(el.children) as HTMLElement[]
      const lastBottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom))
      return { height: el.getBoundingClientRect().height, slack: el.getBoundingClientRect().bottom - lastBottom }
    })
    expect(notesBox.slack, JSON.stringify(notesBox)).toBeLessThanOrEqual(8)
    // The group help is not in the flow between the filter and the rows.
    await expect(dialog.locator('.engine-settings-group-help')).toHaveCount(0)
    // The footer's link and Files share one line.
    const linkBox = await rect(dialog.locator('a.engine-settings-more-link'))
    const summaryBox = await rect(dialog.getByTestId('engine-settings-files').locator('summary'))
    expect(Math.abs(linkBox.top - summaryBox.top)).toBeLessThanOrEqual(2)
    expect(linkBox.right).toBeLessThanOrEqual(summaryBox.left + 0.5)
    await shot(page, 'r3/dense-1280x800')

    // The subtitle's tail is the repo segment, fully visible, and differs between the two sessions.
    const partsA = await subtitleParts(dialog)
    expect(partsA.text).toBe(`${HOST_LABEL} · ${shortCwd(repoA)}`)
    expect(partsA.tail).toBe(path.basename(repoA))
    expect(partsA.tailFits, JSON.stringify(partsA)).toBe(true)
    expect(partsA.tailRight).toBeLessThanOrEqual(partsA.boxRight + 0.5)
    await page.keyboard.press('Escape')
    dialog = await openPopover(page, panelB)
    await waitForRows(dialog)
    const partsB = await subtitleParts(dialog)
    expect(partsB.tail).toBe(path.basename(repoB))
    expect(partsB.tailFits).toBe(true)
    expect(partsB.text).not.toBe(partsA.text)
    await page.keyboard.press('Escape')

    // About is a labelled glyph in the header corner; the switch is the first Tab stop.
    // About sits LAST with Close (Shift+Tab from the switch wraps to Close, then About), not between the switch and the filter.
    dialog = await openPopover(page, panelA)
    await waitForRows(dialog)
    const about = dialog.locator('button.engine-settings-about')
    await expect(about).toHaveAttribute('aria-label', 'About these settings')
    await expect(about.locator('svg')).toHaveCount(1)
    const aboutBox = await rect(about)
    const closeBox = await rect(dialog.locator('button.engine-settings-popover-close'))
    expect(Math.abs(aboutBox.top - closeBox.top)).toBeLessThanOrEqual(1)
    expect(aboutBox.right).toBeLessThanOrEqual(closeBox.left + 0.5)
    await dialog.focus()
    await page.keyboard.press('Tab')
    expect(await activeDescription(page)).toBe('button[radio]')
    await page.keyboard.press('Tab')
    expect(await activeDescription(page)).toBe('input')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('engine-settings-popover-close')
    await page.keyboard.press('Shift+Tab')
    expect(await activeDescription(page)).toBe('button')
    expect(await page.evaluate(() => document.activeElement?.className)).toBe('engine-settings-about')
    // The panel opens with the scope line first, then the group help, then the engine's note.
    await page.keyboard.press('Enter')
    const panel = dialog.locator('.engine-settings-about-panel')
    await expect(panel).toBeVisible()
    const order = await panel.evaluate((el) => Array.from(el.children).map((c) => c.className))
    expect(order.slice(0, 3)).toEqual(['engine-settings-about-scope', 'engine-settings-group-help', 'engine-settings-about-body'])
    // The overlay covers the switch; close it, switch, reopen: the first line follows the switch.
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await about.click()
    await expect(dialog.getByTestId('engine-settings-about-scope'))
      .toHaveText(`With the switch on "This project only", every save from here goes to ${shortCwd(repoA)}/.claude/settings.local.json.`)
    await shot(page, 'r3/about-project')
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('the saved sentence is readable inside the box, a default-scope project write says so, an error wraps with Dismiss in reach', async ({ page, request }) => {
    const home = await fixtureHome(request)
    await page.setViewportSize({ width: 1280, height: 800 })
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const rowsBefore = await rect(rowsArea(dialog))

    // Under "Same as Claude Code", a key the engine files per project creates the local file;
    // the footer says so, git answer included (the file did not exist before).
    expect(await readLocal(repoA)).toBeNull()
    await rowControl(dialog, 'claude', 'outputStyle').selectOption('Learning')
    await expect.poll(async () => (await readLocal(repoA))?.outputStyle).toBe('Learning')
    const created = `${shortCwd(repoA)}/.claude/settings.local.json`
    await expect(savedLine(dialog)).toHaveText(`${savedProjectBase(repoA)} Created ${created} and kept it out of git (this repo's exclude list).`)
    expect(await readExclude(repoA)).toContain('.claude/settings.local.json')
    // The sentence sits inside the popover, wrapped, nothing cut at the edge; the rows' top did not move.
    const line = savedLine(dialog)
    const lineBox = await rect(line)
    const dialogBox = await rect(dialog)
    expect(lineBox.right).toBeLessThanOrEqual(dialogBox.right - 8)
    expect(lineBox.left).toBeGreaterThanOrEqual(dialogBox.left + 8)
    expect(lineBox.height).toBeLessThanOrEqual(3 * LINE + 1)
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect((await rect(rowsArea(dialog))).top).toBeCloseTo(rowsBefore.top, 0)
    // The whole sentence is on screen, or a VISIBLE More control unfolds it.
    const clipped = await line.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
    const more = dialog.getByTestId('engine-settings-status-more')
    test.info().annotations.push({ type: 'observation', description: `saved sentence ${Math.round(lineBox.height)}px tall, clipped=${clipped}` })
    if (clipped) {
      await expect(more).toBeVisible()
      await expectInside(more, dialog, 'More')
      await more.click()
      expect(await fits(line)).toBe(true)
    } else {
      await expect(more).toHaveCount(0)
      expect(await fits(line)).toBe(true)
    }
    // The visible text reaches the git answer (the last words are on screen, not behind an ellipsis).
    const lastWordVisible = await line.evaluate((el) => {
      const range = document.createRange()
      const text = el.firstChild as Text
      range.setStart(text, text.length - 6); range.setEnd(text, text.length)
      const r = range.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return r.bottom <= box.bottom + 0.5 && r.right <= box.right + 0.5
    })
    expect(lastWordVisible).toBe(true)
    await shot(page, 'r3/saved-project-default-scope')
    // Reset through the UI leaves the seed for the next tests; the removed sentence also fits.
    await dialog.getByTestId('engine-setting-reset-outputStyle').click()
    await expect(savedLine(dialog)).toHaveText(/^Removed Output style from this project \(local\); the user settings value applies again\.$/)
    expect(await fits(savedLine(dialog))).toBe(true)
    await expect.poll(async () => (await readLocal(repoA))?.outputStyle).toBeUndefined()
    expect((await readClaudeSettings(home)).outputStyle).toBe('Explanatory')

    // A long server sentence wraps in full and Dismiss stays inside the popover, reachable by a real click.
    const long = 'The daemon on this Mac did not answer within 10 seconds; the file may or may not have been written.'
    const down = await stubPatch(page, { status: 502, body: { error: long, outcome: 'unknown' } }, { times: 1 })
    await rowControl(dialog, 'claude', 'alwaysThinkingEnabled').click()
    const alert = banner(dialog)
    await expect(alert).toHaveText(long)
    expect(await fits(alert.locator('span'))).toBe(true)
    expect((await rect(alert)).right).toBeLessThanOrEqual((await rect(dialog)).right - 8)
    const dismiss = alert.locator('button[aria-label="Dismiss"]')
    await expectInside(dismiss, dialog, 'Dismiss')
    await shot(page, 'r3/save-failed-502')
    await dismiss.click()
    await expect(alert).toHaveCount(0)
    await down.unroute()
    await expect(rowControl(dialog, 'claude', 'alwaysThinkingEnabled')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
  })

  test('Escape from a clean input closes, the guard sits under the switch, focus returns to the toggle, a switch keeps the scroll offset, a Reset never flashes Default', async ({ page, request }) => {
    const home = await fixtureHome(request)
    await page.setViewportSize({ width: 1280, height: 800 })
    const [panel] = await openPanels(page, [sidA])
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)

    // A draft's Escape only discards; the next Escape, with the clean input still focused, closes.
    const language = rowControl(dialog, 'claude', 'language')
    await language.scrollIntoViewIfNeeded()
    await language.fill('zz-draft')
    await language.press('Escape')
    await expect(language).toHaveValue('Chinese')
    await expect(dialog).toBeVisible()
    await expect(language).toBeFocused()
    await language.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(plusButton(panel)).toBeFocused()
    expect((await readClaudeSettings(home)).language).toBe('Chinese')

    // The draft guard appears right under the switch, in place of the scope sentence, and goes away by itself.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await rowControl(dialog, 'claude', 'language').scrollIntoViewIfNeeded()
    await rowControl(dialog, 'claude', 'language').fill('zz-draft')
    const switchBox = await rect(dialog.locator('.engine-settings-scope[role=radiogroup]'))
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    const guard = dialog.locator('.engine-settings-draft-guard')
    await expect(guard).toHaveText('Press Enter to save the value first, or Escape to discard.')
    const guardBox = await rect(guard)
    expect(guardBox.top - switchBox.bottom, 'guard right under the switch').toBeLessThanOrEqual(40)
    expect(guardBox.top).toBeGreaterThanOrEqual(switchBox.bottom - 1)
    // The note dims under the guard instead of vanishing (no blank band), and comes back with it.
    expect(Number(await dialog.getByTestId('engine-settings-scope-note').evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(0.5)
    await shot(page, 'r3/draft-guard')
    await expect(guard).toHaveCount(0, { timeout: 5000 })
    expect(Number(await dialog.getByTestId('engine-settings-scope-note').evaluate((el) => getComputedStyle(el).opacity))).toBe(1)
    await rowControl(dialog, 'claude', 'language').press('Escape')
    await expect(rowControl(dialog, 'claude', 'language')).toHaveValue('Chinese')

    // After a mouse toggle lands, focus is on that toggle (never the dialog root).
    const thinking = () => rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
    await thinking().scrollIntoViewIfNeeded()
    await thinking().click()
    await expect(savedLine(dialog)).toHaveText(/^Saved to user settings/)
    await expect.poll(() => activeDescription(page)).toBe('button[switch]')
    await thinking().click()
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(true)
    await expect.poll(() => activeDescription(page)).toBe('button[switch]')

    // Scroll so a row starts 80px above the fold, switch scope: the same row keeps its offset inside the scroller.
    const rows = rowsArea(dialog)
    const verbose = popoverRow(dialog, 'verbose')
    await rows.evaluate((area, key) => {
      const row = area.querySelector<HTMLElement>(`.engine-settings-popover-row[data-key="${key}"]`)!
      area.scrollTop = row.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop + 80
    }, 'verbose')
    const offset = async () => (await rect(verbose)).top - (await rect(rows)).top
    expect(Math.round(await offset())).toBe(-80)
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await expect(rows).not.toHaveAttribute('aria-busy', 'true')
    await expect.poll(async () => Math.round(await offset())).toBe(-80)
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await expect(rows).not.toHaveAttribute('aria-busy', 'true')
    await expect.poll(async () => Math.round(await offset())).toBe(-80)

    // A project-scope Reset of a key the user file also holds never reads "Default" while in flight.
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await waitForRows(dialog)
    const style = () => rowControl(dialog, 'claude', 'outputStyle')
    await style().scrollIntoViewIfNeeded()
    await style().selectOption('Learning')
    const status = popoverRow(dialog, 'outputStyle').locator('.engine-setting-status')
    await expect(status).toHaveText('Set in this project (local)')
    await expect.poll(async () => (await readLocal(repoA))?.outputStyle).toBe('Learning')
    const slow = await stubPatch(page, 'real', { scope: 'project', delayMs: 1200, times: 1 })
    const seen: string[] = []
    const sampler = setInterval(() => { status.textContent().then((t) => { if (t) seen.push(t) }).catch(() => {}) }, 40)
    await dialog.getByTestId('engine-setting-reset-outputStyle').click()
    await expect(status).toHaveText('Set in user settings', { timeout: 10_000 })
    clearInterval(sampler)
    await slow.unroute()
    expect(seen.length).toBeGreaterThan(3)
    expect(seen).not.toContain('Default')
    expect(new Set(seen)).toEqual(new Set(['Set in this project (local)', 'Set in user settings'].filter((t) => seen.includes(t))))
    await expect(savedLine(dialog)).toHaveText('Removed Output style from this project (local); the user settings value applies again.')
    await expect(style()).toHaveValue('Explanatory')
    await page.keyboard.press('Escape')
  })

  test(' tall draft: a composer grown past two lines no longer squeezes the popover; the bottom sits on the "+" row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const [panel] = await openPanels(page, [sidA])
    const box = panel.locator('.chat-input-box')
    const shortBox = await rect(box)
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const shortHeight = (await rect(dialog)).height
    expect((await rect(dialog)).bottom).toBeLessThanOrEqual(shortBox.top + 0.5)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    // Eight lines of draft: the composer box grows well past 120px.
    await composerTextarea(panel).fill(Array.from({ length: 8 }, (_, i) => `draft line ${i + 1}`).join('\n'))
    await expect.poll(async () => (await rect(box)).height).toBeGreaterThan(120)
    const tallBox = await rect(box)
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const d = await rect(dialog)
    const plus = await rect(plusButton(panel))
    test.info().annotations.push({ type: 'measurement', description: `composer box ${Math.round(tallBox.height)}px: popover ${Math.round(d.height)}px (was ${Math.round(shortHeight)}px with a one-line draft)` })
    expect(d.bottom).toBeLessThanOrEqual(plus.top + 0.5)
    expect(d.bottom).toBeGreaterThan(tallBox.top + 20)
    expect(d.height).toBeGreaterThanOrEqual(shortHeight - 1)
    const geometry = await rowsGeometry(dialog)
    expect(geometry.area.height, JSON.stringify(geometry)).toBeGreaterThan(d.height / 2)
    await shot(page, 'r3/tall-draft')
    await page.keyboard.press('Escape')
    await composerTextarea(panel).fill('')
  })

  test('every file this slice added or touched is under 500 lines, English, dash-free, and logs through @/utils/log', async () => {
    const specs = (await fs.readdir('tests/e2e/browser')).filter((f) => /engine-settings-popover/.test(f)).map((f) => path.join('tests/e2e/browser', f))
    const sources = [...NEW_SOURCES.map((f) => path.join(REPO, f)), ...(await popoverSources()), ...specs]
    expect(sources.length).toBeGreaterThan(8)
    for (const file of sources) {
      const text = await fs.readFile(file, 'utf-8')
      const lines = text.split('\n').length
      expect(lines, `${file} is ${lines} lines`).toBeLessThan(500)
      expect(/[\u2013\u2014]/.test(text), `${file} has an en or em dash`).toBe(false)
      const rawConsole = ['console', 'log'].join('.')
      expect(text.includes(rawConsole), `${file} uses ${rawConsole}`).toBe(false)
      if (/^web\/src\/.*\.tsx?$/.test(file) && /log\.(info|warn|error)\(/.test(text)) {
        expect(text, `${file} imports the structured logger`).toContain("from '@/utils/log'")
      }
    }
  })
})
