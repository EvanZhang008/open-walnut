/**
 * Phone home, review round 4 (R3-02 .. R3-04): rows hold still from their first
 * paint, a single-tier tab scrolls with the page and runs down to its one-line
 * status sections, and a row's title keeps most of the row however many pills it has.
 * WebKit with devices['iPhone 15'] first, chromium too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { PHONE, findSmallTargets } from './phone-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'
import { bpSetup } from './banner-placement-helpers'
import { banner, failed, resetServerHostFixture } from './host-problems-helpers'

const SHOTS = '/tmp/mobile-web/phone-home-r4'
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })
// A host card a banner spec left on the shared fixture server would fill a small first screen.
test.beforeEach(async ({ request }) => { await resetServerHostFixture(request) })

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

async function phoneHome(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  // List + shelf: the phone's Needs-you strip (R3-02) and a task that needs you as its
  // full card in the list (R3-04) are its parts; By status, the default, shows those
  // tasks in its Needs you section instead.
  await presetPanelDesign(page, 'shelf')
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
}

/** Slow the first task list (the window where the old home painted controls, then pushed them down) and record every move. */
async function watchFirstLoad(page: Page): Promise<void> {
  await page.route('**/api/tasks?**', async (route) => {
    await new Promise((r) => setTimeout(r, 700))
    await route.continue()
  })
  await page.addInitScript(() => {
    const w = window as unknown as { __firstTop: Record<string, number>; __moved: string[]; __first: Record<string, number> }
    w.__firstTop = {}; w.__moved = []; w.__first = {}
    const t0 = performance.now()
    const tick = () => {
      const sc = document.querySelector<HTMLElement>('.home-navigation-scroll')
      if (sc && sc.scrollTop === 0) {
        const seen = new Set<string>()
        sc.querySelectorAll<HTMLElement>('button, [role="button"]').forEach((el) => {
          const r = el.getBoundingClientRect()
          if (r.height === 0 || r.top >= window.innerHeight) return
          const key = `${el.className}|${(el.textContent || '').trim().slice(0, 30)}`
          if (seen.has(key)) return
          seen.add(key)
          if (!(key in w.__firstTop)) w.__firstTop[key] = r.top
          else if (Math.abs(w.__firstTop[key]! - r.top) > 1 && w.__moved.length < 10) w.__moved.push(`${key} ${Math.round(w.__firstTop[key]!)} -> ${Math.round(r.top)}`)
        })
        for (const sel of ['.phone-needs-you', '.todo-pinned-wrapper', '[data-testid="attention-banner"]']) {
          if (!(sel in w.__first) && sc.querySelector(sel)) w.__first[sel] = Math.round(performance.now() - t0)
        }
      }
      if (performance.now() - t0 < 6000) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function firstLoadResult(page: Page): Promise<{ moved: string[]; first: Record<string, number> }> {
  await expect(page.locator('.phone-needs-you')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  return page.evaluate(() => {
    const w = window as unknown as { __moved: string[]; __first: Record<string, number> }
    return { moved: w.__moved, first: w.__first }
  })
}

test('R3-02: nothing lands above rows already painted; the Needs-you strip comes with the first rows', async ({ page }) => {
  await phoneHome(page)
  await watchFirstLoad(page)
  await page.goto('/')
  const res = await firstLoadResult(page)
  expect(res.moved, 'a painted control moved under the thumb').toEqual([])
  // The strip and the tier rows arrive in the same frame (the strip is never late).
  expect(res.first['.phone-needs-you']).toBeLessThanOrEqual(res.first['.todo-pinned-wrapper'] ?? Infinity)
  await page.screenshot({ path: `${SHOTS}/r3-02-${test.info().project.name}.png` })
})

test('R3-02: a host card in the list holds still too: it comes with the first rows, never before the strip', async ({ page }) => {
  // The card sits below the Needs-you strip. Painted before the first task list, it was pushed
  // down 239px when the strip arrived (Retry, Show details and its x moved under the thumb).
  await watchFirstLoad(page)
  await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable')], before: phoneHome })
  const res = await firstLoadResult(page)
  await expect(banner(page)).toBeVisible()
  expect(res.moved, 'a painted control moved under the thumb').toEqual([])
  expect(res.first['.phone-needs-you']).toBeLessThanOrEqual(res.first['[data-testid="attention-banner"]'] ?? Infinity)
  await page.screenshot({ path: `${SHOTS}/r3-02-host-card-${test.info().project.name}.png` })
})

const TAB_SIZES = [
  { name: '390', viewport: { width: 390, height: 844 } },
  { name: '320', viewport: { width: 320, height: 568 } },
  { name: 'landscape', viewport: { width: 844, height: 390 } },
] as const

for (const size of TAB_SIZES) {
  test(`R3-03: a single-tier tab scrolls with the page, runs to one-line status sections, three rows on the first screen (${size.name})`, async ({ page }) => {
    await phoneHome(page)
    await page.addInitScript(() => {
      try {
        localStorage.setItem('walnut-todo-quick-views-visible', 'true')
        localStorage.setItem('walnut-todo-tab-bar-hidden-tabs', '[]')
        localStorage.setItem('walnut-todo-tab-bar-hide-empty', 'false')
      } catch { /* storage off */ }
    })
    await page.setViewportSize(size.viewport)
    await page.goto('/')
    const tab = page.locator('.todo-section-tabs .todo-section-tab').filter({ hasText: 'Recent' }).first()
    await expect(tab).toBeVisible({ timeout: 30_000 })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    const rows = page.locator('.home-navigation-scroll .todo-pinned-card')
    await expect(rows.first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(500)
    const geo = await page.evaluate(() => {
      const panel = document.querySelector('.main-page-todo .todo-panel')!
      const sc = panel.querySelector<HTMLElement>('.home-navigation-scroll')!
      const scrollers = [...panel.querySelectorAll<HTMLElement>('*')].filter((el) => {
        const oy = getComputedStyle(el).overflowY
        return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1
      }).map((el) => String(el.className).split(' ')[0])
      const b = sc.getBoundingClientRect()
      const full = [...sc.querySelectorAll('.todo-pinned-card')].filter((el) => {
        const r = el.getBoundingClientRect()
        return r.height > 0 && r.top >= b.top - 1 && r.bottom <= Math.min(b.bottom, innerHeight) + 1
      }).length
      return { scrollers, full }
    })
    expect(geo.scrollers, 'one scroller, like Mail').toEqual(['home-navigation-scroll'])
    expect(geo.full).toBeGreaterThanOrEqual(3)
    // At the end of the list: the folded status sections (which replaced the footer)
    // are its last lines, each one line high, the first right under the last row.
    const end = await page.evaluate(async () => {
      const sc = document.querySelector<HTMLElement>('.main-page-todo .home-navigation-scroll')!
      sc.scrollTop = sc.scrollHeight
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const heads = [...sc.querySelectorAll<HTMLElement>('.status-section-block-waiting > .status-section-heading, .status-section-block-done > .status-section-heading')]
      const cards = [...sc.querySelectorAll('.todo-pinned-card:not(.status-section-card)')]
      const b = sc.getBoundingClientRect()
      if (!heads.length || !cards.length) return { heads: false, gap: 0, height: 0, inView: false }
      const last = cards[cards.length - 1]!.getBoundingClientRect()
      const first = heads[0]!.getBoundingClientRect()
      const lastHead = heads[heads.length - 1]!.getBoundingClientRect()
      return {
        heads: true, gap: first.top - last.bottom, height: Math.max(...heads.map((h) => h.getBoundingClientRect().height)),
        inView: lastHead.bottom <= b.bottom + 1 && lastHead.top >= b.top,
      }
    })
    if (end.heads) {
      expect(end.inView).toBe(true)
      expect(end.height).toBeLessThanOrEqual(52)
      expect(end.gap).toBeLessThanOrEqual(80)
    }
    await page.screenshot({ path: `${SHOTS}/r3-03-${size.name}-${test.info().project.name}.png` })
  })
}

test('R3-04: a card with Needs you, a Leader pill and tags keeps most of the row for its title; its pills are labels', async ({ page }) => {
  await phoneHome(page)
  await page.addInitScript(() => {
    try {
      localStorage.setItem('walnut-todo-quick-views-visible', 'true')
      localStorage.setItem('walnut-todo-tab-bar-hidden-tabs', '[]')
      localStorage.setItem('walnut-todo-tab-bar-hide-empty', 'false')
    } catch { /* storage off */ }
  })
  const TITLE = 'Reorder the greenhouse shelves before the frost week'
  // Page-local: one open task becomes a leader with two workers, waits on the user and carries tags.
  await page.route(/\/api\/tasks(\?|$)/, async (route) => {
    const req = route.request()
    if (req.method() !== 'GET' || new URL(req.url()).searchParams.has('ids')) { await route.fallback(); return }
    const res = await route.fetch()
    const body = await res.json() as { tasks?: Array<Record<string, unknown>> }
    const open = (body.tasks ?? []).filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done' && !t.parent_task_id)
    const seed = open[0]
    if (seed) {
      Object.assign(seed, { title: TITLE, phase: 'NEED_ACTION', tags: ['greenhouse', 'frost'], updated_at: new Date().toISOString() })
      for (const w of open.slice(1, 3)) w.parent_task_id = seed.id
    }
    await route.fulfill({ response: res, json: body })
  })
  await page.goto('/')
  const tab = page.locator('.todo-section-tabs .todo-section-tab').filter({ hasText: 'Recent' }).first()
  await expect(tab).toBeVisible({ timeout: 30_000 })
  await tab.click()
  const card = page.locator('.home-navigation-scroll .todo-pinned-card').filter({ hasText: TITLE }).first()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const geo = await card.evaluate((el) => {
    const c = el.getBoundingClientRect()
    const t = el.querySelector('.todo-pinned-title')!.getBoundingClientRect()
    const pills = [...el.querySelectorAll<HTMLElement>(':scope > .task-row-pill, :scope > .phone-row-needs-you, :scope > .task-tag-pills, :scope > * .task-row-pill')]
      .filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => ({ text: (p.textContent || '').trim(), top: p.getBoundingClientRect().top, events: getComputedStyle(p).pointerEvents }))
    return { cardW: c.width, titleW: t.width, titleTop: t.top, pills }
  })
  expect(geo.pills.length).toBeGreaterThanOrEqual(2)
  expect(geo.titleW / geo.cardW, 'the title keeps most of the row').toBeGreaterThanOrEqual(0.6)
  for (const p of geo.pills) expect(p.top, `${p.text} sits under the title`).toBeGreaterThan(geo.titleTop + 10)
  const id = await card.evaluate((el) => { el.setAttribute('data-r4-card', '1'); return true })
  expect(id).toBe(true)
  expect(await findSmallTargets(page, '[data-r4-card="1"]')).toEqual([])
  await page.screenshot({ path: `${SHOTS}/r3-04-${test.info().project.name}.png` })
})
