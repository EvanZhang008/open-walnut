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

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

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
  // A cron push now reads the one routine it names (GET /api/routines/:id, 867216a2e), and the
  // other specs' jobs push all the time: that read added their routine to the empty list (CI
  // 2026-11-10, both tries). Gone here, as it is from the list.
  await page.route(/\/api\/routines\/(?!executors(?:[?#]|$))[^/?#]+(?:\?[^#]*)?$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 404, json: { error: 'not found' } }) : route.fallback())

  await page.goto('/cron')
  await page.waitForLoadState('networkidle')

  const emptyState = page.locator('.empty-state')
  await expect(emptyState).toBeVisible({ timeout: 5000 })
  await expect(emptyState).toContainText('No routines yet')
})

// ── Job row displays ──

// A routine is one line until it is opened: the dot, the name, the timing line and
// the switch. Everything else (Run now, Edit, Delete, the facts) is in the detail.
function rowOf(page: import('@playwright/test').Page, name: string) {
  return page.locator('.cron-job-card', { hasText: name })
}

async function openRow(row: import('@playwright/test').Locator) {
  const line = row.locator('.routine-row-main')
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(row.locator('.routine-detail')).toBeVisible()
}

test('job row displays correctly with name, schedule, and switch', async ({ page }) => {
  const job = await createCronJobViaApi('Display test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    // Find the row with our job name
    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })
    await expect(card).toHaveAttribute('data-routine-id', job.id)

    // Verify job name is shown
    await expect(card.locator('.cron-job-name')).toContainText(job.name)

    // Verify the timing line (everyMs: 60000 = "Every 1 min")
    await expect(card.locator('.cron-job-desc')).toContainText('Every 1 min')

    // The switch is on (enabled by default) and names what a click does
    const toggle = page.getByTestId(`routine-switch-${job.id}`)
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('role', 'switch')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toHaveAttribute('aria-label', `Pause ${job.name}`)

    // Verify status dot exists and says the routine is on
    const dot = card.locator('.cron-status-dot')
    await expect(dot).toBeVisible()
    await expect(dot).toHaveAttribute('aria-label', 'On')
    await expect(card).toHaveAttribute('data-health', 'ok')

    // Closed by default: no detail, no actions
    await expect(card.locator('.routine-row-main')).toHaveAttribute('aria-expanded', 'false')
    await expect(card.locator('.routine-detail')).toHaveCount(0)
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Toggle job ──

test('switch pauses and resumes a job', async ({ page }) => {
  const job = await createCronJobViaApi('Toggle test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })

    // Initially enabled: the switch is on
    const toggle = page.getByTestId(`routine-switch-${job.id}`)
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    // Click the switch to pause
    await toggle.click()

    // Wait for the row to reflect the paused state
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 5000 })
    await expect(card).toHaveClass(/cron-job-disabled/, { timeout: 5000 })
    await expect(card).toHaveAttribute('data-health', 'off')
    await expect(card.locator('.cron-status-dot')).toHaveAttribute('aria-label', 'Paused', { timeout: 5000 })
    await expect(card.locator('.cron-job-desc')).toContainText('Paused', { timeout: 5000 })
    await expect(toggle).toHaveAttribute('aria-label', `Resume ${job.name}`)
    // The switch never opens the row: it is a sibling of the line button
    await expect(card.locator('.routine-row-main')).toHaveAttribute('aria-expanded', 'false')

    // Verify via API: the switch flips before the server answers, so wait for it.
    await expect.poll(async () => {
      const res = await fetch(`${API}/api/cron/${job.id}`)
      return ((await res.json()) as { job: { enabled: boolean } }).job.enabled
    }, { timeout: 10_000 }).toBe(false)

    // Click the switch again to resume
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5000 })
    await expect(card).not.toHaveClass(/cron-job-disabled/, { timeout: 5000 })
    await expect(card.locator('.cron-status-dot')).toHaveAttribute('aria-label', 'On', { timeout: 5000 })
    await expect(card.locator('.cron-job-desc')).not.toContainText('Paused')
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// The All / Enabled / Disabled filter tabs went with the old page: Routines lists
// every routine with its own switch (routines-store-same-browser-instant.spec.ts).

// ── Opening a row ──

test('opening a row shows Run now, Edit, Delete', async ({ page }) => {
  const job = await createCronJobViaApi('Menu test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })

    // Click the row's line to open it in place
    await openRow(card)
    await expect(card).toHaveClass(/routine-row-open/)

    // The detail lists the facts and the actions
    const detail = card.locator('.routine-detail')
    await expect(detail.locator('dl.routine-facts')).toContainText('When')
    await expect(detail.getByRole('button', { name: 'Run now', exact: true })).toBeVisible()
    await expect(detail.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()
    await expect(detail.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
    // No task behind a main-agent job, so no way into one
    await expect(detail.getByRole('button', { name: 'Open task' })).toHaveCount(0)

    // Clicking the line again closes it
    await card.locator('.routine-row-main').click()
    await expect(card.locator('.routine-row-main')).toHaveAttribute('aria-expanded', 'false')
    await expect(card.locator('.routine-detail')).toHaveCount(0)
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Delete with inline confirm ──

test('delete from the open row asks to confirm and removes the job', async ({ page }) => {
  const job = await createCronJobViaApi('Delete confirm job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open the row and click Delete
    await openRow(card)
    await card.getByRole('button', { name: 'Delete', exact: true }).click()

    // The inline confirm replaces the actions
    await expect(card.locator('.cron-confirm-text')).toContainText('Delete this routine?')
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)

    // Click the red Delete button to confirm
    await card.locator('.cron-confirm-delete').click()

    // Row should disappear
    await expect(card).toBeHidden({ timeout: 5000 })

    // Verify via API that job is gone
    await expect.poll(async () => (await fetch(`${API}/api/cron/${job.id}`)).status, { timeout: 5000 }).toBe(404)
  } finally {
    // Cleanup on failure (a 404 when the test passed)
    await deleteCronJobViaApi(job.id)
  }
})

// ── Delete cancel ──

test('cancel delete keeps the job visible', async ({ page }) => {
  const job = await createCronJobViaApi('Delete cancel job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open the row and click Delete
    await openRow(card)
    await card.getByRole('button', { name: 'Delete', exact: true }).click()

    // The confirm should appear
    const confirmText = card.locator('.cron-confirm-text')
    await expect(confirmText).toBeVisible()

    // Click Cancel
    await card.locator('.cron-confirm-cancel').click()

    // The confirm should disappear and the actions come back
    await expect(confirmText).toBeHidden()
    await expect(card.getByRole('button', { name: 'Edit', exact: true })).toBeVisible()

    // Row should still be visible
    await expect(card).toBeVisible()

    // Verify via API that job still exists
    const res = await fetch(`${API}/api/cron/${job.id}`)
    expect(res.ok).toBeTruthy()
  } finally {
    await deleteCronJobViaApi(job.id)
  }
})

// ── Run now ──

test('run now from the open row does not crash and the row remains', async ({ page }) => {
  const job = await createCronJobViaApi('Run now test job')

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open the row and click "Run now"
    await openRow(card)
    await card.getByRole('button', { name: 'Run now', exact: true }).click()

    // The button comes back once the run has started (no crash, no error)
    await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled({ timeout: 10_000 })
    await expect(page.getByTestId('routine-action-error')).toHaveCount(0)
    // The row says what the run answered, in place.
    await expect(card.getByTestId('routine-run-outcome')).toBeVisible()

    // Row should still be visible
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

test('edit job from the open row opens form with pre-filled values and saves changes', async ({ page }) => {
  const job = await createCronJobViaApi('Edit test job', {
    description: 'Original description',
  })
  const newName = `Edited job ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  try {
    await page.goto('/cron')
    await page.waitForLoadState('networkidle')

    const card = rowOf(page, job.name)
    await expect(card).toBeVisible({ timeout: 5000 })

    // Open the row and click Edit
    await openRow(card)
    await card.getByRole('button', { name: 'Edit', exact: true }).click()

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
    await expect(page.locator('.cron-job-card', { hasText: job3.name })).toContainText('Every hour')

    // Only one row is open at a time: opening the second closes the first
    const row1 = rowOf(page, job1.name)
    const row2 = rowOf(page, job2.name)
    await openRow(row1)
    await openRow(row2)
    await expect(row1.locator('.routine-row-main')).toHaveAttribute('aria-expanded', 'false')
    await expect(row1.locator('.routine-detail')).toHaveCount(0)
    await expect(page.locator('.routine-row-open')).toHaveCount(1)
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
