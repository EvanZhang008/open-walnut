import { test, expect } from '@playwright/test'

test('turn-retry settings render and toggle via real UI clicks', async ({ page }) => {
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  // Record the URL of every failed response so a bare "404 (Not Found)" console
  // line can be attributed instead of blanket-ignored.
  const failedUrls: string[] = []
  page.on('response', r => { if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url()}`) })

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Seed the fixture server's config so the sub-options render enabled.
  await page.evaluate(async () => {
    await fetch('/api/config', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: {
        idle_timeout_minutes: 30,
        turn_retry: { enabled: true, budget_hours: 12, max_attempts: 200, backoff_seconds: 30, backoff_max_seconds: 600 },
      } }),
    })
  })

  // Open Settings via the sidebar NavLink (real SPA navigation, no page.goto).
  await page.locator('a[href="/settings"]').first().click()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  const sessionsNav = page.getByRole('button', { name: /Tasks & Sessions/i }).first()
  if (await sessionsNav.count()) { await sessionsNav.click(); await page.waitForTimeout(800) }

  const toggle = page.locator('#turn-retry-enabled')
  await toggle.scrollIntoViewIfNeeded()
  await expect(toggle).toHaveCount(1)
  await page.screenshot({ path: '/tmp/turn-retry-verify/01-settings.png' })

  // Enabled → sub-options visible with the seeded values.
  await expect(page.locator('#turn-retry-budget')).toBeVisible()
  await expect(page.locator('#turn-retry-budget')).toHaveValue('12')
  await expect(page.locator('#turn-retry-max-attempts')).toHaveValue('200')
  await expect(page.locator('#turn-retry-backoff')).toHaveValue('30')
  await expect(page.locator('#turn-retry-backoff-max')).toHaveValue('600')

  // Toggle OFF → sub-options collapse.
  await toggle.click()
  await page.waitForTimeout(1500)
  await expect(page.locator('#turn-retry-budget')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/turn-retry-verify/02-collapsed.png' })

  // Toggle ON → values return unchanged (not silently reset to defaults).
  await toggle.click()
  await page.waitForTimeout(1500)
  await expect(page.locator('#turn-retry-budget')).toHaveValue('12')
  await expect(page.locator('#turn-retry-max-attempts')).toHaveValue('200')

  // Edit the budget through the real input; auto-save persists it.
  await page.locator('#turn-retry-budget').fill('6')
  await page.waitForTimeout(3000)
  await page.screenshot({ path: '/tmp/turn-retry-verify/03-budget-6.png' })

  const cfg = await page.evaluate(async () => {
    const r = await fetch('/api/config'); const j = await r.json(); return j?.config?.session?.turn_retry
  })
  console.log('CONFIG AFTER UI EDIT:', JSON.stringify(cfg))
  expect(cfg.enabled).toBe(true)
  expect(cfg.budget_hours).toBe(6)
  expect(cfg.max_attempts).toBe(200)

  // Sibling session config must survive the writes.
  const idle = await page.evaluate(async () => {
    const r = await fetch('/api/config'); const j = await r.json(); return j?.config?.session?.idle_timeout_minutes
  })
  expect(idle).toBe(30)

  console.log('FAILED REQUESTS:', JSON.stringify(failedUrls, null, 2))
  console.log('CONSOLE ERRORS:', JSON.stringify(errors, null, 2))
  // The ONLY tolerated failure is cloud-setup/job, which 404s by design on a
  // fixture server with no cloud job. Anything else (especially a /api/config
  // write failure) must fail this test.
  const unexpectedRequests = failedUrls.filter(u => !/cloud-setup\/job/i.test(u))
  expect(unexpectedRequests).toEqual([])
  const realErrors = errors.filter(e =>
    !/favicon|ResizeObserver|cloud-setup\/job/i.test(e)
    && !/Failed to load resource.*404/i.test(e))
  expect(realErrors).toEqual([])
})
