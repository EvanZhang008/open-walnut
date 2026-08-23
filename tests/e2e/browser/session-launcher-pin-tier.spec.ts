/**
 * Session launcher pin tier — the default and its deliberate NON-stickiness,
 * driven through the real UI.
 *
 * Two reported behaviors, fixed in two rounds. First: the launcher always opened
 * pinned to Focus with the tier picker buried in "More", so every launch cost a
 * trip into the menu to move the task out of Focus. Then the fix that replaced it
 * (remember the last tier picked, mirrored across browsers) turned out to have the
 * same shape of bug one level up: one Focus pick on a genuinely urgent session made
 * every later ordinary session open on Focus, and the pinned area filled up again.
 *
 * Asserts what the user sees:
 *   1. the tier picker sits in the launcher's PRIMARY row (no More click),
 *   2. every launcher defaults to Satellite,
 *   3. a pick applies to THAT launch only — a fresh "+" is back on Satellite,
 *   4. the picked tier reaches the quick-start payload,
 *   5. an explicit unpin reaches it as `null`, not as an omitted field.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftPanel, openDraft } from './draft-helpers'

/**
 * Open a FRESH launcher: "+" grows a draft session column, and its cwd pill opens
 * the same picker (unchanged `.sps-*` markup, footer included).
 *
 * Both handles are returned because the two live in different places: the tier
 * picker is inside the popover, while the message that actually launches is typed
 * in the draft column's own composer.
 *
 * No pref seeding anywhere in this file any more. That was pure defence against a
 * synced sticky-tier value the SHARED fixture server carried between specs — with
 * the stickiness gone there is no such value, which is itself part of the win: one
 * spec's tier pick can no longer decide what another spec calls "a fresh browser".
 */
async function openLauncher(page: Page): Promise<{ panel: Locator; selector: Locator }> {
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })
  return { panel, selector }
}

/**
 * Discard the launcher, popover AND draft column.
 *
 * The column has to go, not just the popover: a draft snapshots its launch meta
 * ONCE, when it is created (freshLauncherMeta), and the picker is seeded from that
 * snapshot (initialMeta). Re-opening the picker on the SAME draft replays the
 * snapshot, so only a fresh "+" is really "open the launcher again". Closing the
 * draft is also the gesture a user has for "never mind", so this stays real UI.
 */
async function closeLauncher(page: Page) {
  // Dismiss the popout picker FIRST — anchored to the pill it can float over
  // the draft's ✕ (Playwright then reports the panel intercepting the click).
  // A raw click outside the panel is the dismiss gesture; the outside-click
  // listener attaches on a 100ms timer, so poll until it lands.
  await expect(async () => {
    if (await page.locator('.session-path-selector').count() > 0) {
      await page.mouse.click(10, 10)
    }
    await expect(page.locator('.session-path-selector')).toHaveCount(0, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await draftPanel(page).locator('.session-panel-close').click()
  await expect(page.locator('.draft-session-panel')).toHaveCount(0)
}

test('launcher defaults to Satellite, and a pick lasts exactly one launch', async ({ page }) => {
  await page.goto('/')

  let { selector } = await openLauncher(page)
  let tiers = selector.getByRole('group', { name: 'Pin new task to tier' })

  // 1 + 2: visible in the primary row (no More menu click) and defaulting to Satellite.
  await expect(tiers).toBeVisible()
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: '/tmp/launcher-pin-tier/default-satellite.png' })

  // The pick lands on THIS draft.
  await tiers.getByRole('button', { name: 'Wait' }).click()
  await expect(tiers.getByRole('button', { name: 'Wait' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'false')

  // 3: THE regression guard. A fresh launcher is back on Satellite — the previous
  // pick was for that launch, not a preference. This is the assertion that used to
  // read the other way round (expecting Wait), and flipping it is the whole change.
  await closeLauncher(page)
  ;({ selector } = await openLauncher(page))
  tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Wait' })).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: '/tmp/launcher-pin-tier/fresh-back-to-satellite.png' })

  // Clicking the active tier unpins — and THAT does not persist either.
  await tiers.getByRole('button', { name: 'Satellite' }).click()
  for (const label of ['Focus', 'Satellite', 'Backlog', 'Wait']) {
    await expect(tiers.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
  }
  await closeLauncher(page)
  ;({ selector } = await openLauncher(page))
  tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')
})

test('the launcher sends the picked tier in the quick-start payload', async ({ page }) => {
  await page.goto('/')

  const { panel, selector } = await openLauncher(page)
  const tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')

  // Pick a folder → the popover closes onto the draft's cwd pill, and the first
  // message launches. The payload is the contract the server pins from.
  const input = selector.locator('.sps-search input').first()
  await input.click()
  await input.fill('/tmp/')
  const firstRow = selector.locator('.sps-path-item').first()
  if (await firstRow.count() > 0) {
    await firstRow.click()
  }
  const go = selector.locator('.sps-status-btn')
  await expect(go).toBeVisible({ timeout: 10_000 })

  const launchRequest = page.waitForRequest(req =>
    req.url().includes('/api/sessions/quick-start') && req.method() === 'POST', { timeout: 20_000 })
  await go.click()
  await expect(selector).toBeHidden()

  // The DRAFT column's composer, not the main chat's — the latter would message
  // the Personal AI and this spec would wait 20s for a quick-start that never fires.
  const chatInput = panel.locator('.chat-input-textarea')
  await expect(chatInput).toBeVisible({ timeout: 10_000 })
  await chatInput.click()
  await chatInput.fill(`pin tier payload probe ${Date.now()}`)
  await chatInput.press('Enter')

  const payload = (await launchRequest).postDataJSON() as {
    taskMeta?: { pinTier?: string | null }
  }
  expect(payload.taskMeta?.pinTier).toBe('satellite')
})

/**
 * An explicit unpin must reach the server as `pinTier: null`, NOT as an omitted
 * field. JSON.stringify drops undefined, and the server reads an absent pinTier
 * as "client didn't choose" — which for a fix-walnut launch means it pins to
 * Focus. So unpinning used to be silently overridden back to Focus.
 */
test('an explicit unpin is sent as null, not dropped from the payload', async ({ page }) => {
  await page.goto('/')

  const { panel, selector } = await openLauncher(page)
  const tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  // Click the ACTIVE tier to toggle it off — the "don't pin this one" gesture.
  await tiers.getByRole('button', { name: 'Satellite' }).click()
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'false')

  const input = selector.locator('.sps-search input').first()
  await input.click()
  await input.fill('/tmp/')
  const go = selector.locator('.sps-status-btn')
  await expect(go).toBeVisible({ timeout: 10_000 })

  const launchRequest = page.waitForRequest(req =>
    req.url().includes('/api/sessions/quick-start') && req.method() === 'POST', { timeout: 20_000 })
  await go.click()
  await expect(selector).toBeHidden()

  // Scoped to the draft column (see the sibling test) — the main chat composer
  // does not launch sessions.
  const chatInput = panel.locator('.chat-input-textarea')
  await expect(chatInput).toBeVisible({ timeout: 10_000 })
  await chatInput.click()
  await chatInput.fill(`explicit unpin probe ${Date.now()}`)
  await chatInput.press('Enter')

  const raw = (await launchRequest).postDataJSON() as {
    taskMeta?: Record<string, unknown>
  }
  // The KEY must be present and null — `toBeUndefined()` would also pass on a
  // dropped field, which is exactly the bug.
  expect(raw.taskMeta).toBeDefined()
  expect('pinTier' in (raw.taskMeta ?? {})).toBe(true)
  expect(raw.taskMeta?.pinTier).toBeNull()
})
