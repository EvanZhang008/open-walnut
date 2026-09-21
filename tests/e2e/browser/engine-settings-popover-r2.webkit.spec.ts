/**
 * Review round two of the engine settings popover in WEBKIT (the Mac app is a
 * WKWebView): the saved sentence and the error stay inside the box (
 *), the repo segment of the subtitle survives every width, focus
 * lands on the toggled switch after a save even though WebKit does not focus a
 * button on click, and Escape from a clean text input closes.
 *
 * Run: PW_WEBKIT=1 npx playwright test tests/e2e/browser/engine-settings-popover-r2.webkit.spec.ts --project=webkit
 */
import { test, expect, type Locator } from '@playwright/test'
import path from 'node:path'
import { fixtureHome, readClaudeSettings } from './engine-settings-helpers'
import {
  HOST_LABEL, banner, claimUserFile, fixtureRoot, makeGitProject, openPanels, openPopover, plusButton, readLocal, rect, restoreSeed,
  rowControl, rowsArea, rowsGeometry, savedLine, savedProjectBase, scopeOption, shortCwd, shot, startSessionAt, stubPatch, waitForRows,
} from './engine-settings-popover-helpers'

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })
test.setTimeout(90_000)

let repo = ''
let sid = ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  await claimUserFile(request)
  const root = await fixtureRoot()
  repo = await makeGitProject(root, `r2wk-repo-${Date.now().toString(36)}`)
  sid = await startSessionAt(request, repo)
})

test.afterAll(async ({ request }) => { await restoreSeed(request) })

const fits = (loc: Locator) => loc.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)

