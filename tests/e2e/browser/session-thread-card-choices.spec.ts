/**
 * The reader's choices around the comment card (Conversation Mode).
 *
 * Covers: an Ask closed with nothing written (Esc, ×, a click away) leaves
 * nothing behind: no draft row in the sidebar, no composer target, nothing after
 * a reload; words typed into the card keep it as a draft that reopens with them,
 * and emptying it lets it go; the composer names the question it replies in
 * (number and title) and its × sends to the main conversation instead, carrying
 * what was typed; a click into the composer during an Ask keeps the Ask as the
 * composer's target ("Asking about") and brings the card's words along, and ×
 * lets go of it; the card's expand button lifts it over the panel, Esc and the
 * backdrop bring it back, × closes.
 *
 * Chromium and WebKit. The tagged fixture session.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, selectPassage } from './threads-helpers'
import { buildTaggedSession, TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TITLES } from './threads-fixture'

const IDS = buildTaggedSession(Date.now()).ids
const PASSAGE = TAGGED_PASSAGE.slice(0, 30)

async function shot(page: Page, name: string, panel?: Locator): Promise<void> {
  const dir = `/tmp/thread-choices/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (panel) await panel.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1800, height: 800 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${TAGGED_SESSION}"]) {
    flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }` })
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
}

const card = (panel: Locator) => panel.locator('.thread-card')
const unsentRows = (panel: Locator) => panel.locator('.thread-map .thread-map-row[data-kind="draft"], .thread-map .thread-map-row[data-kind="pending"]')
const chip = (panel: Locator) => panel.locator('[data-testid="composer-thread-target"]')
const composer = (panel: Locator) => panel.locator('.session-panel-input .chat-input-textarea').first()

async function ask(page: Page, panel: Locator): Promise<Locator> {
  await centreInHistory(page, panel, PASSAGE)
  await selectPassage(page, panel, PASSAGE)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  const c = card(panel)
  await expect(c).toHaveAttribute('data-draft', 'true')
  await expect(unsentRows(panel)).toHaveCount(1)
  return c
}

test.describe('Choices around the comment card', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('an Ask closed with nothing written leaves nothing: Esc, ×, a click away, and a reload', async ({ page }) => {
    const panel = await open(page)
    // Esc in the card's box.
    let c = await ask(page, panel)
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveAttribute('placeholder', /Send a message to this session/)
    // The card's ×.
    c = await ask(page, panel)
    await c.locator('.thread-card-close').click()
    await expect(c).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    // A press on plain text away from the card.
    c = await ask(page, panel)
    await panel.locator(`.session-history [data-message-id="${IDS.R1.a}"]`).click({ position: { x: 12, y: 10 } })
    await expect(c).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    // Nothing of it comes back with the page.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    await expect(again.locator('.thread-map .thread-map-row[data-kind="thread"]').first()).toBeVisible()
    await expect(unsentRows(again)).toHaveCount(0)
    await expect(chip(again)).toHaveCount(0)
  })

  test('words typed into the card keep the Ask as a draft that reopens with them; emptied, it goes', async ({ page }) => {
    const panel = await open(page)
    const c = await ask(page, panel)
    await c.locator('.thread-card-input').fill('Half a thought about ties')
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).toHaveCount(0)
    const draft = panel.locator('.thread-map .thread-map-row[data-kind="draft"]')
    await expect(draft).toHaveCount(1)
    await draft.click()
    await expect(card(panel)).toHaveAttribute('data-draft', 'true')
    await expect(card(panel).locator('.thread-card-input')).toHaveValue('Half a thought about ties')
    await card(panel).locator('.thread-card-input').fill('')
    await card(panel).locator('.thread-card-input').press('Escape')
    await expect(card(panel)).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
  })

  test('the composer names the question it replies in, and × sends to the main conversation with the words typed', async ({ page }) => {
    const panel = await open(page)
    const rows = panel.locator('.thread-map .thread-map-row[data-kind="thread"]')
    await rows.nth(0).click()
    await expect(card(panel)).toBeVisible()
    await expect(chip(panel)).toBeVisible()
    await expect(chip(panel)).toContainText('Replying in')
    await expect(chip(panel).locator('.thread-map-num')).toHaveText('1')
    await expect(chip(panel).locator('.pill-title')).toHaveText(TAGGED_TITLES.Q1)
    await shot(page, 'composer-chip-reply', panel)
    // Typing in the composer closes the card; the chip still says where it goes.
    await composer(panel).click()
    await expect(card(panel)).toHaveCount(0)
    await composer(panel).fill('This one is for the main thread')
    await expect(chip(panel)).toBeVisible()
    // The chip's title opens the question's card again.
    await chip(panel).locator('.pill-target').click()
    await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText('1')
    // × : the composer posts to the main conversation, the words stay in it.
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    await expect(card(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('This one is for the main thread')
    await expect(composer(panel)).toHaveAttribute('placeholder', /Send a message to this session/)
    await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'page')
    await composer(panel).press('Enter')
    const bubble = panel.locator('.session-history .session-msg', { hasText: 'This one is for the main thread' }).first()
    await expect(bubble).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.session-history .session-msg--threaded', { hasText: 'This one is for the main thread' })).toHaveCount(0)
  })

  test('a click into the composer during an Ask keeps it as the target ("Asking about") with the card\'s words; × lets it go', async ({ page }) => {
    const panel = await open(page)
    await ask(page, panel)
    await composer(panel).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveAttribute('data-pending', 'true')
    await expect(chip(panel)).toContainText('Asking about')
    await expect(unsentRows(panel)).toHaveCount(1)
    await shot(page, 'composer-chip-ask', panel)
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    // Words typed in the card come along into the composer, still asking there.
    const c = await ask(page, panel)
    await c.locator('.thread-card-input').fill('Why the oldest one')
    await composer(panel).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('Why the oldest one')
    await expect(chip(panel)).toContainText('Asking about')
    // × : the words go on to the main conversation's composer.
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('Why the oldest one')
    // Straight from the open card to the chip's ×: the card's words follow too.
    await composer(panel).fill('')
    const c2 = await ask(page, panel)
    await c2.locator('.thread-card-input').fill('A second thought')
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('A second thought')
  })

  test('the expand button lifts the card over the panel; Esc and the backdrop bring it back; × closes', async ({ page }) => {
    const panel = await open(page)
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0).click()
    const c = card(panel)
    await expect(c).toBeVisible()
    const placed = (await c.boundingBox())!
    await c.locator('.thread-card-expand').click()
    await expect(c).toHaveAttribute('data-expanded', 'true')
    const backdrop = panel.locator('[data-testid="thread-card-backdrop"]')
    await expect(backdrop).toBeVisible()
    const pb = (await panel.boundingBox())!
    const bb = (await backdrop.boundingBox())!
    expect(Math.abs(bb.x - pb.x)).toBeLessThan(2)
    expect(Math.abs(bb.width - pb.width)).toBeLessThan(2)
    const big = (await c.boundingBox())!
    expect(big.width).toBeGreaterThan(placed.width + 100)
    expect(big.x).toBeGreaterThanOrEqual(pb.x)
    expect(big.x + big.width).toBeLessThanOrEqual(pb.x + pb.width + 1)
    await expect(c.locator('.thread-card-input')).toBeFocused()
    await page.waitForTimeout(200)
    await shot(page, 'card-expanded', panel)
    // Esc: back beside the passage, still open.
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).not.toHaveAttribute('data-expanded', 'true')
    await expect(c).toBeVisible()
    await expect(backdrop).toHaveCount(0)
    const back = (await c.boundingBox())!
    const passage = await passageRects(panel, PASSAGE)
    expect(back.y).toBeGreaterThanOrEqual(passage[passage.length - 1].top)
    // The backdrop: back as well.
    await c.locator('.thread-card-expand').click()
    await expect(c).toHaveAttribute('data-expanded', 'true')
    await page.mouse.click(pb.x + 6, pb.y + pb.height - 6)
    await expect(c).not.toHaveAttribute('data-expanded', 'true')
    await expect(c).toBeVisible()
    // × closes from either state.
    await c.locator('.thread-card-expand').click()
    await c.locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    await expect(backdrop).toHaveCount(0)
  })
})
