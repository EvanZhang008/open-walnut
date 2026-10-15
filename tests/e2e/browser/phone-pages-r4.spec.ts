/**
 * Phone pages, review round 4 (R3-06, R3-07): the calendar's day keeps hours a
 * 30 minute meeting fits in, with no block over another, and a wide table in
 * a session scrolls inside its own box. WebKit with devices['iPhone 15']
 * first, chromium too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { PHONE, menuButton, openDrawer } from './phone-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const SHOTS = '/tmp/mobile-web/phone-pages-r4'
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
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
  return errors
}

function localDay(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Back-to-back half hours from 1 PM, beside an hour-long meeting: the R3-06 afternoon. */
const MEETINGS = [
  { id: 'r4-a', title: 'Compost bin delivery window', start: '13:00', end: '13:30' },
  { id: 'r4-b', title: 'Pond pump check', start: '13:30', end: '14:00' },
  { id: 'r4-c', title: 'Seed order review', start: '14:00', end: '14:30' },
  { id: 'r4-d', title: 'Orchard walk with the volunteers', start: '13:00', end: '14:00' },
]

async function addAfternoon(page: Page): Promise<void> {
  await page.route('**/api/calendar/events?*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json() as { events: Record<string, unknown>[] }
    const calendarId = (body.events[0]?.calendarId as string | undefined) ?? 'cal-work'
    const day = localDay()
    for (const m of MEETINGS) body.events.push({
      id: `eventkit:${m.id}`, source: 'eventkit', calendarId, calendarName: 'Work', accountName: 'Local',
      title: m.title, start: `${day}T${m.start}:00`, end: `${day}T${m.end}:00`, allDay: false,
      location: 'Garden shed', readonly: true,
    })
    await route.fulfill({ response, json: body })
  })
}

test('R3-06: hours are tall enough for a half hour; no meeting covers another; a short one still takes a finger', async ({ page }) => {
  await addAfternoon(page)
  const errors = await bootHome(page)
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Calendar', exact: true }).click()
  const cal = page.locator('.cal-page').first()
  await expect(cal).toBeVisible({ timeout: 15_000 })
  const chips = cal.locator('.cal-grid-cols .cal-chip[data-item-id^="event:eventkit:r4-"]')
  await expect(chips).toHaveCount(4, { timeout: 15_000 })
  const hourPx = await cal.locator('[style*="--cal-hour-px"]').first().evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--cal-hour-px')))
  expect(hourPx).toBeGreaterThanOrEqual(48)
  await chips.first().scrollIntoViewIfNeeded()
  const rects = await chips.evaluateAll((els) => els.map((c) => {
    const r = c.getBoundingClientRect()
    return { id: c.getAttribute('data-item-id'), x: r.left, y: r.top, w: r.width, h: r.height }
  }))
  for (const r of rects) if (!r.id!.endsWith('r4-d')) expect(r.h, r.id!).toBeGreaterThanOrEqual(24)
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!, b = rects[j]!
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      expect(ox > 1 && oy > 1, `${a.id} drawn over ${b.id}`).toBe(false)
    }
  }
  // A half-hour chip's tap band reaches 44 px (the scan's four probes land on it).
  const band = await chips.filter({ hasText: 'Seed order review' }).evaluate((el) => {
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    return [cy - 21.5, cy + 21.5].map((y) => { const t = document.elementFromPoint(cx, y); return !!t && (t === el || el.contains(t)) })
  })
  expect(band).toEqual([true, true])
  await page.screenshot({ path: `${SHOTS}/r3-06-${test.info().project.name}.png` })
  await chips.filter({ hasText: 'Pond pump check' }).tap()
  await expect(page.locator('.cal-item-popover .cal-item-title')).toHaveValue('Pond pump check', { timeout: 5_000 })
  expect(errors).toEqual([])
})

const TABLE_SID = 'pw-phone-table-session'

test('R3-07: a wide table in a session scrolls inside its own box with readable columns; the page does not', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const cjk = '\u5206\u7ec4\u540d\u79f0'
  const table = [
    `| ${cjk} | ${cjk}${cjk} | Notes |`,
    '| --- | --- | --- |',
    `| ${cjk}${cjk}${cjk} | ${cjk} | A longer note about the shelves that wraps over a few lines |`,
    `| ${cjk} | ${cjk}${cjk}${cjk} | Short |`,
  ].join('\n')
  const iso = (ago: number) => new Date(Date.now() - ago).toISOString()
  const messages = [
    { role: 'user', text: 'Compare the garden groups', timestamp: iso(60_000), msgId: 'u-1' },
    { role: 'assistant', text: `Here is the comparison:\n\n${table}\n\nThat is all.`, timestamp: iso(50_000), msgId: 'a-1' },
  ]
  await page.route(`**/api/sessions/${TABLE_SID}`, (route) => route.fulfill({ json: {
    session: { claudeSessionId: TABLE_SID, project: 'Walnut', process_status: 'idle', mode: 'default', startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: 2, title: 'Table fixture' },
    pendingPermissions: [],
  } }))
  await page.route(`**/api/sessions/${TABLE_SID}/history**`, (route) => route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  await page.goto(`/?s1=${TABLE_SID}`)
  const t = page.locator(`.session-panel[data-session-id="${TABLE_SID}"] .session-history .markdown-body table`).first()
  await expect(t).toBeVisible({ timeout: 30_000 })
  await t.scrollIntoViewIfNeeded()
  const geo = await t.evaluate((el) => {
    const font = parseFloat(getComputedStyle(el.querySelector('td')!).fontSize)
    const cells = [...el.querySelectorAll('tr')].flatMap((r) => [...r.children]).map((c) => {
      // Lines of text, not the row's height (a row is as tall as its tallest cell).
      const range = document.createRange(); range.selectNodeContents(c)
      const tops = new Set([...range.getClientRects()].map((x) => Math.round(x.top)))
      return { w: c.getBoundingClientRect().width, lines: tops.size, cjk: /[\u4e00-\u9fff]/.test(c.textContent || '') }
    })
    return { font, sw: el.scrollWidth, cw: el.clientWidth, cells, pageOverflow: document.documentElement.scrollWidth - window.innerWidth, css: `${getComputedStyle(el).display} ${getComputedStyle(el).overflowX} td-min=${getComputedStyle(el.querySelector('td')!).minWidth} shell=${!!el.closest('.app-shell-navigation')} cls=${el.parentElement!.className}` }
  })
  expect(geo.sw, `the table scrolls sideways in its own box ${geo.css}`).toBeGreaterThan(geo.cw)
  for (const c of geo.cells) expect(c.w).toBeGreaterThanOrEqual(geo.font * 6)
  // A CJK cell of up to twelve characters takes at most two lines (it broke one character a line).
  for (const c of geo.cells.filter((x) => x.cjk)) expect(c.lines).toBeLessThanOrEqual(2)
  expect(geo.pageOverflow).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `${SHOTS}/r3-07-${test.info().project.name}.png` })
})