async function expectInside(inner: Locator, outer: Locator, label: string): Promise<void> {
  const i = await rect(inner)
  const o = await rect(outer)
  expect(i.left, `${label} left`).toBeGreaterThanOrEqual(o.left - 0.5)
  expect(i.right, `${label} right`).toBeLessThanOrEqual(o.right + 0.5)
  expect(i.top, `${label} top`).toBeGreaterThanOrEqual(o.top - 0.5)
  expect(i.bottom, `${label} bottom`).toBeLessThanOrEqual(o.bottom + 0.5)
}

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('webkit: rows over half the box; the repo segment shows at 1280 and at 420 wide', async ({ page }) => {
  for (const [w, h] of [[1280, 800], [420, 700]] as const) {
    await page.setViewportSize({ width: w, height: h })
    const [panel] = await openPanels(page, [sid])
    const dialog = await openPopover(page, panel)
    await waitForRows(dialog)
    const d = await rect(dialog)
    const geometry = await rowsGeometry(dialog)
    test.info().annotations.push({ type: 'measurement', description: `webkit ${w}x${h}: dialog ${Math.round(d.height)}px, rows ${geometry.area.height}px, visible ${geometry.visible}` })
    if (w === 1280) {
      expect(geometry.area.height, JSON.stringify(geometry)).toBeGreaterThan(d.height / 2)
      expect(geometry.visible).toBeGreaterThanOrEqual(3)
    }
    const tail = dialog.locator('.engine-settings-subtitle-tail')
    await expect(tail).toHaveText(path.basename(repo))
    expect(await tail.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `tail fits at ${w}`).toBe(true)
    await expect(dialog.locator('.engine-settings-popover-subtitle')).toHaveText(`${HOST_LABEL} · ${shortCwd(repo)}`)
    await shot(page, `r3/webkit-fit-${w}x${h}`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  }
})

test('webkit: the saved sentence and a long error stay inside the box; focus lands on the toggled switch', async ({ page, request }) => {
  const home = await fixtureHome(request)
  await page.setViewportSize({ width: 1280, height: 800 })
  const [panel] = await openPanels(page, [sid])
  const dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  const rowsBefore = await rect(rowsArea(dialog))

  // WebKit does not focus a button on click; after the save lands, focus is on the switch anyway.
  const thinking = () => rowControl(dialog, 'claude', 'alwaysThinkingEnabled')
  await thinking().click()
  await expect(savedLine(dialog)).toHaveText(/^Saved to user settings/)
  expect((await rect(rowsArea(dialog))).top).toBeCloseTo(rowsBefore.top, 0)
  await expect.poll(() => page.evaluate(() => {
    const a = document.activeElement
    return a ? `${a.tagName.toLowerCase()}${a.getAttribute('role') ? `[${a.getAttribute('role')}]` : ''}` : 'none'
  })).toBe('button[switch]')
  await thinking().click()
  await expect.poll(async () => (await readClaudeSettings(home)).alwaysThinkingEnabled).toBe(true)

  // A project save's three-clause sentence wraps inside the popover; nothing is cut at the edge.
  await scopeOption(dialog, 'project').click()
  await expect(scopeOption(dialog, 'project')).toHaveAttribute('aria-checked', 'true')
  await waitForRows(dialog)
  // The project note is a line longer (one reflow on the switch); the save itself must not move the rows' top.
  const rowsProject = await rect(rowsArea(dialog))
  await rowControl(dialog, 'claude', 'outputStyle').selectOption('Learning')
  await expect.poll(async () => (await readLocal(repo))?.outputStyle).toBe('Learning')
  const line = savedLine(dialog)
  await expect(line).toHaveText(new RegExp(`^${savedProjectBase(repo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Created `))
  const lineBox = await rect(line)
  const d = await rect(dialog)
  expect(lineBox.right).toBeLessThanOrEqual(d.right - 8)
  expect(lineBox.height).toBeLessThanOrEqual(3 * 17.4 + 2)
  expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  expect((await rect(rowsArea(dialog))).top).toBeCloseTo(rowsProject.top, 0)
  const clipped = await line.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  const more = dialog.getByTestId('engine-settings-status-more')
  if (clipped) {
    await expect(more).toBeVisible()
    await expectInside(more, dialog, 'More')
    await more.click()
  } else {
    await expect(more).toHaveCount(0)
  }
  expect(await fits(line)).toBe(true)
  await shot(page, 'r3/webkit-saved-project')
  await dialog.getByTestId('engine-setting-reset-outputStyle').click()
  await expect(savedLine(dialog)).toHaveText('Removed Output style from this project (local); the user settings value applies again.')
  await expect.poll(async () => (await readLocal(repo))?.outputStyle).toBeUndefined()

  // A long error wraps in full; Dismiss is inside the popover and takes a real click.
  const long = 'The daemon on this Mac did not answer within 10 seconds; the file may or may not have been written.'
  const down = await stubPatch(page, { status: 502, body: { error: long, outcome: 'unknown' } }, { times: 1 })
  await thinking().click()
  const alert = banner(dialog)
  await expect(alert).toHaveText(long)
  expect(await fits(alert.locator('span'))).toBe(true)
  const dismiss = alert.locator('button[aria-label="Dismiss"]')
  await expectInside(dismiss, dialog, 'Dismiss')
  await shot(page, 'r3/webkit-save-failed-502')
  await dismiss.click()
  await expect(alert).toHaveCount(0)
  await down.unroute()
  await expect(thinking()).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
})

test('webkit: Escape from a clean text input closes; the draft guard sits under the switch', async ({ page, request }) => {
  const home = await fixtureHome(request)
  const [panel] = await openPanels(page, [sid])
  const dialog = await openPopover(page, panel)
  await waitForRows(dialog)
  const language = rowControl(dialog, 'claude', 'language')
  await language.scrollIntoViewIfNeeded()
  await language.fill('zz-draft')
  const switchBox = await rect(dialog.locator('.engine-settings-scope[role=radiogroup]'))
  await scopeOption(dialog, 'project').click()
  await expect(scopeOption(dialog, 'default')).toHaveAttribute('aria-checked', 'true')
  const guard = dialog.locator('.engine-settings-draft-guard')
  await expect(guard).toBeVisible()
  const guardBox = await rect(guard)
  expect(guardBox.top).toBeGreaterThanOrEqual(switchBox.bottom - 1)
  expect(guardBox.top - switchBox.bottom).toBeLessThanOrEqual(40)
  await language.focus()
  await language.press('Escape')
  await expect(language).toHaveValue('Chinese')
  await expect(dialog).toBeVisible()
  await language.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await plusButton(panel).evaluate((el) => el === document.activeElement)).toBe(true)
  expect((await readClaudeSettings(home)).language).toBe('Chinese')
})
