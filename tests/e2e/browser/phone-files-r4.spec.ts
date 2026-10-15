/**
 * One file on a phone (C19, C28): the file viewer's toolbar is a row of 44 px
 * buttons with 12 px+ words that scrolls sideways (Copy Path is never cut at
 * the edge), and an editable document is 16 px so iOS does not zoom on focus.
 * The session is stubbed; the file is a markdown file of this checkout, only
 * listed and read. WebKit with devices['iPhone 15'] first, chromium too.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
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

test('C19, C28: a markdown file: 44 px toolbar buttons in one sideways row, 16 px editor', async ({ page }) => {
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
  const bar = page.locator('.fv-html-toolbar').first()
  await expect(bar).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(500)
  const tabs = await bar.locator('.fv-html-tab').evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetWidth > 0).map((e) => {
    const r = e.getBoundingClientRect()
    return { text: (e.textContent || '').trim(), h: r.height, font: parseFloat(getComputedStyle(e).fontSize), cut: e.scrollWidth > e.clientWidth + 1 }
  }))
  expect(tabs.length).toBeGreaterThan(1)
  for (const t of tabs) {
    expect(t.h, t.text).toBeGreaterThanOrEqual(44)
    expect(t.font, t.text).toBeGreaterThanOrEqual(12)
    expect(t.cut, t.text).toBe(false)
  }
  // The row scrolls itself: the page has no sideways overflow.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  expect(await findSmallText(page, 12, '.fv-html-toolbar')).toEqual([])
  const small = (await findSmallTargets(page, '.fv-html-toolbar')).filter((s) => !/fv-dirty|fv-live-dot/.test(JSON.stringify(s)))
  expect(small).toEqual([])
  // Any editable document in the viewer is 16 px or more.
  const editors = await page.locator('.ProseMirror[contenteditable="true"]').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)))
  expect(editors.length, 'the markdown preview is an editable document').toBeGreaterThan(0)
  for (const px of editors) expect(px).toBeGreaterThanOrEqual(16)
  await page.screenshot({ path: `${SHOTS}/c19-file-${test.info().project.name}.png` })
})
