/**
 * Injected-banner folding in the real session timeline.
 *
 * When a lane session has been blind to turns answered elsewhere, Walnut PREPENDS
 * a `[Conversation context]…[/Conversation context]` block to the message it hands
 * the CLI. The transcript stores that as ONE user turn, so the session panel used
 * to render a wall of machine prose INSIDE the human's own chat bubble, above the
 * words they actually typed. This spec drives the real panel and asserts:
 *
 *  · the typed words are what you see; the recap is folded out of sight;
 *  · the fold is a real disclosure — one click shows the recap, which matters
 *    because a silent strip leaves no way to find out why the model reacted to
 *    something invisible;
 *  · two stacked banner kinds fold into two rows, not one swallowed message;
 *  · a TRUNCATED block (no terminator) leaves the message whole — the parser must
 *    never eat the human's text on malformed input;
 *  · an ordinary message is unchanged.
 *
 * Fixture: `pw-banner-session` (test-server.ts) — five user turns, one per shape,
 * with the markers taken from the PRODUCTION constants.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-banner-session'
const TASK_ID = 'pw-task-banner'
/** Override to collect the review screenshots somewhere durable. */
const SCREENSHOT_DIR = process.env.BANNER_SHOT_DIR ?? '/tmp/injected-banner-ui'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Open the fixture session's column through real UI clicks (kebab → session). */
async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(TASK_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible({ timeout: 15_000 })
    // Click the row's title: the task menu has no open-session row.
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-msg', { hasText: 'BANNER_TYPED_ONE' }).first())
    .toBeVisible({ timeout: 20_000 })
  return panel
}

/** The transcript row holding a marker. */
function row(panel: Locator, marker: string): Locator {
  return panel.locator('.session-msg', { hasText: marker }).first()
}

/**
 * Scroll a row into the history viewport with a REAL wheel gesture, then clip the
 * page to its box. An element screenshot is useless here: the timeline follows its
 * own bottom and snaps Playwright's scroll-into-view straight back, landing the
 * capture on empty space. Only a wheel tells the component the reader left the tail.
 */
async function shotRow(page: Page, panel: Locator, target: Locator, file: string): Promise<void> {
  const view = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 24; i++) {
    const box = await target.boundingBox()
    if (box && box.y >= view.y && box.y + box.height <= view.y + view.height) break
    await page.mouse.wheel(0, box && box.y < view.y ? -160 : 160)
    await page.waitForTimeout(120)
  }
  const box = await target.boundingBox()
  if (box) await page.screenshot({ path: file, clip: box })
  else await panel.screenshot({ path: file })
}

test('the typed words are the bubble; the injected recap is folded away', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const panel = await openSession(page)

  const bubble = row(panel, 'BANNER_TYPED_ONE')
  // innerText (not textContent) is the assertion that means "on screen": a closed
  // disclosure still has its content in the DOM, so a textContent check would pass
  // whether the recap were folded or splashed across the bubble.
  const shown = await bubble.innerText()
  expect(shown).toContain('BANNER_TYPED_ONE please carry on.')
  expect(shown).not.toContain('BANNER_RECAP_MARKER')
  expect(shown).not.toContain('[Conversation context]')
  expect(shown).not.toContain('injected by Walnut')

  // The fold names its author rather than pretending nothing was added.
  const fold = bubble.locator('[data-testid="injected-banner"]')
  await expect(fold).toHaveCount(1)
  await expect(fold).toHaveAttribute('data-banner-name', 'Conversation context')
  await expect(fold.locator('.tool-run-label')).toHaveText('Context Walnut added')
  await expect(bubble.locator('[data-testid="injected-banner-body"]')).toHaveCount(0)

  await shotRow(page, panel, bubble, `${SCREENSHOT_DIR}/folded-typed-text-dominant.png`)
})

test('the fold expands to the recap and collapses again', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const panel = await openSession(page)

  const bubble = row(panel, 'BANNER_TYPED_ONE')
  const fold = bubble.locator('[data-testid="injected-banner"]')
  const toggle = fold.locator('.tool-run-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const body = bubble.locator('[data-testid="injected-banner-body"]')
  await expect(body).toBeVisible()
  await expect(body).toContainText('BANNER_RECAP_MARKER')
  // Opening the recap must not cost the human their own words.
  await expect(bubble).toContainText('BANNER_TYPED_ONE please carry on.')

  await shotRow(page, panel, bubble, `${SCREENSHOT_DIR}/expanded-recap.png`)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(await bubble.innerText()).not.toContain('BANNER_RECAP_MARKER')
})

