/**
 * Phone review fixes, round 3: the pages the drawer opens (Tasks, plugin
 * pages, Calendar day view, Routines) and the dark cached-history line
 * (N2-16, N2-17, N2-18, N2-19, N2-22). WebKit with devices['iPhone 15']
 * first, chromium too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, findSmallTargets, findSmallText, menuButton, openDrawer } from './phone-helpers'
import { cssColorToRgba } from './css-color'

const SHOTS = '/tmp/mobile-web/phone-pages-r3'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

// A/B proof that the tests pin the fixes: PW_PAGES_R3_WITHOUT_FIX=1 serves
// this round's and round 2's phone stylesheets empty (the dev server loads them
// as modules) and makes the Tasks app ignore the phone layout (N2-16).
test.beforeEach(async ({ page }) => {
  if (!process.env.PW_PAGES_R3_WITHOUT_FIX) return
  await page.route(/\/styles\/phone-(pages-r3|fixes-r2)\.css/, (route) => route.fulfill({ contentType: 'text/javascript', body: 'export {}' }))
  await page.route(/\/src\/apps\/core-apps\.tsx/, async (route) => {
    const response = await route.fetch()
    const body = (await response.text()).replace(/usePhoneLayout\(\)/g, 'false')
    await route.fulfill({ response, body })
  })
})

async function bootHome(page: Page): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  return errors
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, scale: 'css' })

async function openPage(page: Page, name: string): Promise<void> {
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name, exact: true }).click()
}

function localDay(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Four meetings at once, 9 to 11 today: the day column splits four ways. */
const OVERLAP_TITLES = [
  'Quarterly garden planning review',
  'Orchard irrigation weekly sync',
  'Canceled: Greenhouse supplier call',
  'Seed library office hours',
]

async function addOverlappingMeetings(page: Page): Promise<void> {
  await page.route('**/api/calendar/events?*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json() as { events: Record<string, unknown>[] }
    const calendarId = (body.events[0]?.calendarId as string | undefined) ?? 'cal-work'
    const day = localDay()
    OVERLAP_TITLES.forEach((title, i) => body.events.push({
      id: `eventkit:phone-overlap-${i}`, source: 'eventkit', calendarId, calendarName: 'Work',
      accountName: 'Local', title, start: `${day}T09:00:00`, end: `${day}T11:00:00`, allDay: false,
      location: 'Willow room, second floor', readonly: true,
    }))
    await route.fulfill({ response, json: body })
  })
}

test('N2-18: four meetings at once stay readable in the day view, and the hours toggle has a plain label', async ({ page }) => {
  await addOverlappingMeetings(page)
  const errors = await bootHome(page)
  await openPage(page, 'Calendar')
  const cal = page.locator('.cal-page').first()
  await expect(cal).toBeVisible({ timeout: 15_000 })
  const chips = cal.locator('.cal-grid-cols .cal-chip[data-item-id^="event:eventkit:phone-overlap-"]')
  await expect(chips).toHaveCount(4, { timeout: 15_000 })
  await chips.first().scrollIntoViewIfNeeded()
  const boxes = await chips.evaluateAll((els) => els.map((c) => {
    const r = c.getBoundingClientRect()
    const t = c.querySelector<HTMLElement>('.cal-chip-title')!
    const tr = t.getBoundingClientRect()
    const loc = c.querySelector<HTMLElement>('.cal-chip-location')
    return {
      width: r.width, titleHeight: tr.height, titleInside: tr.bottom <= r.bottom + 0.5,
      font: parseFloat(getComputedStyle(t).fontSize), cut: t.scrollWidth > t.clientWidth + 1,
      location: loc ? getComputedStyle(loc).display : 'none',
    }
  }))
  for (const b of boxes) {
    expect(b.width, JSON.stringify(b)).toBeLessThan(141)
    // The title wraps over at least two whole lines inside the chip, never one line cut to a few letters.
    expect(b.titleHeight, JSON.stringify(b)).toBeGreaterThanOrEqual(29)
    expect(b.titleInside, JSON.stringify(b)).toBe(true)
    expect(b.cut, JSON.stringify(b)).toBe(false)
    expect(b.font).toBeGreaterThanOrEqual(12)
    expect(b.location).toBe('none')
  }
  const tiny = await findSmallText(page, 12, '.cal-page')
  expect(tiny, JSON.stringify(tiny)).toEqual([])
  // The toolbar names the toggle; no range label with a dash.
  const toggle = page.locator('.cal-toolbar .cal-hours-toggle')
  await expect(toggle).toHaveText('24h')
  expect(await page.locator('.cal-toolbar').innerText()).not.toMatch(/[\u2013\u2014]/)
  await shot(page, 'n2-18-overlap')
  // A tap still opens the whole meeting.
  await chips.nth(1).tap()
  const pop = page.locator('.cal-item-popover')
  await expect(pop).toBeVisible()
  await expect(pop.locator('.cal-item-title')).toHaveValue(OVERLAP_TITLES[1])
  const pr = await pop.boundingBox()
  expect(pr!.x).toBeGreaterThanOrEqual(0)
  expect(pr!.x + pr!.width).toBeLessThanOrEqual(PHONE.viewport.width + 0.5)
  expect(errors).toEqual([])
})

