/**
 * Off Home, the home page's columns stay mounted but read no layout (2026-11-11, measured in
 * the Mac app: with the person on Org, the four hidden columns' polls read scrollHeight 16
 * times a second, forcing layout of a page nobody saw). Coming back, every column is where it
 * was: one following the newest row still follows it, one parked mid-history stays put with
 * its way back.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-hidden-home-idle-session'
const ROWS = 160

function row(i: number) {
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `Transcript row ${i}\n\n${'the quick brown fox jumps over the lazy dog '.repeat(4)}`,
    msgId: `hidden-m${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }
}

async function mockSession(page: Page) {
  const messages = Array.from({ length: ROWS }, (_, i) => row(i))
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({ json: { messages, total: ROWS, ...(route.request().url().includes('source=streams') ? {} : { cursor: ROWS }), delta: false } })
  })
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-hidden-home-idle-task', project: 'Walnut',
          process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: ROWS, title: 'Hidden home idle',
        },
      },
    })
  })
  // Count layout reads made inside the hidden home page.
  await page.addInitScript(() => {
    const w = window as unknown as { __hiddenReads: number }
    w.__hiddenReads = 0
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      ...desc,
      get(this: Element) {
        if (this.closest('.main-page-wrapper-hidden')) w.__hiddenReads++
        return desc.get!.call(this)
      },
    })
  })
}

const historyOf = (page: Page) => page.locator('.main-page-session-column .session-history').first()
const arrowShown = (page: Page) => page.locator('.main-page-session-column .scroll-to-bottom-btn').first().evaluate((el) => el.classList.contains('visible'))
const geometry = (page: Page) => historyOf(page).evaluate((el) => ({ top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) }))
const hiddenReads = (page: Page) => page.evaluate(() => (window as unknown as { __hiddenReads: number }).__hiddenReads)

async function openHome(page: Page) {
  await mockSession(page)
  await page.goto(`/sessions?id=${SESSION_ID}`)
  await page.waitForLoadState('domcontentloaded')
  await expect(historyOf(page)).toContainText(`Transcript row ${ROWS - 1}`, { timeout: 20_000 })
  await page.waitForTimeout(2500)
}

async function awayOnOrg(page: Page, ms: number): Promise<number> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.locator('.main-page-wrapper-hidden')).toHaveCount(1)
  await page.waitForTimeout(500)
  const before = await hiddenReads(page)
  await page.waitForTimeout(ms)
  const reads = (await hiddenReads(page)) - before
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page.locator('.main-page-wrapper-hidden')).toHaveCount(0)
  await page.waitForTimeout(1200)
  return reads
}

test('a column following the newest row reads no layout while hidden and still follows after', async ({ page }) => {
  test.setTimeout(120_000)
  await openHome(page)
  await historyOf(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(700)
  expect((await geometry(page)).gap).toBeLessThanOrEqual(80)

  const reads = await awayOnOrg(page, 35_000)
  // Stay away past the restore deadline; the returning column must still follow.
  expect(reads, 'layout reads inside the hidden home page while on Org').toBeLessThanOrEqual(2)

  expect((await geometry(page)).gap, 'back on Home, still on the newest row').toBeLessThanOrEqual(80)
  await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(false)
})

test('a column parked mid-history keeps its place and its way back across a visit to Org', async ({ page }) => {
  test.setTimeout(120_000)
  await openHome(page)
  await historyOf(page).hover()
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -400)
  await page.waitForTimeout(1000)
  const parked = await geometry(page)
  expect(parked.gap, 'the wheel leaves the bottom').toBeGreaterThan(400)
  await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(true)

  await awayOnOrg(page, 35_000)

  const back = await geometry(page)
  expect(Math.abs(back.top - parked.top), 'the same place in the history').toBeLessThanOrEqual(2)
  await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(true)
})
