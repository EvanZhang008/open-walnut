/**
 * Composer "+" -> "Engine settings" popover: review round three, the rows and
 * the keyboard (chromium). Each test would have failed before its fix:
 * "Does not change this session." sits inside the row card, right after the status line
 * a save longer than 300ms shows a "Saving…" cue in the card; a fast one never flashes it
 * when the footer grows (a failed save's banner) the row just edited stays fully visible
 * once the project file holds the value, the "Saves to" line is not repeated under "Set in"
 * one Tab stop for the switch (the checked side), arrows move; About sits with Close, last
 * a remembered project scope is asked for on the first request, one round trip
 * a save landed after a mouse action moves focus without drawing a ring
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  banner, claimUserFile, filterBox, fixtureRoot, makeGitProject, openPanels, openPopover, popoverRow, popoverRowWrap, readLocal, rect,
  restoreSeed, rowControl, rowsArea, savedLine, scopeOption, shot, startSessionAt, stubGet, stubPatch, waitForRows, watchSettingsRequests,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repo = ''
let sid = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  await claimUserFile(request)
  repo = await makeGitProject(await fixtureRoot())
  sid = await startSessionAt(request, repo)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const opacity = (loc: Locator) => loc.evaluate((el) => Number(getComputedStyle(el).opacity))
const activeClass = (page: Page) => page.evaluate(() => document.activeElement?.className ?? '')
/** The control is wholly inside the rows area's visible box. */
async function expectInsideRowsArea(dialog: Locator, control: Locator, label: string) {
  const area = await rect(rowsArea(dialog))
  const box = await rect(control)
  expect(box.top, `${label} top`).toBeGreaterThanOrEqual(area.top - 0.5)
  expect(box.bottom, `${label} bottom`).toBeLessThanOrEqual(area.bottom + 0.5)
}