test('N2-16: a phone that lands on /tasks gets the home task list, never the two-pane dashboard', async ({ page }) => {
  await isolateUiPrefs(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The first load is the link itself (a project mention, a bookmark, a deleted task's page).
  await page.goto('/tasks')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('tasks-rail')).toHaveCount(0)
  await expect(page.locator('.phone-topbar .phone-topbar-title-text')).not.toHaveText('Tasks')
  await openDrawer(page)
  await expect(page.locator('#primary-sidebar').getByRole('link', { name: 'Tasks', exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('N2-19: a routine card with an error keeps every line at 12 px and every control finger-sized', async ({ page }) => {
  // The fixture has no routines: add one whose last run failed, as the live list had.
  await page.route('**/api/routines?*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json() as { jobs: Record<string, unknown>[] }
    const now = Date.now()
    body.jobs.push({
      id: 'phone-routine-broken', name: 'Garden watering reminder', enabled: false,
      createdAtMs: now - 86_400_000, updatedAtMs: now - 3_600_000,
      schedule: { kind: 'every', everyMs: 300_000 }, wakeMode: 'now',
      executor: { type: 'agent', agentId: 'garden-helper' },
      state: { lastRunAtMs: now - 600_000, lastStatus: 'error', lastError: 'agent "garden-helper" not found', consecutiveErrors: 3 },
    })
    await route.fulfill({ response, json: body })
  })
  const errors = await bootHome(page)
  await openPage(page, 'Routines')
  const view = page.locator('.routines-view').first()
  await expect(view).toBeVisible({ timeout: 15_000 })
  const err = view.locator('.cron-job-error', { hasText: 'garden-helper' })
  await expect(err).toBeVisible({ timeout: 15_000 })
  await err.scrollIntoViewIfNeeded()
  expect(parseFloat(await err.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(12)
  const tiny = await findSmallText(page, 12, '.routines-view')
  expect(tiny, JSON.stringify(tiny)).toEqual([])
  const small = await findSmallTargets(page, '.routines-view')
  expect(small, JSON.stringify(small)).toEqual([])
  // One title (the bar's) and a description without a dash.
  await expect(page.locator('.page-header .page-title', { hasText: 'Routines' })).toBeHidden()
  expect(await page.locator('.page-header').innerText()).not.toMatch(/[\u2013\u2014]/)
  expect(await view.locator('textarea').first().evaluate((el) => getComputedStyle(el).resize)).toBe('none')
  await shot(page, 'n2-19-routine-error')
  expect(errors).toEqual([])
})

/**
 * Relative luminance of a computed color: `rgb(...)` / `rgba(...)`, or the
 * `color(srgb r g b)` a color-mix() computes to (css-color.ts reads both).
 */
function luminance(css: string): number {
  const [r, g, b] = cssColorToRgba(css).slice(0, 3).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('N2-22: in dark mode the cached-history line is a dark box with one clean sentence', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  const sid = 'pw-r3-stale-dark-session'
  const taskId = 'pw-r3-stale-dark-task'
  await isolateUiPrefs(page)
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  const messages = [
    { role: 'user', text: 'Count the seed packets in the shed', timestamp: iso(90_000), msgId: 'u-1' },
    { role: 'assistant', text: 'There are forty two packets on the second shelf.', timestamp: iso(89_000), msgId: 'a-1' },
  ]
  await page.route(`**/api/sessions/${sid}`, (route) => route.fulfill({ json: {
    session: { claudeSessionId: sid, taskId, project: 'Walnut', process_status: 'idle', mode: 'default', host: 'garden',
      startedAt: iso(600_000), lastActiveAt: iso(60_000), messageCount: messages.length, title: 'Seed packet count' },
    pendingPermissions: [],
  } }).catch(() => undefined))
  await page.route(`**/api/sessions/${sid}/history**`, (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('since') !== null) return route.fulfill({ status: 502, json: { error: 'Reconnecting to Garden box' } }).catch(() => undefined)
    return route.fulfill({ json: { messages, total: messages.length, stale: true, staleReason: 'Reconnecting to Garden box.' } }).catch(() => undefined)
  })
  await page.route(`**/api/tasks/${taskId}`, (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { task: {
      id: taskId, title: 'Seed packet count', status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none', project: 'Walnut',
      source: 'local', session_ids: [sid], session_id: sid, created_at: iso(86_400_000), updated_at: iso(60_000),
      description: '', summary: '', note: '', subtasks: [],
    } } })
    : route.fallback())
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The first load is the session's own link.
  await page.goto(`/?s1=${sid}`)
  const banner = page.locator(`.session-panel.is-phone-layer[data-session-id="${sid}"] .session-history-stale-banner`)
  await expect(banner).toBeVisible({ timeout: 30_000 })
  await expect(banner).toHaveText('Showing cached history. Reconnecting to Garden box...')
  const look = await banner.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { bg: cs.backgroundColor, fg: cs.color, page: getComputedStyle(document.body).backgroundColor }
  })
  const bg = luminance(look.bg)
  const fg = luminance(look.fg)
  // A dark box (no cream on black), and its words readable on it (WCAG AA).
  expect(bg, JSON.stringify(look)).toBeLessThan(0.08)
  expect((Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05), JSON.stringify(look)).toBeGreaterThanOrEqual(4.5)
  await shot(page, 'n2-22-dark-stale')
  expect(errors).toEqual([])
})

test('N2-23 follow-up: a short session shows no Latest pill over its last message', async ({ page }) => {
  const sid = 'pw-r3-short-session'
  await isolateUiPrefs(page)
  const now = new Date().toISOString()
  const messages = [
    { role: 'user', text: 'Count the seed packets in the shed', timestamp: now, msgId: 'u-1' },
    { role: 'assistant', text: 'There are forty two packets on the second shelf.', timestamp: now, msgId: 'a-1' },
  ]
  await page.route(`**/api/sessions/${sid}`, (route) => route.fulfill({ json: {
    session: { claudeSessionId: sid, taskId: 'pw-r3-short-task', project: 'Walnut', process_status: 'idle', mode: 'default',
      startedAt: now, lastActiveAt: now, messageCount: messages.length, title: 'Seed packet count' },
    pendingPermissions: [],
  } }).catch(() => undefined))
  await page.route(`**/api/sessions/${sid}/history**`, (route) => route.fulfill({ json: { messages, cursor: messages.length, delta: false } }).catch(() => undefined))
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/?s1=${sid}`)
  const layer = page.locator(`.session-panel.is-phone-layer[data-session-id="${sid}"]`)
  await expect(layer.locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 30_000 })
  await page.waitForTimeout(1000)
  const pill = await layer.locator('.scroll-to-bottom-btn').evaluateAll((els) => els.map((e) => ({
    cls: e.className, opacity: getComputedStyle(e).opacity,
  })))
  // Nothing below to jump to: the pill stays down (not drawn over the reply).
  for (const p of pill) expect(p, JSON.stringify(pill)).toMatchObject({ opacity: '0' })
  await shot(page, 'n2-23-short-session')
  expect(errors).toEqual([])
})
