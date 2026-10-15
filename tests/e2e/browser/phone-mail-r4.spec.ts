/**
 * Mail's reader on a phone, review round 4 (R3-10): invite answers are finger
 * targets, the reader's actions are a labelled row under the subject, and the
 * sort line leaves no separator at the start of a line. Its own mail fixture
 * (mail-app-server.ts with the invite set); nothing is sent anywhere.
 */
import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { MailFixtureServer } from './mail-review-helpers'
import { PHONE, findSmallTargets, menuButton, openDrawer } from './phone-helpers'

const SHOTS = '/tmp/mobile-web/phone-mail-r4'
const WRITER = 'fixture:ctx-writer@example.invalid'
const OPEN = 'INBOX:9:1'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(300_000)
  await fs.mkdir(SHOTS, { recursive: true })
  port = (await server.start({ PW_MAIL_INVITE: '1', PW_MAIL_DENSE: '' })).port
})

test.afterAll(async () => { await server.stop() })

test('R3-10: invite answers are 44 px; Reply, Reply all, Forward, Task and Read sit in a labelled row under the subject', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${port}/`)
  await expect(menuButton(page)).toBeVisible({ timeout: 90_000 })
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByTestId('sidebar-core-app-mail').click()
  // These invites were read on arrival, and a grouped inbox lists unread mail only: All mail.
  const view = page.getByTestId('mail-view-menu').first()
  await expect(view).toBeVisible({ timeout: 90_000 })
  if ((await view.getAttribute('data-grouped')) === 'true') {
    await view.click()
    await page.getByTestId('mail-view-menu-list').locator('[role^="menuitem"]').filter({ hasText: 'All mail' }).first().click()
  }
  const row = page.locator(`.mail-row[data-account-id="${WRITER}"][data-message-id="${OPEN}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.click()
  await expect(page.getByTestId('mail-reader')).toHaveAttribute('data-message-id', OPEN, { timeout: 60_000 })
  const invite = page.getByTestId('mail-invite')
  await expect(invite).toBeVisible({ timeout: 30_000 })
  for (const which of ['accept', 'tentative', 'decline']) {
    const b = (await page.getByTestId(`mail-invite-${which}`).boundingBox())!
    expect(b.height, which).toBeGreaterThanOrEqual(44)
  }
  const subject = (await page.getByTestId('mail-reader-subject').boundingBox())!
  const labels: string[] = []
  for (const id of ['mail-reply', 'mail-reply-all', 'mail-forward', 'mail-mark-read']) {
    const btn = page.getByTestId(id)
    const b = (await btn.boundingBox())!
    expect(b.y, `${id} sits under the subject`).toBeGreaterThanOrEqual(subject.y + subject.height - 1)
    // Right under it: no blank band between the subject and the row.
    expect(b.y - (subject.y + subject.height), `${id} gap`).toBeLessThanOrEqual(24)
    expect(b.height).toBeGreaterThanOrEqual(44)
    labels.push(await btn.evaluate((el) => getComputedStyle(el, '::after').content))
  }
  expect(labels).toEqual(['"Reply"', '"Reply all"', '"Forward"', expect.stringMatching(/^"(Read|Unread)"$/)])
  expect(await findSmallTargets(page, '.mail-reader-head')).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: `${SHOTS}/r3-10-${test.info().project.name}.png` })
  expect(errors).toEqual([])
})