test.describe('engine settings popover: round three, rows and keyboard', () => {
  test('the not-honoured sentence lives in the card; a slow save says Saving, a fast one does not', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const [panel] = await openPanels(page, [sid])
    const marked = await stubGet(page, (real) => ({
      ...real,
      groups: real.groups.map((g) => ({ ...g, items: g.items.map((i) => (i.key === 'permissions.defaultMode' ? { ...i, honoredHere: false } : i)) })),
    }), { scope: 'default', times: 1 })
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const card = popoverRow(dialog, 'permissions.defaultMode')
    await card.scrollIntoViewIfNeeded()
    const sentence = card.locator('.engine-setting-not-honored')
    await expect(sentence).toHaveText('Does not change this session.')
    // Inside the card (the card's own box contains it), right under the help
    // line (the status line before it is hidden at rest), in its 11px muted type.
    const cardBox = await rect(card)
    const sentenceBox = await rect(sentence)
    const helpBox = await rect(card.locator('.engine-setting-help'))
    expect(sentenceBox.bottom).toBeLessThanOrEqual(cardBox.bottom + 0.5)
    expect(sentenceBox.top).toBeGreaterThanOrEqual(helpBox.bottom - 1)
    expect(sentenceBox.top - helpBox.bottom).toBeLessThanOrEqual(6)
    expect(await sentence.evaluate((el) => el.previousElementSibling?.className)).toBe('engine-setting-status')
    expect(await sentence.evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px')
    // Nothing of it outside the card any more.
    await expect(popoverRowWrap(dialog, 'permissions.defaultMode').locator(':scope > .engine-setting-not-honored')).toHaveCount(0)
    await shot(page, 'r4/not-honored-in-card')
    await marked.unroute()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // A held PATCH shows the cue after 300ms, inside the card; it is gone when the save lands.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const thinking = () => rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
    await expect(thinking()).toHaveAttribute('aria-checked', 'true')
    const slow = await stubPatch(page, 'real', { delayMs: 1500, times: 1 })
    await thinking().click()
    const cue = dialog.getByTestId('engine-setting-saving-alwaysThinkingEnabled')
    await expect(cue).toHaveCount(1)
    await expect(cue).toHaveText('Saving…')
    // Hidden for the first 300ms (a fast save never flashes it), then shown.
    expect(await cue.evaluate((el) => getComputedStyle(el).animationDelay)).toBe('0.3s')
    await expect.poll(() => opacity(cue), { timeout: 2000 }).toBe(1)
    const cueBox = await rect(cue)
    const cardBox2 = await rect(popoverRow(dialog, 'alwaysThinkingEnabled'))
    expect(cueBox.top).toBeGreaterThanOrEqual(cardBox2.top)
    expect(cueBox.bottom).toBeLessThanOrEqual(cardBox2.bottom + 0.5)
    await shot(page, 'r4/saving-cue')
    await expect(savedLine(dialog)).toHaveText(/^Saved to user settings/, { timeout: 10_000 })
    await expect(cue).toHaveCount(0)
    await slow.unroute()
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(false)
    // A real, fast toggle back: the cue is in the DOM only while saving and never reaches opacity 1.
    await thinking().click()
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(true)
    await expect(cue).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('a failed text save grows the footer, and the input that failed stays fully visible', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const language = rowControl(dialog, 'claude', 'language')
    // The Language row at the very bottom of the visible rows, as the report had it.
    await popoverRowWrap(dialog, 'language').evaluate((el) => el.scrollIntoView({ block: 'end' }))
    await expectInsideRowsArea(dialog, language, 'language before')
    const areaBefore = await rect(rowsArea(dialog))
    const refused = await stubPatch(page, {
      status: 400,
      body: {
        error: 'settings.json was changed by another process since it was read; reopen this popover to see the current values, then make the change again. Nothing was written.',
        outcome: 'not-written',
      },
    }, { times: 1 })
    await language.fill('zh')
    await language.press('Enter')
    await expect(banner(dialog)).toContainText('settings.json was changed by another process')
    await expect(language).toHaveValue('Chinese')
    // The footer grew (the rows area lost height) and the row the user acted on was brought back into view.
    const areaAfter = await rect(rowsArea(dialog))
    expect(areaAfter.height).toBeLessThan(areaBefore.height - 10)
    await expect.poll(async () => {
      const area = await rect(rowsArea(dialog))
      const box = await rect(language)
      return box.bottom <= area.bottom + 0.5 && box.top >= area.top - 0.5
    }, { timeout: 3000 }).toBe(true)
    await expectInsideRowsArea(dialog, language, 'language after the banner')
    await shot(page, 'r4/failed-save-input-visible')
    await refused.unroute()
    await dialog.getByTestId('engine-settings-banner').locator('button[aria-label="Dismiss"]').click()
    await expect(banner(dialog)).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('no repeated file line, a ringless focus after a mouse save, one request on reopen', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const seen = watchSettingsRequests(page)
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    const verboseRow = popoverRow(dialog, 'verbose')
    await expect(verboseRow.locator('.engine-setting-target')).toHaveText('Saves to this project (local)')
    const verbose = rowControl(dialog, 'claude', 'verbose')
    await verbose.click()
    await expect(savedLine(dialog)).toHaveText(/^Saved to this project \(local\)/)
    await expect.poll(async () => (await readLocal(repo))?.verbose).toBe(true)
    // The status line names the project file; the "Saves to" line for the same file is not shown.
    await expect(verboseRow.locator('.engine-setting-status')).toHaveText('Set in this project (local)')
    await expect(verboseRow.locator('.engine-setting-target')).toBeHidden()
    await expect(popoverRowWrap(dialog, 'verbose')).toHaveAttribute('data-target-is-source', 'true')
    // A row the project file does not hold still says where a save goes.
    await expect(popoverRow(dialog, 'fastMode').locator('.engine-setting-target')).toHaveText('Saves to this project (local)')
    // The save was mouse-driven; focus moved to the toggle without a visible ring.
    await expect(verbose).toBeFocused()
    expect(await activeClass(page)).toContain('engine-setting-quiet-focus')
    expect(await verbose.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
    await shot(page, 'r4/quiet-focus-after-mouse-save')
    // The first key restores the ring: the class goes, and Tab moves on as usual.
    await page.keyboard.press('Tab')
    await expect(verbose).not.toHaveClass(/engine-setting-quiet-focus/)
    // Reset through the mouse: same silence.
    await dialog.getByTestId('engine-setting-reset-verbose').click()
    await expect(savedLine(dialog)).toHaveText(/^Removed Verbose output from this project \(local\)/)
    await expect.poll(async () => (await readLocal(repo))?.verbose).toBeUndefined()
    await expect(verbose).toBeFocused()
    expect(await activeClass(page)).toContain('engine-setting-quiet-focus')
    await expect(verboseRow.locator('.engine-setting-target')).toHaveText('Saves to this project (local)')
    await dialog.locator('button.engine-settings-popover-close').click()
    await expect(dialog).toHaveCount(0)

    // The remembered project scope rides on the first (and only) GET.
    const mark = seen.length
    dialog = await openPopover(page, panel)
    await expect(dialog).toHaveAttribute('data-scope', 'project')
    await waitForRows(dialog)
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    const gets = seen.slice(mark).filter((r) => r.startsWith('GET')).map((r) => new URL(r.slice(4)).searchParams.get('scope'))
    expect(gets).toEqual(['project'])
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
  })

  test('one Tab stop for the switch, arrows move between the sides, About sits last with Close', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const def = scopeOption(dialog, 'default')
    const project = scopeOption(dialog, 'project')
    await expect(def).toHaveAttribute('tabindex', '0')
    await expect(project).toHaveAttribute('tabindex', '-1')
    await dialog.focus()
    await page.keyboard.press('Tab')
    await expect(def).toBeFocused()
    // Tab leaves the group for the filter: the second side is not a stop.
    await page.keyboard.press('Tab')
    await expect(filterBox(dialog)).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(def).toBeFocused()
    // Arrows switch the scope and move focus with the checked side; the tab stops follow.
    await page.keyboard.press('ArrowRight')
    await expect(project).toBeFocused()
    await expect(project).toHaveAttribute('aria-checked', 'true')
    await expect(dialog).toHaveAttribute('data-scope', 'project')
    await expect(project).toHaveAttribute('tabindex', '0')
    await expect(def).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('ArrowLeft')
    await expect(def).toBeFocused()
    await expect(def).toHaveAttribute('aria-checked', 'true')
    await expect(dialog).toHaveAttribute('data-scope', 'default')
    // From the first stop, Shift+Tab wraps to Close; About is right before it, never between the switch and the filter.
    await page.keyboard.press('Shift+Tab')
    expect(await activeClass(page)).toBe('engine-settings-popover-close')
    await page.keyboard.press('Shift+Tab')
    expect(await activeClass(page)).toBe('engine-settings-about')
    await page.keyboard.press('Shift+Tab')
    expect(await activeClass(page)).not.toBe('engine-settings-about')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    // Full forward order, recorded: switch -> filter -> the rows -> the footer -> About -> Close -> (wrap) switch.
    await def.focus()
    const order: string[] = []
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab')
      const cls = await activeClass(page)
      order.push(cls)
      if (cls === 'engine-settings-popover-close') break
    }
    test.info().annotations.push({ type: 'tab-order', description: order.join(' > ') })
    expect(order[0]).toBe('engine-settings-filter')
    expect(order[order.length - 1]).toBe('engine-settings-popover-close')
    expect(order[order.length - 2]).toBe('engine-settings-about')
    expect(order.filter((c) => c.includes('engine-settings-scope-option'))).toEqual([])
    await page.keyboard.press('Tab')
    await expect(def).toBeFocused()
    await page.keyboard.press('Escape')
  })

  test('iOS-style rows: control beside the text and centered, no per-row file lines at rest', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    // Wide enough to read: 620 at a regular window.
    expect(Math.round((await rect(dialog)).width)).toBe(620)
    // A seeded row (user file) and an unset row (default): text left, control
    // right on the SAME line, vertically centered; no blank band under the text.
    for (const key of ['alwaysThinkingEnabled', 'verbose']) {
      const row = popoverRow(dialog, key)
      await row.scrollIntoViewIfNeeded()
      const rowBox = await rect(row)
      const copy = await rect(row.locator('.settings-row-copy'))
      const control = await rect(row.locator('.engine-setting-control'))
      expect(control.left, `${key} control beside text`).toBeGreaterThanOrEqual(copy.right - 0.5)
      const drift = Math.abs((control.top + control.height / 2) - (rowBox.top + rowBox.height / 2))
      expect(drift, `${key} control centered`).toBeLessThanOrEqual(6)
      expect(rowBox.height - copy.height, `${key} no band under the text`).toBeLessThanOrEqual(16)
      // Where the value lives is noise on every row; the visible Reset already marks a set one.
      await expect(row.locator('.engine-setting-status')).toBeHidden()
      await expect(row.locator('.engine-setting-target')).toBeHidden()
    }
    await expect(dialog.getByTestId('engine-setting-reset-alwaysThinkingEnabled')).toBeVisible()
    await shot(page, 'r5/ios-rows-default-scope')
    // The EXCEPTIONAL provenance still shows: a value the project file holds.
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    const verbose = rowControl(dialog, 'claude', 'verbose')
    // Reset joins on the control's LEFT: the control's right edge never moves.
    const rightBefore = (await rect(verbose)).right
    await verbose.click()
    await expect.poll(async () => (await readLocal(repo))?.verbose).toBe(true)
    await expect(dialog.getByTestId('engine-setting-reset-verbose')).toBeVisible()
    expect(Math.abs((await rect(verbose)).right - rightBefore)).toBeLessThanOrEqual(1)
    const resetBox = await rect(dialog.getByTestId('engine-setting-reset-verbose'))
    expect(resetBox.right).toBeLessThanOrEqual((await rect(verbose)).left)
    await expect(popoverRow(dialog, 'verbose').locator('.engine-setting-status')).toBeVisible()
    await expect(popoverRow(dialog, 'verbose').locator('.engine-setting-status')).toHaveText('Set in this project (local)')
    await shot(page, 'r5/ios-rows-overlay-status')
    await dialog.getByTestId('engine-setting-reset-verbose').click()
    await expect.poll(async () => (await readLocal(repo))?.verbose).toBeUndefined()
    await scopeOption(dialog, 'default').click()
    await page.keyboard.press('Escape')
  })
})
