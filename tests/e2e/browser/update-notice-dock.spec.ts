/**
 * The update notice sits in the rail (covers nothing), its buttons take the click where
 * they are drawn, and its × keeps it away for 30 minutes through reloads, new windows and
 * newer updates (2026-10-27 user report: the pill covered the page, came back after every
 * deploy, and only a strip below "Reload" was clickable).
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp } from './host-problems-fixture-helpers'
import { healthyGitSync } from './banner-placement-helpers'

const SHOTS = 'test-results/update-notice-dock'
const STATUS = /\/api\/system\/desktop-update(\?|$)/
const pill = (page: Page) => page.locator('.stale-build-pill')
const action = (page: Page) => page.locator('.stale-build-pill-action')
const later = (page: Page) => page.locator('.stale-build-pill-later')

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ timeout: 120_000 })
test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

let token = '12:old:new'
test.beforeEach(async ({ page }) => {
  token = '12:old:new'
  await isolatePrefs(page)
  await healthyGitSync(page)
  await page.context().addInitScript(() => {
    Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: { walnutChrome: { postMessage() {} } } } })
  })
  await page.context().route(STATUS, r => r.fulfill({ json: { available: true, token } }))
})

/** Every point across the button's drawn box hits the button itself, and the cursor there is a hand. */
async function expectHitWhereDrawn(page: Page, button: Locator, over?: Locator, fractions = [0.1, 0.3, 0.5, 0.7, 0.9]): Promise<void> {
  const box = (await button.boundingBox())!
  // The collapsed rail's × badge is drawn over the Restart button's corner, and takes the click there.
  const top = over ? await over.boundingBox() : null
  expect(box.height).toBeGreaterThanOrEqual(16)
  for (const fy of fractions) {
    for (const fx of fractions) {
      const x = box.x + box.width * fx, y = box.y + box.height * fy
      if (top && x >= top.x - 1 && x <= top.x + top.width + 1 && y >= top.y - 1 && y <= top.y + top.height + 1) continue
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y)
        const b = el?.closest('button')
        return { cls: b?.className ?? el?.className ?? null, cursor: el ? getComputedStyle(el).cursor : null }
      }, [x, y])
      const want = await button.getAttribute('class')
      expect(hit.cls, `hit at ${fx},${fy}`).toBe(want)
      expect(hit.cursor, `cursor at ${fx},${fy}`).toBe('pointer')
    }
  }
}

