/**
 * Composer "+" -> "Engine settings" popover: review round three, copy and
 * chrome (chromium). Each test would have failed before its fix:
 * the default-scope sentence names the second exception (keys the engine files per project)
 * the footer link is built from the response: "<titles joined by and> settings (N) are in Settings › Engines"
 * the same for a Codex-shaped view; a plain link when no other group has rows
 * while loading the link is a neutral "Settings › Engines" and the (i) is there, disabled
 * a failed first load leaves the filter disabled, like the switch
 * the filter box and the rows keep their top through skeleton, dense, a filter, a scope switch
 * the draft guard dims the note instead of leaving a blank band
 * the Files disclosure has a chevron that turns when open
 * an unavailable "This project only" wears a lock, its reason, a not-allowed cursor
 * dark theme: the popover surface is lighter than the page under it and casts a shadow
 */
import { test, expect, type Locator } from '@playwright/test'
import {
  LOADING_LINK_TEXT, LOCAL_SCOPE_NOTE, captureView, claimUserFile, filterBox, fixtureRoot, makeGitProject, openPanels, openPopover,
  otherGroupsLinkText, popoverRow, rect, restoreSeed, rowControl, rowsArea, scopeOption, shot, startSessionAt, stubGet,
  waitForRows,
} from './engine-settings-popover-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repoA = ''
let sidA = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  await claimUserFile(request)
  const root = await fixtureRoot()
  repoA = await makeGitProject(root)
  sidA = await startSessionAt(request, repoA)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const opacity = (loc: Locator) => loc.evaluate((el) => Number(getComputedStyle(el).opacity))

