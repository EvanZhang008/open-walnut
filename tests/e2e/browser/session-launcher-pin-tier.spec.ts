/**
 * Session launcher pin tier — the default and its deliberate NON-stickiness,
 * driven through the real UI.
 *
 * Four rounds of history. First the launcher always opened pinned to Focus with
 * the tier picker buried in "More", so every launch cost a trip into the menu to
 * move the task out of Focus. The fix that replaced it (remember the last tier
 * picked, mirrored across browsers) had the same shape of bug one level up: one
 * Focus pick on a genuinely urgent session made every later ordinary session open
 * on Focus. So the default became Satellite with a visible one-click picker in the
 * draft column. Then (2026-09-15) the user asked for that picker row to go
 * altogether ("complicated for people") and for every new task to land in Focus:
 * the default is Focus again, and NOTHING is remembered. The folder picker's
 * footer kept a tier row for a while; it is gone too, so the one place a launch's
 * tier is changed is the draft's More menu (or the tier chip, same menu), which
 * this spec drives.
 *
 * Asserts what the user sees:
 *   1. every launcher defaults to Focus,
 *   2. a pick applies to THAT launch only — a fresh "+" is back on Focus,
 *   3. the default and a More pick both reach the quick-start payload,
 *   4. an explicit unpin reaches it as `null`, not as an omitted field.
 *
 * No pref seeding anywhere in this file. That was pure defence against a synced
 * sticky-tier value the SHARED fixture server carried between specs — with the
 * stickiness gone there is no such value, which is itself part of the win: one
 * spec's tier pick can no longer decide what another spec calls "a fresh browser".
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftCwdPill, draftPanel, draftPanels, draftTaskMenu, openDraft, openDraftSettings } from './draft-helpers'

const TIERS = ['Focus', 'Satellite', 'Parked'] as const

/** One tier button of the open More menu (the label sits after an icon span). */
const tierBtn = (menu: Locator, label: string): Locator =>
  menu.locator('.task-kebab-tier-btn').filter({ hasText: label })

/** Open the draft's More menu, check which tier is lit (null = unpinned), close it. */
async function expectLitTier(panel: Locator, lit: (typeof TIERS)[number] | null): Promise<void> {
  const menu = await openDraftSettings(panel, 'more')
  for (const label of TIERS) {
    // Only the lit tier carries aria-pressed; the others have no attribute at all.
    if (label === lit) await expect(tierBtn(menu, label)).toHaveAttribute('aria-pressed', 'true')
    else await expect(tierBtn(menu, label)).not.toHaveAttribute('aria-pressed', 'true')
  }
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveCount(lit ? 1 : 0)
  await panel.page().keyboard.press('Escape')
  await expect(draftTaskMenu(panel.page())).toHaveCount(0)
}

/** Click one tier in the draft's More menu (the menu closes on the pick). */
async function pickTier(panel: Locator, label: (typeof TIERS)[number]): Promise<void> {
  const menu = await openDraftSettings(panel, 'more')
  await tierBtn(menu, label).click()
  await expect(draftTaskMenu(panel.page())).toHaveCount(0)
}

/**
 * Discard the draft column. A draft snapshots its launch meta ONCE, when it is
 * created (freshLauncherMeta), so only a fresh "+" is really "open the launcher
 * again". Closing the draft is also the gesture a user has for "never mind", so
 * this stays real UI.
 */
async function closeLauncher(page: Page) {
  await draftPanel(page).locator('.session-panel-close').click()
  await expect(draftPanels(page)).toHaveCount(0)
}

/**
 * Point the draft at /tmp through the folder picker, send one message from the
 * draft's own composer, and return the quick-start body. The composer is the
 * DRAFT column's, not the main chat's — the latter would message the Personal AI
 * and the launch would never fire.
 */
