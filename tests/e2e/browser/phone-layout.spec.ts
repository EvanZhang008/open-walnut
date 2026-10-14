/**
 * The web console on a phone (iPhone 15 emulation: 393px wide, touch, mobile).
 *
 * The report: "the UI on phone looks so bad, the page is not even full". On a
 * phone the task panel was a 40% band over an empty 60% (the chat starts hidden),
 * the floating menu button covered the task search and every full-bleed page's
 * heading, the drawer opened as the desktop icon rail, a task panel hidden on the
 * desktop (a synced flag) left the phone an empty page, Notes kept a 260px tree
 * beside a 130px editor, and every field was under 16px, so iOS zoomed the page in
 * on focus. These pin the phone layout: one surface at a time under a top bar.
 *
 * Runs on both engines: `--project chromium` and `PW_WEBKIT=1 --project webkit`
 * (iOS Safari is WebKit). The first load of each test is a `goto`; everything
 * after it is a real tap.
 */
import fs from 'node:fs/promises'
import { devices, expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const SHOTS = '/tmp/phone-layout'
const PHONE = devices['iPhone 15']
const TOPBAR_H = 44
/** The fixture session opened from the board (read only: nothing is sent to it). */
const SESSION_TASK_TITLE = 'Quarterly invoice reconciliation'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
  ...(process.env.PW_VIDEO ? { video: { mode: 'on' as const, size: PHONE.viewport } } : {}),
})

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true })
})

/**
 * Layout flags ride ui-prefs to the SHARED fixture server, so every test isolates
 * the mirror and seeds its own starting flags once per test (not on every load).
 * The defaults are the reporting user's: chat hidden, the desktop rail collapsed,
 * a narrow desktop task panel.
 */