test.describe('engine settings popover: round three, copy and chrome', () => {
  test('the default sentence admits both exceptions; the link reads the response', async ({ page, request }) => {
    const captured = await captureView(request, sidA)
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const note = dialog.getByTestId('engine-settings-scope-note')
    await expect(note).toHaveText(LOCAL_SCOPE_NOTE)
    // Where a save goes is said ONCE, here: the rows carry no "Saves to" line
    // (Output style still writes the project file; the data says so, hidden).
    await expect(popoverRow(dialog, 'outputStyle')).toHaveAttribute('data-write-target', 'project-local')
    await expect(popoverRow(dialog, 'outputStyle').locator('.engine-setting-target')).toBeHidden()
    // Titles in response order joined by " and ", N = the sum of those groups' rows (never a literal).
    const link = dialog.locator('a.engine-settings-more-link')
    const others = captured.groups.filter((g) => g.id !== 'sessions' && g.items.length > 0)
    expect(others.length).toBeGreaterThanOrEqual(2)
    const n = others.reduce((s, g) => s + g.items.length, 0)
    await expect(link).toHaveText(`${others.map((g) => g.title).join(' and ')} settings (${n}) are in Settings › Engines`)
    await expect(link).toHaveText(otherGroupsLinkText(captured))
    // Still a SPA navigation to the Engines section.
    await page.evaluate(() => { (window as unknown as { __r3marker?: number }).__r3marker = 1 })
    await link.click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => page.url()).toContain('/settings#engines')
    expect(await page.evaluate(() => (window as unknown as { __r3marker?: number }).__r3marker)).toBe(1)
    await expect(page.locator('#engines')).toBeVisible({ timeout: 15_000 })
  })

  test('a Codex-shaped view; a plain link when no other group has rows', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const codex = await stubGet(page, (real) => {
      const sessions = real.groups.find((g) => g.id === 'sessions')!
      const other = real.groups.find((g) => g.id !== 'sessions')!
      return {
        ...real, engine: 'codex', displayName: 'Codex', appliesOn: 'new-session', files: [real.files[0]],
        groups: [sessions, { ...other, id: 'updates', title: 'Updates', items: other.items.slice(0, 1) }],
      }
    }, { scope: 'default', times: 1 })
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await expect(dialog.locator('a.engine-settings-more-link')).toHaveText('Updates settings (1) are in Settings › Engines')
    await expect(dialog.getByTestId('engine-settings-files').locator('summary')).toHaveText('Files (1)')
    await codex.unroute()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const only = await stubGet(page, (real) => ({ ...real, groups: real.groups.filter((g) => g.id === 'sessions') }), { scope: 'default', times: 1 })
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    await expect(dialog.locator('a.engine-settings-more-link')).toHaveText('Open Settings › Engines')
    await only.unroute()
    await page.keyboard.press('Escape')
  })

  test('a stable link and a present (i) while loading; a failed first load disables the filter', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    // GET held: the skeleton is on screen long enough to read the chrome.
    const slow = await stubGet(page, 'real', { scope: 'default', delayMs: 1500, times: 1 })
    let dialog = await openPopover(page, panel)
    await expect(dialog).toHaveAttribute('data-state', 'loading')
    const link = dialog.locator('a.engine-settings-more-link')
    await expect(link).toHaveText(LOADING_LINK_TEXT)
    const about = dialog.locator('button.engine-settings-about')
    await expect(about).toHaveCount(1)
    await expect(about).toBeDisabled()
    await expect(filterBox(dialog)).toBeDisabled()
    const aboutBoxLoading = await rect(about)
    await shot(page, 'r4/skeleton-chrome')
    await waitForRows(dialog)
    await expect(about).toBeEnabled()
    await expect(filterBox(dialog)).toBeEnabled()
    // The header keeps its shape: the (i) did not appear or move when the view landed.
    const aboutBoxReady = await rect(about)
    expect(Math.abs(aboutBoxReady.top - aboutBoxLoading.top)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(aboutBoxReady.left - aboutBoxLoading.left)).toBeLessThanOrEqual(0.5)
    await expect(link).toHaveText(/ settings \(\d+\) are in Settings › Engines$/)
    await expect(link).toContainText(LOADING_LINK_TEXT)
    await slow.unroute()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // First load fails -> the switch AND the filter are disabled; Retry brings both back.
    const failed = await stubGet(page, { status: 502, body: { error: 'The host devbox could not be reached in time.', outcome: 'unknown' } }, { scope: 'default', times: 1 })
    dialog = await openPopover(page, panel)
    await expect(dialog).toHaveAttribute('data-state', 'error')
    await expect(dialog.locator('.engine-settings-popover-error')).toHaveText('The host devbox could not be reached in time.')
    await expect(filterBox(dialog)).toBeDisabled()
    await expect(dialog.locator('.engine-settings-scope[role=radiogroup]')).toHaveAttribute('aria-disabled', 'true')
    await expect(link).toHaveText(LOADING_LINK_TEXT)
    await shot(page, 'r4/first-fail-filter-disabled')
    await failed.unroute()
    await dialog.locator('button.engine-settings-retry').click()
    await waitForRows(dialog)
    await expect(filterBox(dialog)).toBeEnabled()
    await page.keyboard.press('Escape')
  })

  test('the filter top never moves: skeleton, dense, filtered, cleared, project scope', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const [panel] = await openPanels(page, [sidA])
    const slow = await stubGet(page, 'real', { scope: 'default', delayMs: 1200, times: 1 })
    const dialog = await openPopover(page, panel)
    await expect(dialog).toHaveAttribute('data-state', 'loading')
    const geometry = async () => ({ root: await rect(dialog), filter: await rect(filterBox(dialog)), rows: await rect(rowsArea(dialog)) })
    const g0 = await geometry()
    await waitForRows(dialog)
    const g1 = await geometry()
    await filterBox(dialog).fill('zzzz')
    await expect(dialog.locator('.engine-settings-popover-nomatch')).toBeVisible()
    const g2 = await geometry()
    await filterBox(dialog).fill('')
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled')).toBeVisible()
    const g3 = await geometry()
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
    await expect(dialog).toHaveAttribute('data-scope', 'project')
    await expect(popoverRow(dialog, 'alwaysThinkingEnabled')).toHaveAttribute('data-write-target', 'project-local')
    const g4 = await geometry()
    await shot(page, 'r4/height-stable-project')
    const all = [g0, g1, g2, g3, g4]
    test.info().annotations.push({ type: 'geometry', description: JSON.stringify(all.map((g) => ({ h: g.root.height, top: g.root.top, filterTop: g.filter.top, rowsTop: g.rows.top }))) })
    for (const g of all) {
      expect(Math.abs(g.root.height - g1.root.height), 'root height').toBeLessThanOrEqual(1)
      expect(Math.abs(g.root.top - g1.root.top), 'root top').toBeLessThanOrEqual(1)
      expect(Math.abs(g.filter.top - g1.filter.top), 'filter top').toBeLessThanOrEqual(1)
      expect(Math.abs(g.rows.top - g1.rows.top), 'rows top').toBeLessThanOrEqual(1)
    }
    const maxH = await dialog.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--menu-max-height')))
    expect(Math.abs(g1.root.height - Math.min(720, maxH))).toBeLessThanOrEqual(1)
    // Both scope notes are the same ONE-line box: the sentence changed, nothing under it moved.
    const noteBox = await rect(dialog.getByTestId('engine-settings-scope-note'))
    expect(noteBox.height).toBeGreaterThanOrEqual(12 * 1.45 - 1)
    expect(noteBox.height).toBeLessThan(2 * 12 * 1.45)
    await scopeOption(dialog, 'default').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    await slow.unroute()
    await page.keyboard.press('Escape')
  })

  test('the guard dims the note without a hole; the Files line has a turning chevron', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const note = dialog.getByTestId('engine-settings-scope-note')
    const applies = dialog.getByTestId('engine-settings-applies-on')
    const noteBefore = await rect(note)
    const appliesBefore = await rect(applies)
    const language = rowControl(dialog, 'claude', 'language')
    await language.scrollIntoViewIfNeeded()
    await language.fill('zz-draft')
    await scopeOption(dialog, 'project').click()
    await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
    const guard = dialog.locator('.engine-settings-draft-guard')
    await expect(guard).toHaveText('Press Enter to save the value first, or Escape to discard.')
    // The guard covers the note's first line; the note stays in the layout, dimmed, so the block has no blank band.
    const guardBox = await rect(guard)
    expect(Math.abs(guardBox.top - noteBefore.top)).toBeLessThanOrEqual(1)
    expect(await opacity(note)).toBeLessThan(0.5)
    expect(await note.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible')
    const noteDuring = await rect(note)
    const appliesDuring = await rect(applies)
    expect(Math.abs(noteDuring.top - noteBefore.top)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(appliesDuring.top - appliesBefore.top)).toBeLessThanOrEqual(0.5)
    // The guard covers the one-line note edge to edge; the applies-on line sits right under it.
    expect(guardBox.bottom).toBeLessThan(appliesDuring.top)
    expect(Math.abs(noteDuring.bottom - guardBox.bottom)).toBeLessThanOrEqual(2)
    await shot(page, 'r4/draft-guard-dimmed')
    await language.press('Escape')
    await expect(language).toHaveValue('Chinese')
    await expect(guard).toHaveCount(0, { timeout: 5000 })
    expect(await opacity(note)).toBe(1)

    // A chevron in the summary, pointing right when closed and down when open.
    const files = dialog.getByTestId('engine-settings-files')
    const chevron = files.locator('summary .engine-settings-files-chevron')
    await expect(chevron).toBeVisible()
    const box = await rect(chevron)
    expect(box.width).toBeGreaterThanOrEqual(11)
    expect(await files.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
    const closedTransform = await chevron.evaluate((el) => getComputedStyle(el).transform)
    await files.locator('summary').click()
    await expect.poll(() => files.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true)
    await expect.poll(() => chevron.evaluate((el) => getComputedStyle(el).transform)).not.toBe(closedTransform)
    await expect(files.locator('summary')).toHaveText(/^Files \(\d+\)$/)
    await shot(page, 'r4/files-open-chevron')
    await files.locator('summary').click()
    await expect.poll(() => files.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false)
    await page.keyboard.press('Escape')
  })

  test('an unavailable side wears a lock and its reason; the dark popover is a raised layer', async ({ page }) => {
    const [panel] = await openPanels(page, [sidA])
    const locked = await stubGet(page, (real) => {
      const { cwd: _cwd, ...rest } = real
      return { ...rest, projectScopeAvailable: false }
    }, { scope: 'default', times: 1 })
    let dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const project = scopeOption(dialog, 'project')
    await expect(project).toHaveClass(/is-unavailable/)
    await expect(project.locator('svg.engine-settings-scope-lock')).toHaveCount(1)
    await expect(project).toHaveAttribute('title', 'This session has no working directory, so there is no project file to write.')
    expect(await project.evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed')
    expect(await project.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('line-through')
    expect(await project.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('dotted')
    // Not how the merely unselected side looks: the default option, when unchecked, has none of it.
    await shot(page, 'r4/project-unavailable-lock')
    await locked.unroute()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Dark theme. The popover's background is lighter than the page's and it casts a shadow.
    await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark') })
    dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const colours = await dialog.evaluate((el) => {
      const lum = (rgb: string) => {
        const m = rgb.match(/\d+(\.\d+)?/g)!.map(Number)
        return (m[0] + m[1] + m[2]) / 3
      }
      const pop = getComputedStyle(el)
      const page = getComputedStyle(document.body)
      return { popover: pop.backgroundColor, page: page.backgroundColor, shadow: pop.boxShadow, lighter: lum(pop.backgroundColor) - lum(page.backgroundColor) }
    })
    test.info().annotations.push({ type: 'dark-surface', description: JSON.stringify(colours) })
    expect(colours.lighter).toBeGreaterThanOrEqual(20)
    expect(colours.shadow).not.toBe('none')
    expect(colours.shadow).toContain('rgba(0, 0, 0, 0.7)')
    await shot(page, 'r4/dark-raised')
    await page.keyboard.press('Escape')
    await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'light'); document.documentElement.setAttribute('data-theme', 'light') })
  })
})
