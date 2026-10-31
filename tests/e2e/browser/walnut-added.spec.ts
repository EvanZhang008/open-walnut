/**
 * What Walnut added to a person's message stays out of the chat by default and
 * is one click away (2026-10-29, the user: hidden by default behind a "more" in
 * the message footer, always visible for me; and a way to turn each hint off).
 *
 * Drives the real panel against the rider fixture (`pw-rider-session`,
 * test-server.ts): turn 10 is a status note in front of the person's words,
 * with a rich-output hint after them. It checks:
 *  · by default the bubble holds only the words: no note row above it, no
 *    hints row in it, and its footer says "Walnut added 2";
 *  · that button shows the note line and the hints row for this message, and
 *    hides them again;
 *  · a hint's "Turn off in Settings" link opens Sessions at that hint's switch;
 *  · with "Always show what Walnut added" on, they show with no click (the
 *    config write is answered by the test, so the shared fixture server's
 *    setting never changes under other specs).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { REAL_PANEL } from './draft-helpers'

const SESSION_ID = 'pw-rider-session'
const TASK_ID = 'pw-task-rider'
const MARK = 'RIDER_TYPED_STATUS'
const SHOTS = process.env.WALNUT_ADDED_SHOTS ?? '/tmp/walnut-added'

async function openSession(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('walnut:session-view.default', 'linear'))
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(TASK_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-history')).toContainText(MARK, { timeout: 30_000 })
  return panel
}

function bubbleOf(panel: Locator): Locator {
  return panel.locator('.session-history .session-msg-user', { hasText: MARK })
}

function riderAbove(b: Locator): Locator {
  return b.locator('xpath=preceding-sibling::div[contains(concat(" ", @class, " "), " session-msg-riders ")][1]')
}

/** Bring the bubble into view with a real wheel: the timeline snaps scrollIntoView back to its bottom. */
async function reveal(page: Page, panel: Locator, target: Locator): Promise<void> {
  const view = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 40; i++) {
    const box = await target.boundingBox()
    if (box && box.y - 60 >= view.y && box.y + Math.min(box.height, view.height - 80) <= view.y + view.height) return
    await page.mouse.wheel(0, box && box.y - 60 < view.y ? -200 : 200)
    await page.waitForTimeout(120)
  }
}

async function shot(page: Page, target: Locator, name: string): Promise<void> {
  const box = await target.boundingBox().catch(() => null)
  if (!box) return
  const vp = page.viewportSize()!
  const y = Math.max(0, box.y - 70)
  const clip = { x: Math.max(0, box.x - 10), y, width: Math.min(box.width + 20, vp.width - Math.max(0, box.x - 10)), height: Math.min(box.height + 90, vp.height - y) }
  if (clip.width < 1 || clip.height < 1) return
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, clip }).catch(() => {})
}

test('by default the bubble is only the words; its footer shows what Walnut added, and hides it again', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openSession(page)
  const b = bubbleOf(panel)
  await expect(b).toHaveCount(1)
  await expect(b).toContainText(`${MARK} yes, go for it.`)
  await expect(b.getByTestId('message-hints')).toHaveCount(0)
  await expect(riderAbove(b)).toHaveCount(0)
  await reveal(page, panel, b)
  await shot(page, b, 'default-hidden')

  const toggle = b.getByTestId('walnut-added-toggle')
  await b.hover()
  await expect(toggle).toHaveText(/^Walnut added 2›?$/)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(b.getByTestId('message-hints')).toContainText('Walnut hints: Rich output')
  await expect(riderAbove(b).locator('[data-testid="rider-fold"] .tool-run-toggle')).toHaveText(/^Received 1 message(?: from [^·›]+?)?›?$/)
  // The note's card is one more click away, as before.
  await riderAbove(b).locator('[data-testid="rider-fold"] .tool-run-toggle').click()
  await expect(riderAbove(b)).toContainText('changed its status')
  await reveal(page, panel, b)
  await shot(page, riderAbove(b).locator('xpath=..'), 'shown')

  await b.hover()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(b.getByTestId('message-hints')).toHaveCount(0)
  await expect(riderAbove(b)).toHaveCount(0)
})

test('a hint leads to its switch in Settings', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openSession(page)
  const b = bubbleOf(panel)
  await reveal(page, panel, b)
  await b.hover()
  await b.getByTestId('walnut-added-toggle').click()
  await b.getByTestId('message-hints').locator('.tool-run-toggle').click()
  const link = b.getByTestId('message-hint-settings-link')
  await expect(link).toHaveText('Turn off in Settings')
  await shot(page, b, 'hint-open')
  await link.click()
  await expect(page).toHaveURL(/\/settings#message-hint-rich-output$/)
  const row = page.locator('#message-hint-rich-output')
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('#hint-enabled-rich-output')).toBeVisible()
  await expect(page.locator('#show-walnut-additions')).toHaveCount(1)
  await shot(page, row, 'settings-row')
})

test('with "Always show what Walnut added" on, the additions show with no click', async ({ page }) => {
  test.setTimeout(90_000)
  // This page reads the setting as on; the shared fixture server's config never changes.
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
      return
    }
    const res = await route.fetch()
    const body = await res.json() as { config: { ui?: Record<string, unknown> } }
    body.config.ui = { ...(body.config.ui ?? {}), show_walnut_additions: true }
    await route.fulfill({ response: res, json: body })
  })
  const panel = await openSession(page)
  const b = bubbleOf(panel)
  await expect(b.getByTestId('message-hints')).toContainText('Walnut hints: Rich output')
  await expect(riderAbove(b).locator('[data-testid="rider-fold"]')).toHaveCount(1)
  await b.hover()
  await expect(b.getByTestId('walnut-added-toggle')).toHaveCount(0)
  await reveal(page, panel, b)
  await shot(page, riderAbove(b).locator('xpath=..'), 'always-on')
})