/** The notice is in the rail: nothing of the page sits under it. */
async function expectDockedInRail(page: Page): Promise<void> {
  await expect(page.locator('.sidebar .sidebar-update-dock > .stale-build-pill.is-docked')).toHaveCount(1)
  await expect(page.locator('body > .stale-build-pill')).toHaveCount(0)
  const rail = (await page.locator('.sidebar').boundingBox())!
  const box = (await pill(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(rail.x)
  expect(box.x + box.width).toBeLessThanOrEqual(rail.x + rail.width + 0.5)
  // Bottom of the window, above the bell.
  const bell = (await page.locator('.sidebar-notification-btn').boundingBox())!
  expect(box.y + box.height).toBeLessThanOrEqual(bell.y + 0.5)
  expect(box.y).toBeGreaterThan(page.viewportSize()!.height / 2)
}

test('the notice docks in the collapsed rail and in the open sidebar, and both buttons take the click where they are drawn', async ({ page }) => {
  const bodies: unknown[] = []
  await page.route('**/api/system/desktop-update/restart', r => { bodies.push(r.request().postDataJSON()); return r.fulfill({ status: 202, json: { accepted: true } }) })
  await loadApp(page)
  await expect(action(page)).toHaveText('Restart')
  await expectDockedInRail(page)
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(1)
  await expectHitWhereDrawn(page, action(page), later(page))
  // The badge is a circle: its square's corners are not part of it.
  await expectHitWhereDrawn(page, later(page), undefined, [0.25, 0.5, 0.75])
  await page.locator('.sidebar').screenshot({ path: `${SHOTS}/rail-collapsed-${test.info().project.name}.png` })
  await page.screenshot({ path: `${SHOTS}/home-collapsed-${test.info().project.name}.png` })

  await page.locator('.sidebar-collapse-btn').click()
  await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  await expect(page.locator('.stale-build-pill-text')).toBeVisible()
  await expectDockedInRail(page)
  await expectHitWhereDrawn(page, action(page))
  await expectHitWhereDrawn(page, later(page))
  await page.screenshot({ path: `${SHOTS}/home-expanded-${test.info().project.name}.png` })

  // A click on the very top of the word works, not only below it.
  const box = (await action(page).boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + 2)
  await expect.poll(() => bodies).toEqual([{ token: '12:old:new', force: false }])
})

test('× keeps the notice away for 30 minutes through a reload, another window and a newer update, then shows a newer one only', async ({ page }) => {
  await page.clock.install()
  await loadApp(page)
  await expect(action(page)).toHaveText('Restart')
  await later(page).click()
  await expect(pill(page)).toHaveCount(0)

  // A newer update lands (a deploy) inside the 30 minutes: still quiet.
  token = '12:old:newer'
  await page.clock.fastForward(60_000)
  await expect(pill(page)).toHaveCount(0)

  // A reload and a new window both honour it.
  await page.reload()
  await expect(page.locator('.sidebar-notification-btn')).toBeVisible({ timeout: 30_000 })
  await page.clock.fastForward(60_000)
  await expect(pill(page)).toHaveCount(0)
  const other = await page.context().newPage()
  await other.clock.install()
  await other.goto(page.url())
  await expect(other.locator('.sidebar-notification-btn')).toBeVisible({ timeout: 30_000 })
  await other.clock.fastForward(60_000)
  await expect(other.locator('.stale-build-pill')).toHaveCount(0)
  await other.close()

  // The 30 minutes run out with that newer update still there: it shows once.
  await page.clock.fastForward(30 * 60_000)
  await expect(action(page)).toHaveText('Restart', { timeout: 15_000 })
  await expectDockedInRail(page)
})

test('after 30 minutes the very update that was dismissed stays dismissed', async ({ page }) => {
  await page.clock.install()
  await loadApp(page)
  await expect(action(page)).toHaveText('Restart')
  await later(page).click()
  await page.clock.fastForward(31 * 60_000)
  // Past the wake-up render: the dismissed update must stay away, not just not be back yet.
  await page.clock.fastForward(5_000)
  await page.waitForTimeout(500)
  await expect(pill(page)).toHaveCount(0)
  token = '12:old:newest'
  await page.clock.fastForward(60_000)
  await expect(action(page)).toHaveText('Restart')
})

test('× in one window hides the notice in another window already open', async ({ page }) => {
  await loadApp(page)
  const other = await page.context().newPage()
  await other.goto(page.url())
  await expect(other.locator('.stale-build-pill-action')).toHaveText('Restart', { timeout: 30_000 })
  await expect(action(page)).toHaveText('Restart')
  await later(page).click()
  await expect(other.locator('.stale-build-pill')).toHaveCount(0)
  await other.close()
})

test('a popout has no rail: the notice is a bar under the composer, covering nothing, and its buttons take the click where drawn', async ({ page }) => {
  await loadApp(page)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId: 'pw-vscode-session' } })))
  const parent = page.locator('.main-page-session-column [data-session-id="pw-vscode-session"]')
  await expect(parent).toBeVisible()
  const opened = page.context().waitForEvent('page')
  await parent.locator('.session-panel-popout').click()
  const child = await opened
  await child.setViewportSize({ width: 900, height: 700 })
  await expect(child.locator('.session-panel-input textarea')).toBeVisible({ timeout: 30_000 })
  await expect(child.locator('.popout-update-dock > .stale-build-pill.is-docked')).toHaveCount(1)
  await expect(child.locator('.stale-build-pill-action')).toHaveText('Restart')
  const box = (await child.locator('.stale-build-pill').boundingBox())!
  const composer = (await child.locator('.session-panel-input').boundingBox())!
  expect(Math.abs(700 - box.y - box.height)).toBeLessThanOrEqual(1)
  expect(composer.y + composer.height).toBeLessThanOrEqual(box.y + 0.5)
  // The window does not scroll: the session gave up the bar's height.
  expect(await child.evaluate(() => { const r = document.querySelector('.popout-root')!; return r.scrollHeight - r.clientHeight })).toBeLessThanOrEqual(1)
  await expectHitWhereDrawn(child, child.locator('.stale-build-pill-action'))
  await expectHitWhereDrawn(child, child.locator('.stale-build-pill-later'))
  await child.screenshot({ path: `${SHOTS}/popout-${test.info().project.name}.png` })
})

test('the phone layout floats the notice above the bottom bar, centred', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await loadApp(page)
  await expect(page.locator('body > .stale-build-pill')).toHaveCount(1)
  const box = (await page.locator('.stale-build-pill').boundingBox())!
  expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThanOrEqual(1)
  await expectHitWhereDrawn(page, action(page))
  await page.screenshot({ path: `${SHOTS}/phone-${test.info().project.name}.png` })
})

test('a task popout scrolls its view above the bar; the bar stays on the window edge', async ({ page }) => {
  await loadApp(page)
  // The popout window's own entry URL, as "Open in new window" opens it.
  const child = await page.context().newPage()
  await child.setViewportSize({ width: 700, height: 360 })
  await child.goto(new URL('/popout?view=task&id=pw-task-001', page.url()).toString())
  await expect(child.locator('.popout-update-dock > .stale-build-pill.is-docked')).toHaveCount(1, { timeout: 30_000 })
  const view = child.locator('.popout-root > :first-child')
  await view.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await child.locator('.popout-root').evaluate((el) => { el.scrollTop = el.scrollHeight })
  const bar = (await child.locator('.stale-build-pill').boundingBox())!
  const viewBox = (await view.boundingBox())!
  expect(Math.abs(360 - bar.y - bar.height)).toBeLessThanOrEqual(1)
  expect(viewBox.y + viewBox.height).toBeLessThanOrEqual(bar.y + 0.5)
  await child.screenshot({ path: `${SHOTS}/popout-task-${test.info().project.name}.png` })
})
