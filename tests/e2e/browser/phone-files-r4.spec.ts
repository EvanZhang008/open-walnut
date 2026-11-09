/**
 * One file on a phone (C19, C28): the file viewer's document bar is one row of
 * 44 px targets with 12 px+ words that scrolls sideways rather than cutting a
 * control at the edge (since "Document first", 2026-11-06, the rare actions
 * are behind ⋯), and an editable document is 16 px so iOS does not zoom on
 * focus.
 * The session is stubbed; the file is a markdown file of this checkout, only
 * listed and read. WebKit with devices['iPhone 15'] first, chromium too.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { docBarSettled } from './doc-bar-helpers'
import { PHONE, findSmallTargets, findSmallText } from './phone-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID = 'pw-question-recovery-session'
const TASK_ID = 'pw-task-question-recovery'
const SHOTS = '/tmp/mobile-web/phone-files-r4'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.setTimeout(120_000)

const iso = (ago: number) => new Date(Date.now() - ago).toISOString()
const overlay = (p: Page) => p.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SID}"]`)
const topbar = (p: Page) => p.locator('.phone-topbar')

test('C19, C28: a markdown file: 44 px document bar targets in one sideways row, 16 px editor', async ({ page }) => {
  const cwd = `${process.cwd()}/docs/reference`
  await isolateUiPrefs(page)
  await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* off */ } })
  await page.route(`**/api/sessions/${SID}`, (route: Route) => route.fulfill({ json: {
    session: { cwd, claudeSessionId: SID, taskId: TASK_ID, project: 'Walnut', process_status: 'idle', mode: 'default', startedAt: iso(600_000), lastActiveAt: iso(5_000), messageCount: 2, title: 'Files fixture' },
    pendingPermissions: [],
  } }))
  const messages = [{ role: 'user', text: 'Read the reference', timestamp: iso(60_000), msgId: 'u-1' }, { role: 'assistant', text: 'Done.', timestamp: iso(50_000), msgId: 'a-1' }]
  await page.route(`**/api/sessions/${SID}/history**`, (route: Route) => route.fulfill({ json: { messages, cursor: 2, delta: false } }))
  await page.goto(`/?s1=${SID}`)
  await expect(overlay(page)).toBeVisible({ timeout: 30_000 })
  await topbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByTestId('phone-row-files').click()
  const body = overlay(page).locator('.session-file-explorer-body')
  await expect(body).toHaveClass(/is-phone-tree/, { timeout: 15_000 })
  const md = body.locator('.session-file-explorer-node').filter({ has: page.locator('.sfe-name', { hasText: /\.md$/ }) }).first()
  await expect(md).toBeVisible({ timeout: 15_000 })
  await md.click()
  await expect(body).toHaveClass(/is-phone-file/)
  const BAR = '.file-content-view .fv-doc-bar'
  const bar = page.locator(BAR).first()
  await expect(bar).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(500)
  // A phone's bar is narrow (data-fit="tight"): Preview / Source is one icon
  // switch and the rare actions are behind ⋯, so every control is a button.
  // A name that would be cut even so moves the switch into ⋯ too (data-fold 4).
  await expect(bar).toHaveAttribute('data-fit', 'tight')
  await docBarSettled(bar)
  if ((await bar.getAttribute('data-fold')) !== '4') await expect(bar.getByRole('button', { name: 'Show source' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'More file actions' })).toBeVisible()
  // The file's name is said once, in the doc bar; the top bar names its folder.
  const fileName = (await bar.locator('.sfe-crumb.is-last').innerText()).trim()
  expect(fileName).toMatch(/\.md$/)
  await expect(topbar(page).locator('.phone-topbar-title-text')).not.toHaveText(fileName)
  // The path (.sfe-crumbs) gives way with an ellipsis by design; every other
  // control shows its words whole.
  const tabs = await bar.locator('button:not(.sfe-crumbs)').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetWidth > 0).map((e) => {
    return { text: (e.textContent || '').trim() || e.getAttribute('aria-label') || '', words: !e.querySelector('svg') && !!(e.textContent || '').trim(), font: parseFloat(getComputedStyle(e).fontSize), cut: e.scrollWidth > e.clientWidth + 1 }
  }))
  expect(tabs.length).toBeGreaterThan(1)
  // Every control's words are 12 px+ and none is cut; the finger-size rule
  // (a 44 px box, or 44 px of tap area around it) is findSmallTargets below.
  for (const t of tabs) {
    if (t.words) expect(t.font, t.text).toBeGreaterThanOrEqual(12)
    expect(t.cut, t.text).toBe(false)
  }
  // The row scrolls itself: the page has no sideways overflow.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(await findSmallText(page, 12, BAR)).toEqual([])
  expect(await findSmallTargets(page, BAR)).toEqual([])
  // Any editable document in the viewer is 16 px or more.
  const editors = await page.locator('.ProseMirror[contenteditable="true"]').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)))
  expect(editors.length, 'the markdown preview is an editable document').toBeGreaterThan(0)
  for (const px of editors) expect(px).toBeGreaterThanOrEqual(16)
  await page.screenshot({ path: `${SHOTS}/c19-file-${test.info().project.name}.png` })
  // ⋯ on a phone: a solid menu (not see-through over the document) that fits
  // the screen, holding Back / Forward and the rare actions.
  await bar.getByRole('button', { name: 'More file actions' }).click()
  const menu = page.getByTestId('fv-more-menu')
  await expect(menu).toBeVisible()
  const bg = await menu.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg, 'the menu background is opaque').not.toMatch(/rgba\([^)]*,\s*0?\.\d+\)|transparent/)
  const box = (await menu.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.viewport.width + 1)
  await expect(menu.getByRole('menuitem', { name: 'Copy path' })).toBeVisible()
  // Finder and the default app open on the Mac, out of a phone's sight: not offered here.
  await expect(menu.getByRole('menuitem', { name: /Reveal in Finder|Open in default app/ })).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/c19-more-menu-${test.info().project.name}.png` })
  await page.keyboard.press('Escape')
})
