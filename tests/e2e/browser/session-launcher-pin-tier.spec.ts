/**
 * Session launcher pin tier — default + stickiness, driven through the real UI.
 *
 * Reported behavior: the launcher always opened pinned to Focus, and the tier
 * picker was buried in the "More" menu, so every launch cost a trip into the
 * menu to move the task out of Focus.
 *
 * Asserts what the user sees:
 *   1. the tier picker sits in the launcher's PRIMARY row (no More click),
 *   2. a fresh browser defaults to Satellite,
 *   3. the tier the user picks survives closing + reopening the launcher,
 *   4. that pick is mirrored to the server (PUT /api/ui-prefs) so it follows
 *      the user to another browser.
 */

import { test, expect, type Page } from '@playwright/test'

const PREF_KEY = 'open-walnut-launcher-pin-tier'

/**
 * Put the sticky pref into a known state for THIS page load.
 *
 * `localStorage.removeItem` is the WRONG reset for a synced key: ui-prefs-sync's
 * boot merge adopts the server value whenever the local one is null, and the
 * fixture server's ui-prefs.json is shared by every spec in the run (and
 * survives re-runs), so a stale `wait`/`none` from an earlier spec would decide
 * what "a fresh browser" sees. Instead seed a real local value before any app
 * code runs — a local value with no tracked timestamp always wins that merge.
 *
 * Pass null to simulate a never-chose-anything browser: the server entry is
 * tombstoned first (so the merge has nothing to adopt), then the key is cleared.
 */
async function seedPinTierPref(page: Page, value: 'focus' | 'satellite' | 'backlog' | 'wait' | 'none' | null) {
  if (value === null) {
    await page.request.put('/api/ui-prefs', {
      data: { prefs: { [PREF_KEY]: { v: null, ts: Date.now() } } },
    })
  }
  await page.addInitScript(([key, v]) => {
    try {
      if (v === null) localStorage.removeItem(key as string)
      else localStorage.setItem(key as string, v as string)
    } catch { /* storage disabled — the app falls back to its default */ }
  }, [PREF_KEY, value] as const)
}

async function openLauncher(page: Page) {
  const pill = page.getByRole('button', { name: /Quick session|\+ Session/i })
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()
  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })
  return selector
}

async function closeLauncher(page: Page) {
  const selector = page.locator('.session-path-selector')
  // Escape is handled on the path input, so focus has to be there — after a tier
  // click it sits on the button and the key would go nowhere. Edit mode also eats
  // the first Escape (it clears the typed path), hence the retry.
  for (let i = 0; i < 3 && await selector.count() > 0; i++) {
    await selector.locator('.sps-search input').first().click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
  await expect(selector).toHaveCount(0)
}

test('launcher defaults to Satellite and remembers the tier the user picks', async ({ page }) => {
  // A never-chose-anything browser: nothing local AND nothing on the server, so
  // the app has to fall back to its own default.
  await seedPinTierPref(page, null)
  await page.goto('/')

  let selector = await openLauncher(page)
  let tiers = selector.getByRole('group', { name: 'Pin new task to tier' })

  // 1 + 2: visible in the primary row (no More menu click) and defaulting to Satellite.
  await expect(tiers).toBeVisible()
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: '/tmp/launcher-pin-tier/default-satellite.png' })

  // 4: the pick is mirrored server-side (ui-prefs), which is what makes it
  // survive a different browser rather than just this localStorage.
  const prefPut = page.waitForRequest(req =>
    req.url().includes('/api/ui-prefs')
    && req.method() === 'PUT'
    && JSON.stringify(req.postDataJSON()).includes(PREF_KEY), { timeout: 15_000 })

  await tiers.getByRole('button', { name: 'Wait' }).click()
  await expect(tiers.getByRole('button', { name: 'Wait' })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'false')
  await prefPut

  // 3: reopening the launcher opens on the remembered tier, not the baseline.
  await closeLauncher(page)
  selector = await openLauncher(page)
  tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Wait' })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: '/tmp/launcher-pin-tier/remembered-wait.png' })

  // Clicking the active tier unpins — and "unpinned" is remembered too (it must
  // not snap back to the default on the next open).
  await tiers.getByRole('button', { name: 'Wait' }).click()
  await expect(tiers.getByRole('button', { name: 'Wait' })).toHaveAttribute('aria-pressed', 'false')
  await closeLauncher(page)
  selector = await openLauncher(page)
  tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  for (const label of ['Focus', 'Satellite', 'Wait']) {
    await expect(tiers.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false')
  }
  // Deliberately NO "restore the pref" click here: the debounced PUT would be
  // lost when Playwright closes the page, so it never actually restored anything.
  // Every spec seeds its own state instead (seedPinTierPref).
})

test('the launcher sends the picked tier in the quick-start payload', async ({ page }) => {
  // Seed the tier explicitly — this asserts what the launcher SENDS, so the
  // starting tier must not depend on what an earlier spec left on the server.
  await seedPinTierPref(page, 'satellite')
  await page.goto('/')

  const selector = await openLauncher(page)
  const tiers = selector.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')

  // Pick a folder → the launcher collapses into the quick-start bar, and the
  // first message launches. The payload is the contract the server pins from.
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

  const chatInput = page.locator('.chat-input-textarea')
  await expect(chatInput).toBeVisible({ timeout: 10_000 })
  await chatInput.click()
  await chatInput.fill(`pin tier payload probe ${Date.now()}`)
  await chatInput.press('Enter')

  const payload = (await launchRequest).postDataJSON() as {
    taskMeta?: { pinTier?: string | null; starred?: boolean }
  }
  expect(payload.taskMeta?.pinTier).toBe('satellite')
  expect(payload.taskMeta?.starred).toBe(true)
})

/**
 * An explicit unpin must reach the server as `pinTier: null`, NOT as an omitted
 * field. JSON.stringify drops undefined, and the server reads an absent pinTier
 * as "client didn't choose" — which for a fix-walnut launch means it pins to
 * Focus. So unpinning used to be silently overridden back to Focus.
 */
test('an explicit unpin is sent as null, not dropped from the payload', async ({ page }) => {
  await seedPinTierPref(page, 'satellite')
  await page.goto('/')

  const selector = await openLauncher(page)
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

  const chatInput = page.locator('.chat-input-textarea')
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
