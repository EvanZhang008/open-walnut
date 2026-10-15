/**
 * C19 on the grouped inbox, phone sized: a group line's two buttons (Mark
 * read, Group actions) were 24 px boxes 4 px apart. On a phone each is a 32 px
 * box with its own 46 px target, and the two targets meet without overlapping.
 *
 * Runs on the mail grouping fixture (its own server, its own mail), never the
 * Playwright baseURL's data. Navigation is by taps after the first load.
 */
import { expect, test } from '@playwright/test'
import { startGroupsFixture } from './mail-grouping-helpers'
import type { MailFixture, MailFixtureServer } from './mail-review-helpers'
import { PHONE, findSmallTargets, menuButton, openDrawer } from './phone-helpers'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let server: MailFixtureServer | null = null
let fixture: MailFixture | null = null

test.beforeAll(async () => {
  test.setTimeout(300_000)
  ;({ server, fixture } = await startGroupsFixture())
})

test.afterAll(async () => {
  await server?.stop()
})

test('C19: a mail group line on a phone gives each of its two buttons a finger target', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://localhost:${fixture!.port}/`)
  await expect(menuButton(page)).toBeVisible({ timeout: 90_000 })
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByTestId('sidebar-core-app-mail').click()
  const line = page.getByTestId('mail-group-row').first()
  await expect(line).toBeVisible({ timeout: 90_000 })
  // The buttons show while the line is hovered or focused (and while its menu is open).
  await line.hover()
  const icons = line.locator('.mail-group-icon')
  await expect(icons.first()).toBeVisible()
  const boxes = await icons.evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), x: r.left }
  }))
  expect(boxes.length).toBeGreaterThan(0)
  for (const b of boxes) expect([b.w, b.h]).toEqual([32, 32])
  if (boxes.length > 1) expect(Math.round(boxes[1]!.x - boxes[0]!.x)).toBeGreaterThanOrEqual(46)
  await line.evaluate((el) => el.setAttribute('data-pw-scan', '1'))
  // What a finger 22 px off each icon's center lands on (for the report when one misses).
  const landed = await icons.evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + r.height / 2
    return [[-21.5, 0], [21.5, 0], [0, -21.5], [0, 21.5]].map(([dx, dy]) => {
      const t = document.elementFromPoint(cx + dx, cy + dy)
      return t === el || el.contains(t) ? 'self' : `${t?.tagName}.${String(t?.className).split(' ')[0]}`
    })
  }))
  expect(await findSmallTargets(page, '[data-pw-scan]'), JSON.stringify(landed)).toEqual([])
  await page.screenshot({ path: `/tmp/mobile-web/phone-mail-groups-${test.info().project.name}.png` })
  expect(errors).toEqual([])
})
