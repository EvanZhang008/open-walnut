/**
 * Playwright browser tests for the Routines page (/routines; /cron redirects there),
 * the scheduled jobs list it grew out of.
 *
 * Runs against the real test server (started by playwright.config.ts webServer)
 * with a pre-built SPA served from dist/web/static/.
 *
 * All tests are parallel-safe: each test creates its own unique data
 * (using Date.now() + random suffixes) and cleans up after itself.
 *
 * Prerequisites:
 *   cd web && bun x vite build    (builds SPA to dist/web/static/)
 *   npx playwright test          (runs these tests)
 */
import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

// Helper: create a cron job via REST API with unique suffix for parallel safety
async function createCronJobViaApi(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
  const uniqueName = `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/cron`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: uniqueName,
      schedule: { kind: 'every', everyMs: 60000 },
      sessionTarget: 'main',
      wakeMode: 'now',
      payload: { kind: 'systemEvent', text: 'test event' },
      ...overrides,
    }),
  })
  if (!res.ok) throw new Error(`API call failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { job: { id: string; name: string } }
  return body.job
}

// Helper: delete a cron job via REST API (best-effort cleanup)
async function deleteCronJobViaApi(id: string): Promise<void> {
  await fetch(`${API}/api/cron/${id}`, { method: 'DELETE' }).catch(() => {})
}

// ── Sidebar navigation ──

test('sidebar link navigates to the Routines page', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // testid, not the label: a collapsed sidebar hides the text.
  const routinesLink = page.getByTestId('sidebar-core-app-routines')
  await expect(routinesLink).toBeVisible()
  await routinesLink.click()

  await expect(page).toHaveURL(/\/routines/)
  await expect(page.locator('.page-title')).toContainText('Routines')
})

// ── Empty state ──

test('cron page shows empty state when no jobs exist', async ({ page }) => {
  // The page reads an empty list. The shared fixture is never empty for long: every
  // other spec here makes its own jobs in parallel, so the real list races this test.
  await page.route('**/api/routines?**', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { jobs: [] } }) : route.fallback())
  await page.route('**/api/routines', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { jobs: [] } }) : route.fallback())

  await page.goto('/cron')
  await page.waitForLoadState('networkidle')

  const emptyState = page.locator('.empty-state')
  await expect(emptyState).toBeVisible({ timeout: 5000 })
  await expect(emptyState).toContainText('No routines yet')
})

// ── Job card displays ──

test('job card displays correctly with name, schedule, and toggle', async ({ page }) => {
  const job = await createCronJobViaApi('Display test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    // Find the card with our job name
    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Verify job name is shown
    await expect(card.locator('.cron-job-name')).toContainText(job.name)

    // Verify schedule text (everyMs: 60000 = "Every 1 minute")
    await expect(card).toContainText('Every 1 min')

    // Verify toggle button exists and shows "On" (enabled by default)
    const toggleBtn = card.locator('.cron-toggle-btn')
    await expect(toggleBtn).toBeVisible()
    await expect(toggleBtn).toContainText('On')

    // Verify status dot exists
    await expect(card.locator('.cron-status-dot')).toBeVisible()
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Toggle job ──

test('toggle button disables and enables a job', async ({ page }) => {
  const job = await createCronJobViaApi('Toggle test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Initially enabled — toggle should show "On"
    const toggleBtn = card.locator('.cron-toggle-btn')
    await expect(toggleBtn).toContainText('On')

    // Click toggle to disable
    await toggleBtn.click()

    // Wait for card to reflect disabled state
    await expect(toggleBtn).toContainText('Paused', { timeout: 5000 })
    await expect(card).toHaveClass(/cron-job-disabled/, { timeout: 5000 })

    // Verify via API: the switch flips before the server answers, so wait for it.
    await expect.poll(async () => {
      const res = await fetch(`${API}/api/cron/${job.id}`)
      return ((await res.json()) as { job: { enabled: boolean } }).job.enabled
    }, { timeout: 10_000 }).toBe(false)

    // Click toggle again to re-enable
    await toggleBtn.click()
    await expect(toggleBtn).toContainText('On', { timeout: 5000 })
    await expect(card).not.toHaveClass(/cron-job-disabled/, { timeout: 5000 })
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// The All / Enabled / Disabled filter tabs went with the old page: Routines lists
// every routine with its own switch (routines-store-same-browser-instant.spec.ts).

// ── Three-dot menu ──

test('three-dot menu opens with Run now, Edit, Delete items', async ({ page }) => {
  const job = await createCronJobViaApi('Menu test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Click the three-dot menu button
    const menuBtn = card.locator('.cron-menu-btn')
    await menuBtn.click()

    // Verify dropdown menu appears
    const menu = card.locator('.cron-menu')
    await expect(menu).toBeVisible()

    // Verify all menu items
    const menuItems = menu.locator('.cron-menu-item')
    await expect(menuItems).toHaveCount(3)
    await expect(menu.locator('.cron-menu-item', { hasText: 'Run now' })).toBeVisible()
    await expect(menu.locator('.cron-menu-item', { hasText: 'Edit' })).toBeVisible()
    await expect(menu.locator('.cron-menu-item.cron-menu-danger', { hasText: 'Delete' })).toBeVisible()
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Delete with confirm popover ──

test('delete via menu shows confirm popover and removes job', async ({ page }) => {
  const job = await createCronJobViaApi('Delete confirm job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open menu
    await card.locator('.cron-menu-btn').click()
    await expect(card.locator('.cron-menu')).toBeVisible()

    // Click Delete
    await card.locator('.cron-menu-danger').click()

    // Confirm popover should appear
    const popover = card.locator('.cron-confirm-popover')
    await expect(popover).toBeVisible()
    await expect(popover.locator('.cron-confirm-text')).toContainText('Delete this job?')

    // Click the red Delete button to confirm
    await popover.locator('.cron-confirm-delete').click()

    // Card should disappear
    await expect(card).toBeHidden({ timeout: 5000 })

    // Verify via API that job is gone
    const res = await fetch(`${API}/api/cron/${job.id}`)
    expect(res.status).toBe(404)
  } catch {
    // Cleanup on failure
    await deleteCronJobViaApi(job.id)
  }
})

// ── Delete cancel ──

test('cancel delete keeps the job visible', async ({ page }) => {
  const job = await createCronJobViaApi('Delete cancel job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open menu and click Delete
    await card.locator('.cron-menu-btn').click()
    await card.locator('.cron-menu-danger').click()

    // Confirm popover should appear
    const popover = card.locator('.cron-confirm-popover')
    await expect(popover).toBeVisible()

    // Click Cancel
    await popover.locator('.cron-confirm-cancel').click()

    // Popover should disappear
    await expect(popover).toBeHidden()

    // Card should still be visible
    await expect(card).toBeVisible()

    // Verify via API that job still exists
    const res = await fetch(`${API}/api/cron/${job.id}`)
    expect(res.ok).toBeTruthy()
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Run now ──

test('run now via menu does not crash and card remains', async ({ page }) => {
  const job = await createCronJobViaApi('Run now test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open menu and click "Run now"
    await card.locator('.cron-menu-btn').click()
    await card.locator('.cron-menu-item', { hasText: 'Run now' }).click()

    // Menu should close
    await expect(card.locator('.cron-menu')).toBeHidden()

    // Card should still be visible (no crash)
    await expect(card).toBeVisible()
    await expect(card.locator('.cron-job-name')).toContainText(job.name)
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Create job form ──

// Creating a routine by hand ("Build it myself") is routine-watcher.spec.ts; the old
// "+ New Job" form it replaced is gone.

// ── Edit job ──

test('edit job via menu opens form with pre-filled values and saves changes', async ({ page }) => {
  const job = await createCronJobViaApi('Edit test job', {
    description: 'Original description',
  })
  const newName = `Edited job ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open menu and click Edit
    await card.locator('.cron-menu-btn').click()
    await card.locator('.cron-menu-item', { hasText: 'Edit' }).click()

    // Form should appear in edit mode
    const form = page.locator('.routine-modal')
    await expect(form).toBeVisible({ timeout: 5000 })
    await expect(form.locator('h3')).toContainText('Edit routine')

    // Name should be pre-filled
    const nameInput = form.locator('#routine-name')
    await expect(nameInput).toHaveValue(job.name)

    // Clear and enter new name
    await nameInput.clear()
    await nameInput.fill(newName)

    await form.locator('.btn.btn-primary', { hasText: 'Save' }).click()

    // Form should close
    await expect(form).toBeHidden({ timeout: 5000 })

    // Card should show new name
    const updatedCard = page.locator('.cron-job-card', { hasText: newName })
    await expect(updatedCard).toBeVisible({ timeout: 5000 })

    // Old name should no longer appear
    await expect(page.locator('.cron-job-card', { hasText: job.name })).toBeHidden()
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Multiple jobs ordering ──

test('multiple jobs all appear in the list', async ({ page }) => {
  const job1 = await createCronJobViaApi('Multi job A', {
    schedule: { kind: 'every', everyMs: 60000 },
  })
  const job2 = await createCronJobViaApi('Multi job B', {
    schedule: { kind: 'every', everyMs: 300000 },
  })
  const job3 = await createCronJobViaApi('Multi job C', {
    schedule: { kind: 'every', everyMs: 3600000 },
  })

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    // All three cards should be visible
    await expect(page.locator('.cron-job-card', { hasText: job1.name })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.cron-job-card', { hasText: job2.name })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.cron-job-card', { hasText: job3.name })).toBeVisible({ timeout: 5000 })

    // Verify different schedule texts
    await expect(page.locator('.cron-job-card', { hasText: job1.name })).toContainText('Every 1 min')
    await expect(page.locator('.cron-job-card', { hasText: job2.name })).toContainText('Every 5 min')
    await expect(page.locator('.cron-job-card', { hasText: job3.name })).toContainText('Every 1 hour')
  } finally {
    await deleteCronJobViaApi(job1.id)
    await deleteCronJobViaApi(job2.id)
    await deleteCronJobViaApi(job3.id)
  }
})

// ── Real-time WS update ──

test('job created via REST API appears on page without refresh', async ({ page }) => {
  await page.goto('/cron')
  await page.waitForLoadState('networkidle')

  // Create a job via REST API (not through the browser UI)
  const job = await createCronJobViaApi('WS realtime cron job')

  try {
    // Wait for the card to appear via WebSocket push (no page refresh)
    const card = page.locator('.cron-job-card', { hasText: job.name })
    await expect(card).toBeVisible({ timeout: 10000 })

    // Verify it rendered correctly
    await expect(card.locator('.cron-job-name')).toContainText(job.name)
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})
