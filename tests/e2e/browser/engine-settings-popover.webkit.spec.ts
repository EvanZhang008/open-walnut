/**
 * Engine settings popover in WEBKIT: the Mac app is a WKWebView, and the two
 * behaviours that differ there are the native <select> (Escape from a focused
 * select must not take the dialog with it) and blur-commit of a text draft
 * when the closer fires. Plus the dense screenshots in both themes.
 *
 * Run: PW_WEBKIT=1 npx playwright test tests/e2e/browser/engine-settings-popover.webkit.spec.ts --project=webkit
 */
import { test, expect } from '@playwright/test'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  claimUserFile, clickComposerOutside, composerTextarea, fixtureRoot, makeGitProject, openPanels, openPopover, plusButton, popoverRow,
  readLocal, restoreSeed, rowControl, savedLine, savedUserSentence, shot, startSessionAt, waitForRows,
} from './engine-settings-popover-helpers'

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repo = ''
let sid = ''
let repoB = ''
let sidB = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000) // the hook may queue behind sibling spec files (claimUserFile)
  await claimUserFile(request)
  const root = await fixtureRoot()
  repo = await makeGitProject(root)
  sid = await startSessionAt(request, repo)
  repoB = await makeGitProject(root)
  sidB = await startSessionAt(request, repoB)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('webkit: a focused native select survives one Escape, the dialog leaves on the second; a keyboard change lands', async ({ page }) => {
  const [panel] = await openPanels(page, [sid])
  const dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  await shot(page, 'dense-light-webkit')

  // Escape with the select focused (after ArrowDown) does not close the dialog.
  const style = rowControl(dialog, 'claude', 'outputStyle')
  await style.scrollIntoViewIfNeeded()
  await style.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await shot(page, 'webkit-select-tolerance')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  // A keyboard change through the native select updates the row's status line.
  const again = await openPopover(page, panel)
  await waitForRows(again)
  const select = rowControl(again, 'claude', 'outputStyle')
  await select.scrollIntoViewIfNeeded()
  await select.selectOption('Learning')
  await expect(again).toBeVisible()
  await expect(popoverRow(again, 'outputStyle').locator('.engine-setting-status')).toHaveText(/^Set in /)
  await expect.poll(() => readLocal(repo)).toEqual({ outputStyle: 'Learning' })
  await again.getByTestId('engine-setting-reset-outputStyle').click()
  await expect.poll(() => readLocal(repo)).toEqual({})

  // Dark theme shot of the same dense view.
  await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'dark'); document.documentElement.setAttribute('data-theme', 'dark') })
  await shot(page, 'dense-dark-webkit')
  await page.evaluate(() => { localStorage.setItem('open-walnut-theme', 'light'); document.documentElement.setAttribute('data-theme', 'light') })
  await page.keyboard.press('Escape')
})

test('webkit: a text draft commits on the outside click that closes the dialog', async ({ page, request }) => {
  const home = await fixtureHome(request)
  const [panel] = await openPanels(page, [sid])
  const dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  const language = rowControl(dialog, 'claude', 'language')
  await language.scrollIntoViewIfNeeded()
  await language.fill('zh-TW')
  const patch = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/api/engines/claude/settings'))
  await clickComposerOutside(panel, dialog)
  expect((await patch).postDataJSON()).toEqual({ set: { language: 'zh-TW' } })
  await expect.poll(async () => (await readClaudeSettings(home)).language).toBe('zh-TW')
  await expect(dialog).toHaveCount(0)
  await expect(composerTextarea(panel)).toBeFocused()
})

test('webkit: no focus ring around the dialog on a mouse open; Escape closes after a save', async ({ page, request }) => {
  const home = await fixtureHome(request)
  const [panel] = await openPanels(page, [sid])
  const dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  // The root took programmatic focus (its name is announced) but paints no ring.
  const ring = await dialog.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { focused: document.activeElement === el, outline: cs.outlineStyle, shadow: cs.boxShadow }
  })
  expect(ring.focused).toBe(true)
  expect(ring.outline).toBe('none')
  expect(ring.shadow).not.toMatch(/0px 0px 0px 2px/)
  await shot(page, 'dense-light-webkit-no-ring')

  // in WebKit: after a save, Escape still closes and focus returns to "+".
  const thinking = rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
  await thinking.click()
  await expect(savedLine(dialog)).toHaveText(savedUserSentence)
  await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(false)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await plusButton(panel).evaluate((el) => el === document.activeElement)).toBe(true)
  // Seed back.
  const again = await openPopover(page, panel)
  await waitForRows(again)
  await rowControl(again, 'claude', 'alwaysThinkingEnabled').click()
  await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(true)
  await page.keyboard.press('Escape')
})

test('webkit: the rightmost column\'s popover clamps to the viewport edge', async ({ page }) => {
  const [panelA, panelB] = await openPanels(page, [sid, sidB])
  const vw = page.viewportSize()!.width
  const plusA = await plusButton(panelA).boundingBox()
  const plusB = await plusButton(panelB).boundingBox()
  const dialog = await openPopover(page, panelB)
  await waitForRows(dialog)
  const d = (await dialog.boundingBox())!
  expect(d.x + d.width).toBeLessThanOrEqual(vw - 12 + 0.5)
  expect(d.x + d.width).toBeGreaterThanOrEqual(vw - 12 - 1)
  expect(d.x).toBeLessThanOrEqual(plusB!.x + 0.5)
  // At 620 wide the box overlaps the neighbouring column; what N3 fixed is
  // pinned by the pair above (covers its own "+", right edge at the margin).
  expect(d.x + d.width).toBeGreaterThan(plusB!.x + plusB!.width)
  await shot(page, 'fix-two-cols-right-webkit')
  await page.keyboard.press('Escape')
})