async function launchAndCapture(page: Page, panel: Locator, text: string): Promise<{ taskMeta?: Record<string, unknown> }> {
  await draftCwdPill(panel).click()
  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })
  // The picker picks a folder and a host only: no tier row in it any more.
  await expect(selector.locator('.pin-tier-options, .task-kebab-tier-btn')).toHaveCount(0)
  const input = selector.locator('.sps-search input').first()
  await input.click()
  await input.fill('/tmp/')
  const go = selector.locator('.sps-status-btn')
  await expect(go).toBeVisible({ timeout: 10_000 })
  await go.click()
  await expect(selector).toBeHidden()

  const launchRequest = page.waitForRequest(req =>
    req.url().includes('/api/sessions/quick-start') && req.method() === 'POST', { timeout: 20_000 })
  const chatInput = panel.locator('.chat-input-textarea')
  await expect(chatInput).toBeVisible({ timeout: 10_000 })
  await chatInput.click()
  await chatInput.fill(text)
  await chatInput.press('Enter')
  return (await launchRequest).postDataJSON() as { taskMeta?: Record<string, unknown> }
}

test('launcher defaults to Focus, and a pick lasts exactly one launch', async ({ page }) => {
  await page.goto('/')

  let panel = await openDraft(page)
  // 1: a fresh draft is on Focus.
  await expectLitTier(panel, 'Focus')
  await page.screenshot({ path: '/tmp/launcher-pin-tier/default-focus.png' })

  // The pick lands on THIS draft.
  await pickTier(panel, 'Parked')
  await expectLitTier(panel, 'Parked')

  // 2: THE regression guard. A fresh launcher is back on Focus — the previous
  // pick was for that launch, not a preference. This is the assertion that once
  // read the other way round (expecting Wait), and flipping it was the whole change.
  await closeLauncher(page)
  panel = await openDraft(page)
  await expectLitTier(panel, 'Focus')
  await page.screenshot({ path: '/tmp/launcher-pin-tier/fresh-back-to-focus.png' })

  // Clicking the active tier unpins — and THAT does not persist either.
  await pickTier(panel, 'Focus')
  await expectLitTier(panel, null)
  await closeLauncher(page)
  panel = await openDraft(page)
  await expectLitTier(panel, 'Focus')
})

test('the launcher sends the default tier in the quick-start payload', async ({ page }) => {
  await page.goto('/')
  const panel = await openDraft(page)
  const payload = await launchAndCapture(page, panel, `pin tier payload probe ${Date.now()}`)
  expect(payload.taskMeta?.pinTier).toBe('focus')
})

test('a tier picked in More rides the quick-start payload, through the folder pick', async ({ page }) => {
  await page.goto('/')
  const panel = await openDraft(page)
  // Picked BEFORE the folder: the folder pick must not write the tier back.
  await pickTier(panel, 'Parked')
  const payload = await launchAndCapture(page, panel, `pin tier pick probe ${Date.now()}`)
  // Parked is the board's `wait` tier.
  expect(payload.taskMeta?.pinTier).toBe('wait')
})

/**
 * An explicit unpin must reach the server as `pinTier: null`, NOT as an omitted
 * field. JSON.stringify drops undefined, and the server reads an absent pinTier
 * as "client didn't choose" and applies its own default pin. So unpinning used to
 * be silently overridden back into a tier.
 */
test('an explicit unpin is sent as null, not dropped from the payload', async ({ page }) => {
  await page.goto('/')
  const panel = await openDraft(page)
  // Click the ACTIVE tier to toggle it off — the "don't pin this one" gesture.
  await pickTier(panel, 'Focus')
  await expectLitTier(panel, null)

  const raw = await launchAndCapture(page, panel, `explicit unpin probe ${Date.now()}`)
  // The KEY must be present and null — `toBeUndefined()` would also pass on a
  // dropped field, which is exactly the bug.
  expect(raw.taskMeta).toBeDefined()
  expect('pinTier' in (raw.taskMeta ?? {})).toBe(true)
  expect(raw.taskMeta?.pinTier).toBeNull()
})
