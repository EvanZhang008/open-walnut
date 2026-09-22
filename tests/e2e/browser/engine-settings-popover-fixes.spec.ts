/**
 * Composer "+" -> "Engine settings" popover: the nitpick round (chromium).
 * Each test would have failed before its fix:
 * Escape and Tab after a save (focus fell to <body> when the saving row's fieldset was disabled)
 * the rightmost column's popover clamps to the viewport edge instead of covering the neighbour
 * the Files list scrolls in its own box, paths under the cwd read short, two rows stay visible
 * a help-only filter hit shows the help sentence once, marked
 * a failed save reports in the footer's status slot; the switch and the rows do not move
 * a saved sentence never changes the footer's height; the whole sentence is one click away
 * header chrome budget: rows visible at 1280x800 and 1280x900
 * the off toggle stays visible on a hovered row
 * one host rule mid-sentence; the footer link reads as one phrase
 * a composer that measures 0x0 for a moment (a column re-laying out) keeps the
 *   dialog; an anchor that stays gone takes it along
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  HOST_LABEL, banner, claimUserFile, composerTextarea, dialogOf, filterBox, fixtureRoot, makeGitProject, openPanels, openPlusMenu,
  openPopover, plusButton, popoverRow, popoverRowWrap, restoreSeed, rowControl, rowsArea, savedLine, savedProjectBase,
  savedUserSentence, scopeOption, shortCwd, shot, startSessionAt, stubPatch, waitForRows,
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
  repoA = await makeGitProject(root)
  repoB = await makeGitProject(root)
  sidA = await startSessionAt(request, repoA)
  sidB = await startSessionAt(request, repoB)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const rect = (loc: Locator) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
})

/** Where the focus is, described from inside the page: the dialog root, a control inside it, or elsewhere. */
const focusPlace = (page: Page) => page.evaluate(() => {
  const a = document.activeElement
  const root = document.querySelector('.engine-settings-popover')
  if (!a || a === document.body) return 'body'
  if (a === root) return 'root'
  return root?.contains(a) ? `inside:${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[${a.getAttribute('role')}]` : ''}` : `outside:${a.tagName}`
})

/** Rows whose whole box sits inside the rows area's visible box (plus the geometry, for the report). */
const rowsGeometry = (dialog: Locator) => rowsArea(dialog).evaluate((area) => {
  const a = area.getBoundingClientRect()
  const rows = Array.from(area.querySelectorAll('.engine-settings-popover-row')).map((el) => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }
  })
  return {
    area: { top: Math.round(a.top), bottom: Math.round(a.bottom), height: Math.round(a.height) },
    rows: rows.slice(0, 5),
    visible: rows.filter((r) => r.top >= a.top - 0.5 && r.bottom <= a.bottom + 0.5).length,
  }
})
const fullyVisibleRows = async (dialog: Locator) => (await rowsGeometry(dialog)).visible

/** Hide the composer's controls row (where the "+" lives) from inside the page, then bring it back. */
const hideComposerControls = (page: Page, sid: string, ms: number | null) => page.evaluate(({ id, hideMs }) => {
  const row = document.querySelector(`.main-page-session-column .session-panel[data-session-id="${id}"] .chat-input-controls`) as HTMLElement | null
  if (!row) throw new Error('composer controls row not found')
  row.style.display = 'none'
  if (hideMs !== null) setTimeout(() => { row.style.display = ''; }, hideMs)
}, { id: sid, hideMs: ms })

test.describe('engine settings popover: nitpick fixes', () => {
  test('Escape closes and Tab stays inside after a save, in both outcomes', async ({ page, request }) => {
    const home = await fixtureHome(request)
    const [panel] = await openPanels(page, [sidA])
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const thinking = () => rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
    await expect(thinking()).toHaveAttribute('aria-checked', 'true')

    // A real save: the fieldset disables while in flight, then re-enables.
    await thinking().click()
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled').locator('.engine-setting-status')).toHaveText('Set in user settings')
    await expect(savedLine(dialog)).toHaveText(savedUserSentence)
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(false)
    // Focus is back inside the dialog (on the row's control), never on <body>.
    await expect.poll(() => focusPlace(page)).toBe('inside:button[switch]')
    // Tab keeps cycling inside the dialog.
    await page.keyboard.press('Tab')
    expect(await focusPlace(page)).toMatch(/^inside:/)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await plusButton(panel).evaluate((el) => el === document.activeElement)).toBe(true)

    // A refused save (400 not-written): the control goes back, and Escape still closes.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const refused = await stubPatch(page, { status: 400, body: { error: 'The value is not one this key accepts.', outcome: 'not-written' } }, { times: 1 })
    await thinking().click()
    await expect(banner(dialog)).toHaveText('The value is not one this key accepts.')
    await expect(thinking()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => focusPlace(page)).toMatch(/^(inside:|root)/)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await refused.unroute()

    // Focus on <body> by other means (a click on the dialog's own padding) still leaves Escape working.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await focusPlace(page)).toBe('body')
    await page.keyboard.press('Tab')
    expect(await focusPlace(page)).toMatch(/^inside:/)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Put the seed back for the next tests.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await thinking().click()
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(true)
    await page.keyboard.press('Escape')
  })

  test('the rightmost column\'s popover clamps to the viewport edge and stays over its own column', async ({ page }) => {
    const [panelA, panelB] = await openPanels(page, [sidA, sidB])
    const vw = page.viewportSize()!.width
    const plusA = await rect(plusButton(panelA))
    const plusB = await rect(plusButton(panelB))
    expect(plusB.left).toBeGreaterThan(plusA.right)
    const dialog = await openPopover(page, panelB)
    await waitForRows(dialog)
    const d = await rect(dialog)
    // Inside the viewport, at the 12px margin, over the column it belongs to.
    expect(d.right).toBeLessThanOrEqual(vw - 12 + 0.5)
    expect(d.right).toBeGreaterThanOrEqual(vw - 12 - 1)
    expect(d.left).toBeLessThanOrEqual(plusB.left + 0.5)
    expect(d.right).toBeGreaterThanOrEqual(plusB.right)
    // At 620 wide the box overlaps the neighbouring column (it is wider than a
    // column, and any outside click dismisses it); the invariant that killed
    // the original bug is the pair above: the box COVERS its own "+" and its
    // right edge sits at the viewport margin, so it can never flip right-aligned
    // onto the neighbour and leave its own column, which is what N3 fixed.
    // And the popover's own composer box stays clear below it ( stays reachable): with a
    // one-line draft the bottom edge sits above the composer box, not merely above the "+".
    const boxB = await rect(panelB.locator('.chat-input-box'))
    expect(d.bottom).toBeLessThanOrEqual(boxB.top + 0.5)
    await shot(page, 'fix-two-cols-right')
    await composerTextarea(panelB).click()
    await expect(dialog).toHaveCount(0)
    await expect(composerTextarea(panelB)).toBeFocused()

    // The left column's popover start-aligns on its own "+" when it fits,
    // and clamps to the margin (still covering its "+") when 620 does not.
    const dialogA = await openPopover(page, panelA)
    await waitForRows(dialogA)
    const a = await rect(dialogA)
    if (plusA.left + 620 <= vw - 12) {
      expect(Math.abs(a.left - plusA.left)).toBeLessThanOrEqual(1)
    } else {
      expect(a.right).toBeLessThanOrEqual(vw - 12 + 0.5)
      expect(a.left).toBeLessThanOrEqual(plusA.left + 0.5)
      expect(a.right).toBeGreaterThanOrEqual(plusA.right)
    }
    await page.keyboard.press('Escape')
  })

  test(' narrow: at 900x700 a single column\'s popover ends at the right margin, not over the sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    const [panel] = await openPanels(page, [sidA])
    const plus = await rect(plusButton(panel))
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const d = await rect(dialog)
    if (plus.left + 620 > 900 - 12) {
      expect(d.right).toBeGreaterThanOrEqual(900 - 12 - 1)
      expect(d.right).toBeLessThanOrEqual(900 - 12 + 0.5)
    } else {
      expect(Math.abs(d.left - plus.left)).toBeLessThanOrEqual(1)
    }
    expect(d.left).toBeGreaterThanOrEqual(0)
    await shot(page, 'fix-narrow-900')
    await page.keyboard.press('Escape')
  })

  test('Files scrolls in its own box with short paths, and the rows keep their room', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const [panel] = await openPanels(page, [sidA])
    const short = shortCwd(repoA)
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const before = await rect(rowsArea(dialog))
    const geometry = await rowsGeometry(dialog)
    const visibleBefore = geometry.visible
    test.info().annotations.push({ type: 'measurement', description: `1280x800 rows area ${Math.round(before.height)}px, fully visible rows ${visibleBefore}` })
    expect(visibleBefore, JSON.stringify(geometry)).toBeGreaterThanOrEqual(3)

    const files = dialog.getByTestId('engine-settings-files')
    await files.locator('summary').click()
    const list = files.locator('.engine-settings-files-list')
    await expect(list).toBeVisible()
    const listBox = await list.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflowY: getComputedStyle(el).overflowY, max: getComputedStyle(el).maxHeight }))
    expect(listBox.overflowY).toBe('auto')
    // The four entries show in full (no inner scroll for four paths); the cap guards a longer list.
    expect(listBox.client).toBeLessThanOrEqual(200 + 0.5)
    expect(listBox.scroll, JSON.stringify(listBox)).toBeLessThanOrEqual(listBox.client + 1)
    // Rows still fully visible with the list open (the list borrows from the rows only while open).
    const after = await rect(rowsArea(dialog))
    expect(before.height - after.height).toBeLessThanOrEqual(200 + 30)
    expect(await fullyVisibleRows(dialog)).toBeGreaterThanOrEqual(2)
    // Project paths read under the short cwd; full path in the title; a wrap
    // happens only after a slash, never inside `settings.json`.
    for (const id of ['project', 'project-local']) {
      const line = files.locator(`p.engine-settings-file[data-file-id="${id}"]`)
      const code = line.locator('code')
      await expect(code).toHaveText(new RegExp(`^${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/settings(\\.local)?\\.json$`))
      expect((await rect(code)).height).toBeLessThan(3 * 15.4 + 1)
      // The file name (everything after the last slash) sits on ONE line.
      const fileNameLines = await code.evaluate((el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
        const last = nodes[nodes.length - 1]
        const range = document.createRange(); range.selectNodeContents(last)
        const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top)))
        return { text: last.textContent, lines: tops.size }
      })
      expect(fileNameLines.text).toMatch(/^settings(\.local)?\.json$/)
      expect(fileNameLines.lines, `file name of ${id} on one line`).toBe(1)
      await expect(line.locator('button.engine-settings-file-open')).toHaveAttribute('title', new RegExp(`^Open ${repoA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`))
    }
    await shot(page, 'fix-files-open')
    await page.keyboard.press('Escape')
  })

  test(' at 1280x900: header chrome under 280px, three rows fully visible on open (stacked rows, cap it there)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const visible = await fullyVisibleRows(dialog)
    const area = await rect(rowsArea(dialog))
    const d = await rect(dialog)
    const chrome = area.top - d.top
    test.info().annotations.push({ type: 'measurement', description: `1280x900 dialog ${Math.round(d.height)}px, chrome above rows ${Math.round(chrome)}px, rows area ${Math.round(area.height)}px, fully visible rows ${visible}` })
    expect(chrome).toBeLessThan(280)
    expect(visible).toBeGreaterThanOrEqual(3)
    await shot(page, 'fix-dense-900')
    await page.keyboard.press('Escape')
  })

  test('a help-only filter hit shows the help sentence once, with the match marked', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await filterBox(dialog).fill('compaction summary')
    const wrap = popoverRowWrap(dialog, 'precomputeCompactionEnabled')
    await expect(wrap).toBeVisible()
    await expect(wrap).toHaveAttribute('data-help-match', /^(in-place|copy)$/)
    const mode = await wrap.getAttribute('data-help-match')
    const help = wrap.locator('.engine-setting-help')
    const copy = wrap.locator('.engine-setting-help-match')
    if (mode === 'in-place') {
      await expect(help).toBeVisible()
      await expect(copy).toHaveCount(0)
      const marked = await page.evaluate(() => {
        const hl = (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get('engine-settings-help-match')
        return hl ? hl.size : -1
      })
      expect(marked).toBeGreaterThan(0)
    } else {
      await expect(help).toBeHidden()
      await expect(copy).toBeVisible()
      await expect(copy.locator('mark').first()).toHaveText(/compaction summary/i)
    }
    // The sentence appears once in the row's visible text.
    const text = await wrap.evaluate((el) => (el as HTMLElement).innerText)
    const needle = 'compaction summary'
    expect(text.toLowerCase().split(needle).length - 1).toBe(1)
    await shot(page, 'fix-filter-helpmatch')
    await filterBox(dialog).fill('')
    await expect(wrap).not.toHaveAttribute('data-help-match', /./)
    await page.keyboard.press('Escape')
  })

  test('a failed or landed save reports in the footer slot; switch, filter and rows do not move', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const switchTop = (await rect(dialog.locator('.engine-settings-scope-row'))).top
    const filterTop = (await rect(filterBox(dialog))).top
    const rowsBox = await rect(rowsArea(dialog))
    const footerBox = await rect(dialog.locator('.engine-settings-popover-footer'))
    const thinking = () => rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
    const toggleBox = await rect(thinking())

    // A failed save.
    const down = await stubPatch(page, { status: 502, body: { error: 'The host could not be reached in time.', outcome: 'unknown' } }, { times: 1 })
    await thinking().click()
    await expect(banner(dialog)).toHaveText('The host could not be reached in time.')
    const bannerBox = await rect(banner(dialog))
    expect(bannerBox.top).toBeGreaterThanOrEqual(footerBox.top - 0.5)
    expect((await rect(dialog.locator('.engine-settings-scope-row'))).top).toBeCloseTo(switchTop, 0)
    expect((await rect(filterBox(dialog))).top).toBeCloseTo(filterTop, 0)
    expect((await rect(rowsArea(dialog))).top).toBeCloseTo(rowsBox.top, 0)
    expect((await rect(rowsArea(dialog))).bottom).toBeCloseTo(rowsBox.bottom, 0)
    await expect.poll(async () => (await rect(thinking())).top).toBeCloseTo(toggleBox.top, 0)
    await shot(page, 'fix-save-failed')
    await banner(dialog).locator('button[aria-label="Dismiss"]').click()
    await expect(banner(dialog)).toHaveCount(0)
    await down.unroute()
    // The re-read has landed (data-state ready, control matches disk: still on).
    await expect(thinking()).toHaveAttribute('aria-checked', 'true')

    // A project save whose sentence is long (three lines unclamped) keeps the footer at one line.
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await waitForRows(dialog)
    const rowsProject = await rect(rowsArea(dialog))
    await rowControl(dialog, 'claude', 'outputStyle').selectOption('Learning')
    await expect(savedLine(dialog)).toHaveText(new RegExp(`^${savedProjectBase(repoA).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Created `))
    const line = savedLine(dialog)
    const lineBox = await rect(line)
    // Up to three lines, wrapped inside the popover (never clipped at its edge); the rows' top stays put.
    expect(lineBox.height).toBeLessThanOrEqual(3 * 17.4 + 1)
    expect(lineBox.right).toBeLessThanOrEqual((await rect(dialog)).right - 8)
    expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect((await rect(rowsArea(dialog))).top).toBeCloseTo(rowsProject.top, 0)
    expect(rowsProject.bottom - (await rect(rowsArea(dialog))).bottom).toBeLessThanOrEqual(2 * 17.4 + 2)
    await expect(line).toHaveAttribute('title', (await line.textContent())!)
    // The whole sentence is on screen, or a visible More control unfolds it.
    const clipped = await line.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
    const more = dialog.getByTestId('engine-settings-status-more')
    if (clipped) {
      await expect(more).toBeVisible()
      await more.click()
      expect(await line.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
      await expect(more).toHaveText(/Less/)
      await shot(page, 'fix-saved-expanded')
      await more.click()
    } else {
      await expect(more).toHaveCount(0)
    }
    // Clean up the project file through the UI (Reset), and check 's sentence once more here.
    await dialog.getByTestId('engine-setting-reset-outputStyle').click()
    await expect(savedLine(dialog)).toHaveText('Removed Output style from this project (local); the user settings value applies again.')
    await page.keyboard.press('Escape')
  })

  test('a briefly hidden "+" keeps the dialog; one that stays hidden closes it', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const before = await rect(dialog)

    // The anchor measures 0x0 for 250ms, as a column re-laying out under load
    // does. The dialog must stay, in place: closing it would throw away whatever
    // the user was doing in it because of a reflow they never asked for.
    await hideComposerControls(page, sidA, 250)
    await page.waitForTimeout(150)
    await expect(dialog).toBeVisible()
    await page.waitForTimeout(600)
    await expect(dialog).toBeVisible()
    expect(await rect(dialog)).toEqual(before)
    await waitForRows(dialog)

    // An anchor that stays gone is really gone: the dialog follows it out.
    await hideComposerControls(page, sidA, null)
    await expect(dialog).toHaveCount(0, { timeout: 5_000 })
  })

  test('off toggle visible on a hovered row, one host rule, footer link as one phrase', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const menu = await openPlusMenu(panel)
    await expect(menu.locator('button.chat-plus-menu-item', { hasText: 'Engine settings' }))
      .toHaveAttribute('title', `Claude Code settings for sessions in ${shortCwd(repoA)} on ${HOST_LABEL}`)
    await menu.locator('button.chat-plus-menu-item', { hasText: 'Engine settings' }).click()
    const dialog = dialogOf(page)
    await waitForRows(dialog)
    // "This Mac" reads the same everywhere, mid-sentence included.
    await expect(dialog).toHaveAttribute('aria-label', new RegExp(` on ${HOST_LABEL}$`))
    await expect(dialog.getByTestId('engine-settings-scope-note')).toContainText(`on ${HOST_LABEL},`)
    expect(await dialog.evaluate((el) => (el as HTMLElement).innerText)).not.toMatch(/this Mac/)
    // The link is one phrase.
    await expect(dialog.locator('a.engine-settings-more-link')).toHaveText(/^.+ settings \(\d+\) are in Settings › Engines$/)
    // The verbose row is seeded off; hovered, its track keeps a border and a background unlike the row's.
    const row = popoverRow(dialog, 'verbose')
    await row.scrollIntoViewIfNeeded()
    const toggle = rowControl(dialog, 'claude', 'verbose')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await row.hover()
    const colors = await toggle.evaluate((el) => {
      const row = el.closest('.engine-setting-row')!
      const t = getComputedStyle(el)
      return { track: t.backgroundColor, border: t.borderTopColor, row: getComputedStyle(row).backgroundColor }
    })
    expect(colors.track).not.toBe(colors.row)
    expect(colors.border).not.toBe(colors.row)
    expect(colors.border).not.toBe('rgba(0, 0, 0, 0)')
    await shot(page, 'fix-hover-off-toggle')
    await page.keyboard.press('Escape')
  })
})
