import { expect, test } from '@playwright/test'
import { HARBOUR, MailFixtureServer, PANE, openMail, smartRow, tailToggle, twist } from './mail-review-helpers'

/**
 * The mail sidebar's own scroll anchoring (`useScrollAnchor`), in the engine the Mac app runs and in
 * Chromium. WebKit has no CSS scroll anchoring, so the pane turns the native one off and holds the
 * row at the top of the view by hand (2026-11-01: the smart group landing above a scrolled pane threw
 * it 132px in WebKit; that case is `mail-app-sidebar.spec.ts`, "the group waits for the mailbox rows").
 *
 * What is pinned here is WHICH row is held. A smart row cut by the top edge has to hold its own line:
 * holding the row below it instead scrolled the pane by the height of the accounts the twist had just
 * opened, so they opened out of view (found in review, before it shipped). The native anchoring holds
 * the line in Chromium, and WebKit used to move nothing at all, so both engines must leave it still.
 */

test.setTimeout(300_000)
test.use({ viewport: { width: 1280, height: 800 } })

const server = new MailFixtureServer()
let port = 0

test.beforeAll(async () => {
  test.setTimeout(240_000)
  port = (await server.start({ PW_MAIL_DENSE: '1' })).port
})
test.afterAll(async () => { await server.stop() })

test('a smart row cut by the top edge opens its accounts in view, and nothing scrolls', async ({ page }) => {
  await openMail(page, port)
  await expect(smartRow(page, 'inbox')).toBeVisible({ timeout: 90_000 })
  // A long pane, so the box can be scrolled to any point near its top.
  await tailToggle(page, HARBOUR).click()
  await expect(page.locator(`${PANE} .mail-tail-filter`)).toBeVisible()
  await expect(twist(page, 'inbox')).toHaveAttribute('aria-expanded', 'false')

  // Scroll until the All Inboxes line is cut by the top edge, half of it still showing.
  const scroll = page.locator('.mail-accounts-scroll')
  const line = page.locator(`${PANE} .mail-mailbox-line:has(.mail-twist[data-smart="inbox"])`)
  const cut = await scroll.evaluate((box, selector) => {
    const row = box.querySelector(selector)!.closest('.mail-mailbox-line') as HTMLElement
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = Math.round(offset + row.offsetHeight / 2)
    return box.scrollTop
  }, '.mail-twist[data-smart="inbox"]')
  await page.waitForTimeout(200)
  const boxTop = (await scroll.boundingBox())!.y
  const before = (await line.boundingBox())!
  expect(before.y, 'the line is cut by the top edge').toBeLessThan(boxTop)
  expect(before.y + before.height, 'and part of it is still on screen').toBeGreaterThan(boxTop)

  // The twist's visible part, clicked where it is: a locator click would scroll it into view first.
  const mark = (await twist(page, 'inbox').boundingBox())!
  await page.mouse.click(mark.x + mark.width / 2, (boxTop + mark.y + mark.height) / 2)
  await expect(twist(page, 'inbox')).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(300)

  const after = (await line.boundingBox())!
  expect(Math.abs(after.y - before.y), 'the line that was clicked has not moved').toBeLessThanOrEqual(1)
  expect(await scroll.evaluate((box) => box.scrollTop), 'nothing was scrolled').toBe(cut)
  // And what it opened is on screen, directly below it.
  const child = (await page.locator(`${PANE} [data-testid="mail-smart-children"]`).first().boundingBox())!
  expect(child.y, 'the accounts it opened are in view').toBeGreaterThanOrEqual(boxTop)
  expect(child.y, 'right under the line').toBeLessThan(after.y + after.height + 4)
})
