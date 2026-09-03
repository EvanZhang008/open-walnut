import { test, expect } from '@playwright/test'

/**
 * Turn-error auto-retry is configured in Settings → Hooks, alongside every other
 * automatic behavior — including its knobs, which the hook DECLARES as settings
 * (src/core/hooks/settings.ts) rather than getting a hand-written block in some
 * other settings section.
 *
 * This drives the real UI: sidebar navigation, the hook card's toggle, and a
 * number input committed on blur.
 */
test('turn-retry is configurable from the Hooks page via real UI clicks', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  // Record failed request URLs so a bare "404 (Not Found)" console line can be
  // attributed rather than blanket-ignored.
  const failedUrls: string[] = []
  page.on('response', r => { if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url()}`) })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Seed: retry ON with known values, plus a sibling policy that must survive.
  await page.evaluate(async () => {
    await fetch('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: {
        cron_policy: 'session-only',
        idle_timeout_minutes: 30,
        turn_retry: { enabled: true, budget_hours: 12, max_attempts: 200 },
      } }),
    })
  })

  // Real SPA navigation to Settings (never page.goto).
  await page.locator('a[href="/settings"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1000)

  // Into the Hooks section.
  await page.getByRole('button', { name: /^Hooks$/i }).first().click()
  await page.waitForTimeout(1500)

  const toggle = page.locator('#hook-toggle-turn-error-auto-retry')
  await expect(toggle).toHaveCount(1)
  await toggle.scrollIntoViewIfNeeded()

  // The hook card must show it as a DAEMON policy (that's the whole point of
  // where the retry runs), with its config key visible.
  const card = page.locator('.hook-card', { has: toggle })
  await expect(card).toContainText(/daemon-policy/i)
  await expect(card).toContainText('session.turn_retry.enabled')
  await expect(card).toContainText(/daemon:turn-result/i)
  await page.screenshot({ path: '/tmp/turn-retry-verify/10-hooks-card.png' })

  // Declared knobs render with their current values.
  const budget = page.locator('#hook-setting-turn-error-auto-retry-budget_hours')
  await expect(budget).toHaveValue('12')
  await expect(page.locator('#hook-setting-turn-error-auto-retry-max_attempts')).toHaveValue('200')
  // An unset knob falls back to its declared default rather than rendering blank.
  await expect(page.locator('#hook-setting-turn-error-auto-retry-backoff_seconds')).toHaveValue('30')

  // Edit the budget through the real input; commits on blur.
  await budget.fill('6')
  await budget.blur()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: '/tmp/turn-retry-verify/11-budget-6.png' })

  const afterEdit = await page.evaluate(async () => {
    const r = await fetch('/api/config'); const j = await r.json()
    return j?.config?.session
  })
  expect(afterEdit.turn_retry.budget_hours).toBe(6)
  expect(afterEdit.turn_retry.enabled).toBe(true)       // toggle untouched
  expect(afterEdit.turn_retry.max_attempts).toBe(200)   // sibling knob untouched
  expect(afterEdit.cron_policy).toBe('session-only')    // unrelated policy untouched
  expect(afterEdit.idle_timeout_minutes).toBe(30)

  // The UI reflects the committed value after its reload.
  await expect(budget).toHaveValue('6')

  // Toggling OFF hides the knobs (tuning shown for something not running reads
  // as "active") but must NOT reset the stored values.
  await toggle.click()
  await page.waitForTimeout(2500)
  await expect(page.locator('#hook-setting-turn-error-auto-retry-budget_hours')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/turn-retry-verify/12-toggled-off.png' })

  const afterOff = await page.evaluate(async () => {
    const r = await fetch('/api/config'); const j = await r.json()
    return j?.config?.session
  })
  expect(afterOff.turn_retry.enabled).toBe(false)
  expect(afterOff.turn_retry.budget_hours).toBe(6)      // preserved, not reset
  expect(afterOff.cron_policy).toBe('session-only')

  // Back ON → the knobs return with the value the user set.
  await toggle.click()
  await page.waitForTimeout(2500)
  await expect(page.locator('#hook-setting-turn-error-auto-retry-budget_hours')).toHaveValue('6')

  // The daemon-restart banner appears, since this is enforced in the daemon.
  await expect(page.locator('.hook-banner')).toContainText(/daemon restarts/i)
  await page.screenshot({ path: '/tmp/turn-retry-verify/13-back-on.png' })

  console.log('FAILED REQUESTS:', JSON.stringify(failedUrls, null, 2))
  console.log('CONSOLE ERRORS:', JSON.stringify(errors, null, 2))
  // cloud-setup/job 404s by design on a fixture server with no cloud job.
  // Anything else — above all a failed /api/hooks write — must fail this test.
  expect(failedUrls.filter(u => !/cloud-setup\/job/i.test(u))).toEqual([])
  expect(errors.filter(e =>
    !/favicon|ResizeObserver|cloud-setup\/job/i.test(e)
    && !/Failed to load resource.*404/i.test(e))).toEqual([])
})

/**
 * The retry must have exactly ONE editor. It used to also live in Tasks &
 * Sessions; two pages writing the same config key means whichever saved last
 * wins and the user cannot tell which.
 */
test('Sessions does not duplicate the retry editor', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('a[href="/settings"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.getByTestId('settings-nav-sessions').click()
  await page.waitForTimeout(1200)

  await expect(page.locator('#turn-retry-enabled')).toHaveCount(0)
  await expect(page.locator('#turn-retry-budget')).toHaveCount(0)
  // The section itself still renders its own controls.
  await expect(page.locator('#idle-timeout')).toBeVisible()
  await page.screenshot({ path: '/tmp/turn-retry-verify/20-sessions-no-dup.png' })

  // Hooks is the single home for it.
  await page.getByRole('button', { name: /^Hooks$/i }).first().click()
  await page.waitForTimeout(1200)
  await expect(page.locator('#hook-toggle-turn-error-auto-retry')).toHaveCount(1)
})