async function bootPhone(page: Page, prefs: Record<string, string> = {}): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript((seed) => {
    try {
      if (sessionStorage.getItem('phone-layout-seeded')) return
      sessionStorage.setItem('phone-layout-seeded', '1')
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value)
    } catch { /* storage off */ }
  }, {
    'open-walnut-home-chat-visible': 'false',
    'open-walnut-sidebar-collapsed': 'true',
    'open-walnut-todo-width': '20.9',
    ...prefs,
  })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  return pageErrors
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/spec-${info.project.name}-${name}.png`, scale: 'css' })
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible()
  const b = await locator.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

async function viewport(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

/** Nothing on the page is wider than the phone. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement!.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  expect(scrollWidth, 'the page scrolls sideways').toBeLessThanOrEqual(innerWidth)
}

/** `surface` covers the whole screen under the top bar. */
async function expectFillsUnderTopBar(page: Page, surface: Locator): Promise<void> {
  const vp = await viewport(page)
  await expect.poll(async () => Math.round((await surface.boundingBox())?.y ?? -1)).toBe(TOPBAR_H)
  const b = await box(surface)
  expect(b.x).toBeLessThanOrEqual(0.5)
  expect(Math.abs(b.width - vp.width)).toBeLessThanOrEqual(1)
  expect(Math.abs(b.y + b.height - vp.height), 'the surface reaches the bottom of the screen').toBeLessThanOrEqual(1)
}

/** The field is at least 16px, so iOS Safari does not zoom the page when it takes focus. */
async function expectNoFocusZoom(field: Locator): Promise<void> {
  const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  expect(size, 'font size of a field (iOS zooms in under 16px)').toBeGreaterThanOrEqual(16)
}

function intersects(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

const toggle = (page: Page) => page.getByRole('button', { name: 'Toggle sidebar' })
const drawer = (page: Page) => page.locator('#primary-sidebar')
const board = (page: Page) => page.locator('.main-page-todo')
const topbarTitle = (page: Page) => page.locator('.phone-topbar-title')

async function openDrawer(page: Page): Promise<void> {
  await toggle(page).click()
  await expect(drawer(page)).toHaveClass(/\bopen\b/)
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true')
}

async function expectDrawerClosed(page: Page): Promise<void> {
  await expect(drawer(page)).not.toHaveClass(/\bopen\b/)
  await expect(drawer(page)).toBeHidden()
  await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false')
}

test('the task panel fills the screen under a top bar that covers nothing', async ({ page }, info) => {
  const errors = await bootPhone(page)
  await page.goto('/')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })

  await expect(topbarTitle(page)).toHaveText('Home')
  const vp = await viewport(page)
  expect(Math.round((await box(page.locator('.app-shell'))).height)).toBe(vp.height)
  await expectFillsUnderTopBar(page, board(page))
  await expectNoHorizontalOverflow(page)

  // The menu button has its own bar; it used to sit on the search field.
  const search = page.locator('.todo-search-input')
  expect(intersects(await box(toggle(page)), await box(search)), 'menu button covers the task search').toBe(false)
  expect((await box(search)).y).toBeGreaterThanOrEqual(TOPBAR_H)
  // A finger-sized menu button.
  const toggleBox = await box(toggle(page))
  expect(toggleBox.width).toBeGreaterThanOrEqual(40)
  expect(toggleBox.height).toBeGreaterThanOrEqual(36)
  await expectNoFocusZoom(search)
  // Hiding the home screen has nothing to show instead on a phone.
  await expect(page.locator('.todo-panel-hide')).toBeHidden()

  await shot(page, info, 'home')
  expect(errors).toEqual([])
})

test('a task panel hidden on the desktop still shows, and answers taps, on a phone', async ({ page }, info) => {
  const errors = await bootPhone(page, { 'open-walnut-home-todo-visible': 'false' })
  await page.goto('/')
  await expect(board(page)).toBeVisible({ timeout: 30_000 })
  await expect(board(page)).not.toHaveClass(/\bcollapsed\b/)
  await expectFillsUnderTopBar(page, board(page))
  // Not inert: the search takes a tap and typing.
  const search = page.locator('.todo-search-input')
  await search.click()
  await search.fill('invoice')
  await expect(search).toHaveValue('invoice')
  await shot(page, info, 'hidden-panel-flag')
  expect(errors).toEqual([])
})

test('the drawer opens with labels under the bar and closes from the button, the backdrop and a link', async ({ page }, info) => {
  const errors = await bootPhone(page)
  await page.goto('/')
  await expect(toggle(page)).toBeVisible({ timeout: 30_000 })
  await expectDrawerClosed(page)

  await openDrawer(page)
  const vp = await viewport(page)
  const d = await box(drawer(page))
  expect(d.x).toBeLessThanOrEqual(0.5)
  expect(Math.round(d.y), 'the drawer opens under the bar').toBe(TOPBAR_H)
  expect(Math.abs(d.y + d.height - vp.height)).toBeLessThanOrEqual(1)
  // The synced desktop "collapsed" rail does not reach the drawer: labels show.
  expect(d.width).toBeGreaterThanOrEqual(200)
  await expect(drawer(page)).not.toHaveClass(/\bcollapsed\b/)
  const settingsLink = drawer(page).getByRole('link', { name: 'Settings' })
  await expect(settingsLink.locator('.sidebar-label')).toBeVisible()
  // The opaque drawer: the desktop glass let the task list read through it.
  const background = await drawer(page).evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(background).not.toMatch(/rgba\(.*,\s*0(\.\d+)?\)|\/\s*0?\.\d+\)/)
  await shot(page, info, 'drawer')

  // 1. The same button closes it.
  await toggle(page).click()
  await expectDrawerClosed(page)

  // 2. A tap on the dimmed page beside it closes it.
  await openDrawer(page)
  await page.locator('.sidebar-overlay').click({ position: { x: vp.width - 24, y: vp.height / 2 } })
  await expectDrawerClosed(page)

  // 3. A link navigates and closes it; the bar names the new page.
  await openDrawer(page)
  await settingsLink.click()
  await expect(page).toHaveURL(/\/settings/)
  await expectDrawerClosed(page)
  await expect(topbarTitle(page)).toHaveText('Settings')
  await expect(page.locator('.settings-container')).toBeVisible()
  expect((await box(page.locator('.settings-container'))).y).toBeGreaterThanOrEqual(TOPBAR_H - 0.5)
  await expectNoHorizontalOverflow(page)
  await shot(page, info, 'settings')
  expect(errors).toEqual([])
})

test('a task opens its session full screen with the composer in view, and closing it returns to the board', async ({ page }, info) => {
  const errors = await bootPhone(page)
  await page.goto('/')
  const search = page.locator('.todo-search-input')
  await expect(search).toBeVisible({ timeout: 30_000 })
  await search.click()
  await search.fill('Quarterly invoice')
  const row = page.locator('.todo-item-title', { hasText: SESSION_TASK_TITLE }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()

  const column = page.locator('.main-page-session-column.is-mobile-active')
  const panel = column.locator('.session-panel')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expectFillsUnderTopBar(page, page.locator('.main-page-sessions-area'))
  await expect(panel.locator('.session-panel-title')).toContainText(SESSION_TASK_TITLE)
  await expectNoHorizontalOverflow(page)

  // One column on screen: lock and expand have nothing to do here.
  await expect(panel.locator('.session-panel-lock')).toBeHidden()
  await expect(panel.locator('.session-panel-expand')).toBeHidden()

  // The composer sits inside the screen, takes typing, and does not zoom iOS.
  const composer = panel.locator('.chat-input-textarea')
  const vp = await viewport(page)
  const c = await box(composer)
  expect(c.y + c.height, 'the composer is above the bottom of the screen').toBeLessThanOrEqual(vp.height)
  expect(c.x).toBeGreaterThanOrEqual(0)
  expect(c.x + c.width).toBeLessThanOrEqual(vp.width)
  await composer.click()
  await composer.fill('typed on a phone, not sent')
  await expect(composer).toHaveValue('typed on a phone, not sent')
  await expectNoFocusZoom(composer)
  await composer.fill('')
  await shot(page, info, 'session')

  const close = panel.getByRole('button', { name: 'Close session panel' })
  const closeBox = await box(close)
  expect(closeBox.width).toBeGreaterThanOrEqual(44)
  expect(closeBox.height).toBeGreaterThanOrEqual(44)
  await close.click()
  await expect(column).toHaveCount(0)
  await expectFillsUnderTopBar(page, board(page))
  expect(errors).toEqual([])
})

test('a new task started on the phone answers, and a follow-up sends from the composer', async ({ page }, info) => {
  test.setTimeout(90_000)
  const errors = await bootPhone(page)
  await page.goto('/')
  await expect(page.locator('.new-launcher-btn')).toBeVisible({ timeout: 30_000 })
  await page.locator('.new-launcher-btn').click()

  const draft = page.locator('.main-page-session-column.is-mobile-active .draft-session-panel')
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expectFillsUnderTopBar(page, page.locator('.main-page-sessions-area'))
  await draft.locator('.draft-quick-chip', { hasText: /^walnut$/ }).first().click()

  const prompt = `phone layout spec ${info.project.name} ${Date.now()}`
  const draftInput = draft.locator('.chat-input-textarea')
  await expectNoFocusZoom(draftInput)
  await draftInput.click()
  await draftInput.fill(prompt)
  const started = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await draftInput.press('Enter')
  const startedResponse = await started
  expect(startedResponse.status()).toBe(200)
  const { taskId } = await startedResponse.json() as { taskId: string }

  try {
    const panel = page.locator(
      '.main-page-session-column.is-mobile-active .session-panel:not(.pending-session-panel):not(.draft-session-panel)',
    )
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByText(`Hello! I processed your message: ${prompt}`)).toBeVisible({ timeout: 30_000 })

    const followUp = `${prompt} follow-up`
    const composer = panel.locator('.chat-input-textarea')
    await composer.click()
    await composer.fill(followUp)
    await composer.press('Enter')
    await expect(panel.getByText(`Hello! I processed your message: ${followUp}`)).toBeVisible({ timeout: 30_000 })
    const vp = await viewport(page)
    const c = await box(composer)
    expect(c.y + c.height).toBeLessThanOrEqual(vp.height)
    await expectFillsUnderTopBar(page, page.locator('.main-page-sessions-area'))
    await expectNoHorizontalOverflow(page)
    await shot(page, info, 'sent')
    expect(errors).toEqual([])
  } finally {
    // The shared fixture board keeps no trace of this test's task.
    await page.request.delete(`/api/focus/tasks/${taskId}`)
    await page.request.delete(`/api/tasks/${taskId}?force=true`)
  }
})

test('Ask Walnut opens from the drawer over the board, and its close comes back to the board', async ({ page }, info) => {
  const errors = await bootPhone(page)
  await page.goto('/')
  await expect(toggle(page)).toBeVisible({ timeout: 30_000 })
  await openDrawer(page)
  // The home screen cannot be hidden on a phone, so its drawer toggle is not there.
  await expect(drawer(page).locator('.app-task-panel-toggle')).toBeHidden()
  await drawer(page).getByRole('button', { name: 'Ask Walnut', exact: true }).click()
  // A panel toggle is navigation on a phone: the drawer gets out of the way.
  await expectDrawerClosed(page)

  const chat = page.locator('.main-page-chat')
  await expect(page.locator('[data-testid="ask-walnut-slot"]')).toBeVisible({ timeout: 15_000 })
  await expectFillsUnderTopBar(page, chat)
  const composer = chat.locator('.chat-input-textarea').first()
  const vp = await viewport(page)
  const c = await box(composer)
  expect(c.y + c.height).toBeLessThanOrEqual(vp.height)
  await expectNoFocusZoom(composer)
  await expectNoHorizontalOverflow(page)
  await shot(page, info, 'ask-walnut')

  // Its own list of asks fits the phone.
  await chat.locator('[data-testid="ask-walnut-menu"]').click()
  const asks = page.locator('[data-testid="ask-walnut-drawer"]')
  await expect(asks).toBeVisible()
  // It slides in from the left edge; measure where it settles.
  await expect.poll(async () => (await asks.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0)
  const a = await box(asks)
  expect(a.x + a.width).toBeLessThanOrEqual(vp.width + 0.5)
  await page.keyboard.press('Escape')
  await expect(asks).toBeHidden()

  await chat.getByRole('button', { name: 'Close session panel' }).first().click()
  await expect(chat).toHaveClass(/\bcollapsed\b/)
  await expectFillsUnderTopBar(page, board(page))
  expect(errors).toEqual([])
})

test('Notes shows the tree or the open note, never both squeezed, with a way back', async ({ page }, info) => {
  const errors = await bootPhone(page)
  await page.goto('/')
  await expect(toggle(page)).toBeVisible({ timeout: 30_000 })
  await openDrawer(page)
  await drawer(page).getByRole('link', { name: 'Notes' }).click()
  await expect(topbarTitle(page)).toHaveText('Notes')

  const tree = page.locator('.notes-tree-pane')
  const editor = page.locator('.notes-editor-pane')
  const vp = await viewport(page)
  await expect(tree).toBeVisible({ timeout: 15_000 })
  expect(Math.abs((await box(tree)).width - vp.width)).toBeLessThanOrEqual(1)
  expect((await box(tree)).y).toBeGreaterThanOrEqual(TOPBAR_H - 0.5)
  await expect(editor).toBeHidden()

  await tree.getByText('vault-note', { exact: true }).first().click()
  await expect(editor).toBeVisible()
  await expect(tree).toBeHidden()
  expect(Math.abs((await box(editor)).width - vp.width)).toBeLessThanOrEqual(1)
  await expect(editor.getByText('VAULT_NOTE_MARKER')).toBeVisible({ timeout: 15_000 })
  await expectNoHorizontalOverflow(page)
  await shot(page, info, 'notes-editor')

  await editor.getByRole('button', { name: 'All notes' }).click()
  await expect(tree).toBeVisible()
  await expect(editor).toBeHidden()
  expect(errors).toEqual([])
})

test('Calendar opens on one day with the task list closed, and the list opens over the grid', async ({ page }, info) => {
  const errors = await bootPhone(page)
  await page.goto('/')
  await expect(toggle(page)).toBeVisible({ timeout: 30_000 })
  await openDrawer(page)
  await drawer(page).getByRole('link', { name: 'Calendar' }).click()
  await expect(topbarTitle(page)).toHaveText('Calendar')

  const cal = page.locator('.cal-page')
  await expect(cal).toHaveAttribute('data-view', 'day', { timeout: 15_000 })
  await expect(page.locator('[data-testid="cal-rail"]')).toHaveCount(0)
  const vp = await viewport(page)
  const c = await box(cal)
  expect(Math.round(c.y)).toBe(TOPBAR_H)
  expect(c.y + c.height, 'the page ends at the bottom of the screen').toBeLessThanOrEqual(vp.height + 0.5)
  // The toolbar's buttons no longer draw over each other.
  const today = await box(page.locator('.cal-today-btn'))
  const prev = await box(page.getByRole('button', { name: 'Previous' }))
  expect(intersects(today, prev)).toBe(false)
  await expectNoHorizontalOverflow(page)
  await shot(page, info, 'calendar')

  await page.getByRole('button', { name: 'Show task list' }).click()
  const rail = page.locator('[data-testid="cal-rail"]')
  const r = await box(rail)
  expect(r.x).toBeGreaterThanOrEqual(0)
  expect(r.x + r.width).toBeLessThanOrEqual(vp.width)
  await page.getByRole('button', { name: 'Hide task list' }).click()
  await expect(rail).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the sign-in notice a fresh phone sees fits the screen', async ({ page }, info) => {
  await bootPhone(page)
  // Every API call refused the way the primary refuses an unpaired browser.
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'not paired', code: 'not_paired' }),
  }))
  await page.goto('/')
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  const vp = await viewport(page)
  const n = await box(notice)
  expect(n.x).toBeGreaterThanOrEqual(0)
  expect(n.x + n.width).toBeLessThanOrEqual(vp.width)
  expect(n.y).toBeGreaterThanOrEqual(TOPBAR_H)
  expect(n.y + n.height).toBeLessThanOrEqual(vp.height)
  const input = page.getByTestId('unpaired-code-input')
  await expectNoFocusZoom(input)
  await input.click()
  await input.fill('ABCD-EFGH')
  await expect(page.getByTestId('unpaired-code-submit')).toBeEnabled()
  await expectNoHorizontalOverflow(page)
  await shot(page, info, 'sign-in-notice')
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, userAgent: undefined, screen: undefined })

  test('a desktop window keeps its layout: no top bar, the rail beside the page, the task panel a column', async ({ page }, info) => {
    const errors = await bootPhone(page)
    await page.goto('/')
    await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.phone-topbar')).toBeHidden()
    await expect(toggle(page)).toBeHidden()
    expect(await page.locator('.main-content').evaluate((el) => getComputedStyle(el).paddingTop)).toBe('0px')
    const rail = await box(drawer(page))
    expect(rail.y).toBe(0)
    expect(rail.width).toBeLessThan(80)
    const panel = await box(board(page))
    expect(panel.x).toBeGreaterThanOrEqual(rail.width - 1)
    expect(panel.y).toBe(0)
    expect(panel.width).toBeLessThan(640)
    await expect(page.locator('.todo-panel-hide')).toBeVisible()
    await shot(page, info, 'desktop-home')
    expect(errors).toEqual([])
  })
})