test('two stacked banner kinds fold into two rows above one message', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const panel = await openSession(page)

  const bubble = row(panel, 'BANNER_TYPED_TWO')
  const folds = bubble.locator('[data-testid="injected-banner"]')
  await expect(folds).toHaveCount(2)
  await expect(folds.nth(0).locator('.tool-run-label')).toHaveText('Task context Walnut added')
  await expect(folds.nth(1).locator('.tool-run-label')).toHaveText('Context Walnut added')

  const shown = await bubble.innerText()
  expect(shown).toContain('BANNER_TYPED_TWO after two blocks.')
  expect(shown).not.toContain('BANNER_TASK_MARKER')
  expect(shown).not.toContain('BANNER_RECAP_MARKER')

  await shotRow(page, panel, bubble, `${SCREENSHOT_DIR}/two-stacked-folds.png`)
})

test('a truncated block leaves the human message whole and readable', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const panel = await openSession(page)

  // No terminator was ever written, so nothing is provably a banner: the row
  // renders exactly as it did before the fold existed. Ugly, and deliberately so
  // — losing the typed words would be the real bug.
  const bubble = row(panel, 'BANNER_TRUNCATED_TYPED')
  await expect(bubble.locator('[data-testid="injected-banner"]')).toHaveCount(0)
  const shown = await bubble.innerText()
  expect(shown).toContain('BANNER_TRUNCATED_TYPED must still be readable.')

  await shotRow(page, panel, bubble, `${SCREENSHOT_DIR}/truncated-block-message-intact.png`)
})

test('a banner-only turn gets no empty chat bubble, and an ordinary turn is untouched', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const panel = await openSession(page)

  // Ordinary message: no fold, no change.
  const plain = row(panel, 'BANNER_PLAIN_TYPED')
  await expect(plain).toHaveClass(/session-msg-user/)
  await expect(plain.locator('[data-testid="injected-banner"]')).toHaveCount(0)

  // The banner-only turn has no typed words to attribute a bubble to, so it drops
  // the bubble chrome (the same treatment a provenance card gets) and renders as a
  // bare muted row. Exactly ONE such row exists in this transcript.
  const bare = panel.locator('.session-msg-envelope:has([data-testid="injected-banner"])')
  await expect(bare).toHaveCount(1)
  await expect(bare).not.toHaveClass(/session-msg-user/)

  // Four folds in total: 1 (typed) + 1 (banner-only) + 2 (stacked). The plain and
  // truncated turns contribute none.
  await expect(panel.locator('[data-testid="injected-banner"]')).toHaveCount(4)

  await panel.screenshot({ path: `${SCREENSHOT_DIR}/panel-all-shapes.png` })
})

test('the Msgs list previews the typed words, and its count agrees', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const panel = await openSession(page)

  // Open the panel's own "Msgs" view through its kebab — a one-line preview has no
  // room to fold anything, so it has to already hold the typed text.
  await panel.locator('.session-panel-header').getByRole('button', { name: 'More actions' }).click()
  const msgsItem = page.locator('.task-kebab-menu:visible .task-kebab-item')
    .filter({ hasText: /Msgs \(/ })
  await expect(msgsItem).toHaveCount(1)
  // Four typed messages: the banner-only turn is not one of "my messages", so the
  // badge count and the list below it agree.
  await expect(msgsItem).toContainText('Msgs (4)')
  await msgsItem.click()

  const items = panel.locator('.user-messages-summary-text')
  await expect(items).toHaveCount(4)
  const texts = await items.allInnerTexts()
  // In transcript order: plain, one block, two blocks, and the truncated one.
  expect(texts[0]).toContain('BANNER_PLAIN_TYPED')
  expect(texts[1]).toBe('BANNER_TYPED_ONE please carry on.')
  expect(texts[2]).toBe('BANNER_TYPED_TWO after two blocks.')
  // The truncated turn is deliberately NOT peeled — nothing proved it was a
  // banner, so its text stays whole here too, artifact and all.
  expect(texts[3]).toContain('BANNER_TRUNCATED_TYPED must still be readable.')
  for (const t of texts.slice(0, 3)) {
    expect(t).not.toContain('BANNER_RECAP_MARKER')
    expect(t).not.toContain('[Conversation context]')
    expect(t).not.toContain('BANNER_TASK_MARKER')
  }

  await panel.locator('.session-action-panel').screenshot({
    path: `${SCREENSHOT_DIR}/msgs-list-typed-only.png`,
  })
})
