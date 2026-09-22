/**
 * Composer "+" menu -> "Engine settings": the popover for THIS session's engine,
 * host and working directory (chromium). Contract: /tmp/engine-settings/ux-slice/contract.md.
 *
 * Every assertion is scoped to one home column by data-session-id, requests are
 * asserted at the network layer, and disk assertions read the fixture HOME or
 * the spec's own project directory. The disk-writing project-scope cases live in
 * engine-settings-popover-scope.spec.ts; failure paths in -failures.spec.ts.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  HOST_LABEL, LOCAL_SCOPE_NOTE, NEXT_TURN_SENTENCE, NEW_SOURCES, REPO, captureView, claimUserFile, clickComposerOutside, clickOutside,
  composerTextarea, dialogOf, engineSettingsRow, expectInViewport, expectSideBySide, filterBox, fixtureRoot, makeGitProject, openPanels,
  openPlusMenu, openPopover, otherGroupsLinkText, plusButton, popoverRow, popoverRowWrap, popoverSources, rect,
  restoreSeed, rowControl, rowsArea, savedLine, savedUserSentence, scopeOption, sessionsGroup,
  sessionsItems, shortCwd, shot, startSessionAt, stubGet, waitForRows, watchSettingsRequests, type View,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let cwd = ''
let sid = ''
let captured: View

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000) // the hook may queue behind sibling spec files (claimUserFile)
  await claimUserFile(request)
  const root = await fixtureRoot()
  cwd = await makeGitProject(root)
  sid = await startSessionAt(request, cwd)
  captured = await captureView(request, sid)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

test.describe('composer "+" -> Engine settings popover', () => {
  test('the row, the request, the header, the switch and the rows', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const seen = watchSettingsRequests(page)
    const short = shortCwd(cwd)

    // Its own separator right above it, after the Shortcuts block.
    const menu = await openPlusMenu(panel)
    const row = engineSettingsRow(menu)
    await expect(row).toBeVisible()
    await expect(row).toHaveAttribute('role', 'menuitem')
    expect(await row.evaluate((el) => {
      const prev = el.previousElementSibling
      const kids = Array.from(el.parentElement!.children)
      const shortcuts = kids.findIndex((k) => k.classList.contains('chat-plus-menu-label') && k.textContent === 'Shortcuts')
      return { sep: prev?.getAttribute('role') === 'separator' && prev.classList.contains('chat-plus-menu-divider'), after: kids.indexOf(el) > shortcuts && shortcuts >= 0 }
    })).toEqual({ sep: true, after: true })
    // The tooltip names the engine, the cwd and the host.
    await expect(row).toHaveAttribute('title', `Claude Code settings for sessions in ${short} on ${HOST_LABEL}`)

    // Menu gone, dialog portalled under <body>.
    await row.click()
    const dialog = dialogOf(page)
    await expect(dialog).toBeVisible()
    await expect(menu).toHaveCount(0)
    expect(await dialog.evaluate((el) => el.parentElement === document.body)).toBe(true)
    expect(await dialog.getAttribute('data-testid')).toBe('engine-settings-popover')
    await waitForRows(dialog)

    // One GET with the session id only (no scope, no host, no cwd).
    expect(seen.filter((r) => r.startsWith('GET'))).toHaveLength(1)
    const url = new URL(seen[0].slice(4))
    expect(url.pathname).toBe('/api/engines/claude/settings')
    expect(url.searchParams.get('sessionId')).toBe(sid)
    for (const p of ['scope', 'host', 'cwd']) expect(url.searchParams.has(p), p).toBe(false)

    // Header copy.
    await expect(dialog.locator('h2.engine-settings-popover-title')).toHaveText('Claude Code settings')
    // One rule for the host everywhere, mid-sentence included: the label verbatim.
    await expect(dialog).toHaveAttribute('aria-label', `Claude Code settings for sessions in ${short} on ${HOST_LABEL}`)
    const subtitle = dialog.locator('.engine-settings-popover-subtitle')
    await expect(subtitle).toHaveText(`${HOST_LABEL} · ${short}`)
    await expect(subtitle).toHaveAttribute('title', cwd)

    // The switch and the two sentences under it.
    const group = dialog.locator('.engine-settings-scope[role=radiogroup]')
    await expect(group).toHaveAttribute('aria-label', 'Save changes to')
    await expect(scopeOption(dialog, 'default')).toHaveText('Same as Claude Code')
    await expect(scopeOption(dialog, 'project')).toHaveText('This project only')
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'false')
    await expect(dialog.getByTestId('engine-settings-scope-note')).toHaveText(LOCAL_SCOPE_NOTE)
    await expect(dialog.getByTestId('engine-settings-applies-on')).toHaveText(NEXT_TURN_SENTENCE)

    // Only the sessions group, in response order.
    const keys = await dialog.locator('.engine-settings-popover-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
    expect(keys).toEqual(sessionsItems(captured).map((i) => i.key))
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled')).toBeVisible()
    await expect(popoverRow(dialog, 'autoUpdates')).toHaveCount(0)
    await expect(popoverRow(dialog, 'theme')).toHaveCount(0)

    // the group help comes from the response, small and muted, and
    // lives in the About overlay rather than between the filter and the rows.
    await expect(dialog.locator('.engine-settings-group-help')).toHaveCount(0)
    await dialog.locator('button.engine-settings-about').click()
    const help = dialog.locator('.engine-settings-about-panel .engine-settings-group-help')
    await expect(help).toHaveText(sessionsGroup(captured)!.help!)
    const helpStyle = await help.evaluate((el) => {
      const cs = getComputedStyle(el)
      const muted = getComputedStyle(document.documentElement).getPropertyValue('--fg-muted').trim()
      const probe = document.createElement('span'); probe.style.color = muted; document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color; probe.remove()
      return { size: cs.fontSize, color: cs.color, muted: resolved }
    })
    expect(helpStyle.size).toBe('11px')
    expect(helpStyle.color).toBe(helpStyle.muted)
    await dialog.locator('button.engine-settings-about-close').click()

    // Control types (a non-null boolean is a switch, never a select).
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled').locator('[role=switch]')).toHaveCount(1)
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled').locator('select')).toHaveCount(0)
    await expect(popoverRow(dialog, 'outputStyle').locator('select')).toHaveCount(1)
    await expect(popoverRow(dialog, 'enableWorkflows').locator('select')).toHaveCount(1)

    // The permission-mode help is shown in full, second sentence included.
    const permHelp = popoverRow(dialog, 'permissions.defaultMode').locator('.engine-setting-help')
    await permHelp.scrollIntoViewIfNeeded()
    await expect(permHelp).toContainText('terminal sessions only')
    expect(await permHelp.evaluate((el) => ({
      clamp: getComputedStyle(el).getPropertyValue('-webkit-line-clamp'), overflow: el.scrollHeight <= el.clientHeight + 1,
    }))).toEqual({ clamp: 'none', overflow: true })

    // No "/config" anywhere; the note lives behind "About these settings" only.
    // Visible text only: the engine's own note may say "/config", but it stays folded away.
    expect(await dialog.evaluate((el) => (el as HTMLElement).innerText)).not.toContain('/config')
    // An (i) glyph button named "About these settings", after the switch in DOM order.
    const about = dialog.locator('button.engine-settings-about')
    await expect(about).toHaveAttribute('aria-label', 'About these settings')
    await expect(about).toHaveAttribute('title', 'About these settings')
    await expect(about).toHaveAttribute('aria-expanded', 'false')
    expect(await about.evaluate((el) => {
      const sw = document.querySelector('.engine-settings-scope[role=radiogroup]')!
      return !!(sw.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
    }), 'About follows the switch in the DOM').toBe(true)
    await expect(dialog.locator('.engine-settings-about-body')).toHaveCount(0)
    // The note opens as an overlay; the filter and the rows do not move.
    const filterTopBefore = (await rect(filterBox(dialog))).top
    const rowsTopBefore = (await rect(rowsArea(dialog))).top
    await about.click()
    await expect(about).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.locator('.engine-settings-about-body')).toHaveText(captured.note!)
    // The panel's first line says which file the switch's position writes.
    const userFile = captured.files.find((f) => f.scope === 'user')!
    await expect(dialog.getByTestId('engine-settings-about-scope'))
      .toHaveText(`With the switch on "Same as Claude Code", saves go to ${userFile.path} on ${HOST_LABEL}, except the few keys Claude Code itself keeps per project; those go to this project's local file.`)
    expect((await rect(filterBox(dialog))).top).toBeCloseTo(filterTopBefore, 0)
    expect((await rect(rowsArea(dialog))).top).toBeCloseTo(rowsTopBefore, 0)
    const panelBox = await rect(dialog.locator('.engine-settings-about-panel'))
    const dialogBox = await rect(dialog)
    expect(panelBox.left).toBeGreaterThanOrEqual(dialogBox.left - 0.5)
    expect(panelBox.right).toBeLessThanOrEqual(dialogBox.right + 0.5)
    expect(panelBox.bottom).toBeLessThanOrEqual(dialogBox.bottom + 0.5)
    await shot(page, 'about-open')
    // Escape closes the overlay first and returns focus to its button; the dialog stays.
    await page.keyboard.press('Escape')
    await expect(dialog.locator('.engine-settings-about-body')).toHaveCount(0)
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate(() => document.activeElement?.className)).toBe('engine-settings-about')
    await about.click()
    await dialog.locator('button.engine-settings-about-close').click()
    await expect(dialog.locator('.engine-settings-about-body')).toHaveCount(0)
    expect((await rect(filterBox(dialog))).top).toBeCloseTo(filterTopBefore, 0)

    // second half: a second open is a second GET (never cached).
    await dialog.locator('button.engine-settings-popover-close').click()
    await expect(dialog).toHaveCount(0)
    await openPopover(page, panel)
    await waitForRows(dialogOf(page))
    expect(seen.filter((r) => r.startsWith('GET'))).toHaveLength(2)
  })

  test('a toggle lands in the user file, the footer says so, focus and hover rules', async ({ page, request }) => {
    const home = await fixtureHome(request)
    expect((await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(true)
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)

    // Hovering a row changes its background.
    const target = popoverRow(dialog, 'verbose')
    const bg = () => target.evaluate((el) => getComputedStyle(el).backgroundColor)
    await page.mouse.move(5, 5)
    const idle = await bg()
    await target.hover()
    await expect.poll(bg).not.toBe(idle)

    // The select's left edge is where it was once Reset appears next to it.
    const baseRef = rowControl(dialog, 'claude', 'worktree.baseRef')
    await baseRef.scrollIntoViewIfNeeded()
    const leftBefore = (await rect(baseRef)).left
    await expect(dialog.getByTestId('engine-setting-reset-worktree.baseRef')).toHaveCount(0)
    await baseRef.selectOption('head')
    await expect(dialog.getByTestId('engine-setting-reset-worktree.baseRef')).toBeVisible()
    await expect.poll(async () => (await readClaudeSettings(home))['worktree'] as unknown).toEqual({ baseRef: 'head' })
    expect(Math.abs((await rect(baseRef)).left - leftBefore)).toBeLessThanOrEqual(1)
    await dialog.getByTestId('engine-setting-reset-worktree.baseRef').click()
    await expect.poll(async () => ((await readClaudeSettings(home)).worktree as { baseRef?: string } | undefined)?.baseRef).toBeUndefined()

    // The toggle -> PATCH body -> disk -> status line -> footer, dialog still open.
    const thinking = rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
    await thinking.scrollIntoViewIfNeeded()
    await expect(thinking).toHaveAttribute('aria-checked', 'true')
    const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/engines/claude/settings'))
    await thinking.click()
    const req = await patch
    expect(new URL(req.url()).searchParams.get('sessionId')).toBe(sid)
    expect(new URL(req.url()).searchParams.has('scope')).toBe(false)
    expect(req.postDataJSON()).toEqual({ set: { alwaysThinkingEnabled: false } })
    await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(false)
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled').locator('.engine-setting-status')).toHaveText('Set in user settings')
    await expect(savedLine(dialog)).toHaveText(savedUserSentence)
    await expect(savedLine(dialog)).toHaveAttribute('aria-live', 'polite')
    await expect(dialog).toBeVisible()

    // (x + focus return); the Tab wrap check runs at the end of the last test so a
    // failure there does not stop the tests after this one (serial mode).
    const close = dialog.locator('button.engine-settings-popover-close')
    await expect(close).toHaveAttribute('aria-label', 'Close')
    await close.click()
    await expect(dialog).toHaveCount(0)
    await expect(plusButton(panel)).toBeFocused()

    // Escape from a non-select element closes and returns focus to "+".
    const again = await openPopover(page, panel)
    await waitForRows(again)
    await again.locator('button.engine-settings-popover-close').focus()
    await page.keyboard.press('Escape')
    await expect(again).toHaveCount(0)
    await expect(plusButton(panel)).toBeFocused()

    // A click on the composer closes the popover AND lands the caret there.
    const third = await openPopover(page, panel)
    await waitForRows(third)
    await clickComposerOutside(panel, dialog)
    await expect(third).toHaveCount(0)
    await expect(composerTextarea(panel)).toBeFocused()
  })

  test('fits every viewport, keeps one height, scrolls inside, pointer rules', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])

    // Four viewports; width 620 when there is room, innerWidth - 24 when not; text left, control right.
    for (const [w, h, name] of [[1280, 800, 'fit-1280x800'], [900, 700, 'narrow-900'], [1440, 600, 'fit-1440x600'], [420, 700, 'narrow-420']] as const) {
      await page.setViewportSize({ width: w, height: h })
      const dialog = await openPopover(page, panel)
      await waitForRows(dialog)
      await expectInViewport(page, dialog)
      const r = await rect(dialog)
      expect(Math.round(r.width)).toBe(w >= 900 ? 620 : w - 24)
      await expectSideBySide(dialog, 'alwaysThinkingEnabled')
      await shot(page, name)
      if (w === 900) await shot(page, 'fit-900x700')
      // A resize while open re-places the dialog, still inside the window.
      if (w === 1280) {
        await page.setViewportSize({ width: 1000, height: 640 })
        await page.waitForTimeout(400)
        // Soft: a missed re-place is a finding on its own; the other viewports still get measured.
        const after = await rect(dialog)
        expect.soft(after.bottom, 'C17 bottom inside 640px after resize').toBeLessThanOrEqual(640.5)
        expect.soft(after.right, 'C17 right inside 1000px after resize').toBeLessThanOrEqual(1000.5)
        await page.setViewportSize({ width: w, height: h })
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    await page.setViewportSize({ width: 1280, height: 800 })

    // Skeleton, dense, filtered, cleared and project scope all share one height and top.
    const slow = await stubGet(page, 'real', { scope: 'default', delayMs: 1500, times: 1 })
    const dialog = await openPopover(page, panel)
    await expect(dialog.locator('.engine-settings-skeleton[aria-busy=true]')).toBeVisible()
    await expect(dialog.locator('.engine-settings-skeleton-row')).toHaveCount(6)
    const filterTop0 = (await rect(filterBox(dialog))).top
    const h0 = await rect(dialog)
    await waitForRows(dialog)
    await slow.unroute()
    const h1 = await rect(dialog)
    expect(h1.height).toBeLessThanOrEqual(720)
    expect(h1.height).toBeGreaterThanOrEqual(320)
    await filterBox(dialog).fill('zzzz')
    await expect(dialog.locator('.engine-settings-popover-nomatch')).toBeVisible()
    const h2 = await rect(dialog)
    await filterBox(dialog).fill('')
    await waitForRows(dialog)
    const h3 = await rect(dialog)
    // The filter holds its place from the skeleton through the dense and the
    // filtered list (the notes block reserves the default scope's height).
    expect(Math.abs((await rect(filterBox(dialog))).top - filterTop0)).toBeLessThanOrEqual(1)
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await expect(rowsArea(dialog)).not.toHaveAttribute('aria-busy', 'true')
    const h4 = await rect(dialog)
    for (const [i, r] of [h0, h2, h3, h4].entries()) {
      expect(Math.abs(r.height - h1.height), `height ${i}`).toBeLessThanOrEqual(1)
      expect(Math.abs(r.top - h1.top), `top ${i}`).toBeLessThanOrEqual(1)
    }
    // The project note is one line longer; that single reflow (at most one
    // text line) is the price of no blank band under the switch on every open.
    const filterShift = (await rect(filterBox(dialog))).top - filterTop0
    expect(filterShift).toBeGreaterThanOrEqual(0)
    expect(filterShift).toBeLessThanOrEqual(18)
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    expect(Math.abs((await rect(filterBox(dialog))).top - filterTop0)).toBeLessThanOrEqual(1)

    // The rows scroll inside; header, switch, filter and footer stay put.
    const rows = rowsArea(dialog)
    expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    const fixedBefore = await Promise.all([
      rect(dialog.locator('.engine-settings-popover-header')), rect(dialog.locator('.engine-settings-scope')),
      rect(filterBox(dialog)), rect(dialog.locator('.engine-settings-popover-footer')),
    ])
    const box = await rect(rows)
    await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2)
    await page.mouse.wheel(0, 400)
    await expect.poll(() => rows.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    const fixedAfter = await Promise.all([
      rect(dialog.locator('.engine-settings-popover-header')), rect(dialog.locator('.engine-settings-scope')),
      rect(filterBox(dialog)), rect(dialog.locator('.engine-settings-popover-footer')),
    ])
    expect(fixedAfter.map((r) => Math.round(r.top))).toEqual(fixedBefore.map((r) => Math.round(r.top)))

    // A press-and-drag inside the dialog never reaches the column strip (no reorder, dialog stays).
    const column = page.locator('.main-page-session-column').first()
    await column.evaluate((el) => {
      (window as unknown as { __colDown: number }).__colDown = 0
      el.addEventListener('pointerdown', () => { (window as unknown as { __colDown: number }).__colDown += 1 }, { capture: true })
    })
    const order = () => page.locator('.main-page-session-column .session-panel').evaluateAll((els) => els.map((e) => e.getAttribute('data-session-id')))
    const before = await order()
    const head = await rect(dialog.locator('.engine-settings-popover-header'))
    await page.mouse.move(head.left + 40, head.top + 8)
    await page.mouse.down()
    await page.mouse.move(head.left + 80, head.top + 40, { steps: 6 })
    await page.mouse.up()
    expect(await page.evaluate(() => (window as unknown as { __colDown: number }).__colDown)).toBe(0)
    await expect(dialog).toBeVisible()
    expect(await order()).toEqual(before)
    // The source half: the root stops pointerdown so dnd-kit's sensors never see it.
    const sources = await popoverSources()
    expect(sources.some((f) => /\.tsx$/.test(f)), `popover tsx among ${sources.join(', ')}`).toBe(true)
    const tsx = (await Promise.all(sources.filter((f) => f.endsWith('.tsx')).map((f) => fs.readFile(f, 'utf-8')))).join('\n')
    expect(tsx).toMatch(/onPointerDown=\{\s*\(?e\)?\s*=>\s*e\.stopPropagation\(\)/)

    // An outside pointerdown closes; "+" then opens the menu, and the menu is on top.
    await clickOutside(page, panel, dialog)
    await expect(dialog).toHaveCount(0)
    const reopened = await openPopover(page, panel)
    await waitForRows(reopened)
    await plusButton(panel).click()
    await expect(reopened).toHaveCount(0)
    const menu = panel.locator('.chat-plus-menu[role=menu]')
    await expect(menu).toBeVisible()
    const first = await rect(menu.locator('.chat-plus-menu-item').first())
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.chat-plus-menu') !== null,
      [first.left + first.width / 2, first.top + first.height / 2])).toBe(true)
    await page.keyboard.press('Escape')
  })

  test('filter, footer link, Files list, slow note, themes and source hygiene', async ({ page }) => {
    const [panel] = await openPanels(page, [sid])
    const short = shortCwd(cwd)

    // A slow GET says so after 2s, and the note goes away with the answer.
    const slow = await stubGet(page, 'real', { scope: 'default', delayMs: 3000, times: 1 })
    let dialog = await openPopover(page, panel)
    const note = dialog.locator('.engine-settings-slow-note')
    await expect(note).toHaveCount(0)
    await expect(note).toHaveText(`Still reading settings files on ${HOST_LABEL}…`, { timeout: 4000 })
    await waitForRows(dialog)
    await expect(note).toHaveCount(0)
    await slow.unroute()

    // Label hits win; help hits mark; no match says so; Escape clears, then closes.
    const visibleKeys = () => dialog.locator('.engine-settings-popover-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
    await filterBox(dialog).fill('think')
    await expect.poll(visibleKeys).toEqual(['alwaysThinkingEnabled'])
    await filterBox(dialog).fill('plan')
    const planKeys = await visibleKeys()
    const items = sessionsItems(captured)
    expect(planKeys).toEqual(items.filter((i) => /plan/i.test(i.label) || /plan/i.test(i.key)).map((i) => i.key))
    expect(planKeys).not.toContain('enableWorkflows')
    // A word that only the help of one row contains (from the response, never guessed).
    const helpOnly = items.find((i) => /\bcompaction summary\b/i.test(i.help) && !/compaction summary/i.test(i.label))!
    await filterBox(dialog).fill('compaction summary')
    await expect.poll(visibleKeys).toEqual([helpOnly.key])
    // The match is marked: in place through the Highlight API where the browser has it, else as a marked copy.
    const wrap = popoverRowWrap(dialog, helpOnly.key)
    await expect(wrap).toHaveAttribute('data-help-match', /^(in-place|copy)$/)
    if ((await wrap.getAttribute('data-help-match')) === 'copy') await expect(wrap.locator('mark')).toHaveCount(1)
    else expect(await page.evaluate(() => (CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get('engine-settings-help-match')?.size ?? 0)).toBeGreaterThan(0)
    await filterBox(dialog).fill('zzzz')
    await expect(dialog.locator('.engine-settings-popover-nomatch')).toHaveText('No setting matches "zzzz".')
    await filterBox(dialog).press('Escape')
    await expect(filterBox(dialog)).toHaveValue('')
    await expect(dialog).toBeVisible()
    await filterBox(dialog).press('Escape')
    await expect(dialog).toHaveCount(0)

    // Footer link text from the response; Files (N) with the missing ones marked.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const link = dialog.locator('a.engine-settings-more-link')
    await expect(link).toHaveText(otherGroupsLinkText(captured))
    await expect(link).toHaveAttribute('href', '/settings#engines')
    const files = dialog.getByTestId('engine-settings-files')
    await expect(files.locator('summary')).toHaveText(`Files (${captured.files.length})`)
    await files.locator('summary').click()
    await expect(files.locator('p.engine-settings-file')).toHaveCount(captured.files.length)
    for (const f of captured.files) {
      const line = files.locator(`p.engine-settings-file[data-file-id="${f.id}"]`)
      // A path under the cwd reads as <cwd-short>/...; the full path rides in the title and data-path.
      const under = f.path.startsWith(`${cwd}/`)
      await expect(line.locator('code')).toHaveText(under ? `${short}${f.path.slice(cwd.length)}` : f.path)
      await expect(line).toHaveAttribute('data-path', f.path)
      await expect(line.locator('button.engine-settings-file-open')).toHaveAttribute('title', `Open ${f.path}`)
      if (!f.exists) await expect(line).toContainText('(not created yet)')
      else await expect(line).not.toContainText('(not created yet)')
    }
    expect(captured.files.some((f) => f.path.startsWith(`${cwd}/`)), 'at least one project file to shorten').toBe(true)
    // On this Mac every path is a button that opens the Files view on it.
    const userLine = files.locator('p.engine-settings-file[data-file-id="user"]')
    await expect(userLine.locator('button.engine-settings-copy-path')).toHaveCount(0)
    await userLine.locator('button.engine-settings-file-open').click()
    const explorer = panel.locator('.session-file-explorer')
    await expect(explorer).toBeVisible({ timeout: 15_000 })
    await expect(explorer).toContainText('settings.json', { timeout: 15_000 })
    // The dialog is not required to close here (the spec asks only for the Files view); note what it does.
    test.info().annotations.push({ type: 'observation', description: `dialog after Files open: ${await dialog.count()} on screen` })
    if (await dialog.count()) await page.keyboard.press('Escape')
    await page.reload()
    await expect(plusButton(panel)).toBeVisible({ timeout: 30_000 })

    // The link is an SPA hop to Settings > Engines (no load event), and closes the popover.
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    let loads = 0
    page.on('load', () => { loads += 1 })
    await dialog.locator('a.engine-settings-more-link').click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.url()).toContain('/settings#engines')
    await expect(page.locator('#engines')).toBeVisible({ timeout: 15_000 })
    expect(loads).toBe(0)

    // Dense shots in both themes; new sources carry no emoji and no hex colours (rgba shadows aside).
    // Back to '/' through history (a popstate, still SPA routing).
    await page.goBack()
    await expect(plusButton(panel)).toBeVisible({ timeout: 30_000 })
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await shot(page, 'dense-light')
    await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark') })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await shot(page, 'dense-dark')
    await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'light'); document.documentElement.setAttribute('data-theme', 'light') })
    const sources = [...NEW_SOURCES.map((f) => path.join(REPO, f)), ...(await popoverSources())]
    for (const file of sources) {
      const text = await fs.readFile(file, 'utf-8').catch(() => '')
      expect(/\p{Extended_Pictographic}/u.test(text), `${file} has an emoji`).toBe(false)
      if (file.endsWith('.css')) {
        const hex = text.replace(/rgba?\([^)]*\)/g, '').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
        expect(hex, `${file} hex colours`).toEqual([])
      }
      const rawConsole = ['console', 'log'].join('.')
      expect(text.includes(rawConsole), `${file} uses ${rawConsole}`).toBe(false)
    }

    // Tab wraps inside the dialog (last visible focusable -> first).
    // "Focusable" = visible (checkVisibility, which is false under a closed <details>:
    // Chromium keeps that content laid out with content-visibility, so offsetParent and
    // client rects are NOT a visibility test), enabled, not inside a disabled fieldset.
    const focusables = (action: 'focus-last' | 'index') => dialog.evaluate((el, act) => {
      const all = Array.from(el.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((n) => !n.hasAttribute('disabled') && n.closest('fieldset:disabled') === null && n.checkVisibility())
      if (act === 'focus-last') { all[all.length - 1]!.focus(); return all.length }
      return all.indexOf(document.activeElement as HTMLElement)
    }, action)
    expect(await focusables('focus-last')).toBeGreaterThan(3)
    expect(await focusables('index')).toBeGreaterThan(3)
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'Tab from the last focusable stays inside').toBe(true)
    expect(await focusables('index'), 'Tab from the last focusable lands on the first').toBe(0)
  })
})
