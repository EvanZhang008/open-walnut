/**
 * Project detail pane — AI project summary ("About" section).
 *
 * The summary is generated server-side by project-summary.ts (fast model) and
 * stored in .metadata_project. The pane must:
 *   1. show the stored summary when present,
 *   2. show the empty-state hint (with the ↻ affordance) when absent.
 *
 * The fixture server disables background AI (WALNUT_DISABLE_BACKGROUND_AI), so
 * the "stored summary" case is seeded through the real metadata PATCH API —
 * exactly the storage path refreshProjectSummary writes through.
 */
import { test, expect } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = 'http://localhost:3457'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await showEverything(page)
})

test('project pane shows the stored AI summary', async ({ page, request }) => {
  // Seed: a real task creates the category/project; metadata carries the summary.
  const res = await request.post(`${API}/api/tasks`, {
    data: { title: 'Summary pane seed task', category: 'Work', project: 'SummaryProj' },
  })
  expect(res.ok()).toBeTruthy()
  const patch = await request.patch(
    `${API}/api/categories/Work/projects/SummaryProj/metadata`,
    { data: { summary: 'Building the summary pane demo.', summary_task_count: 1 } },
  )
  expect(patch.ok()).toBeTruthy()

  await page.reload()
  await showEverything(page)

  // Open the project detail pane via the project header button.
  const projBtn = page.locator('.todo-group-name-btn', { hasText: 'SummaryProj' }).first()
  await projBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await projBtn.click()

  const pane = page.locator('.project-detail-pane')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  await expect(pane).toContainText('About')
  await expect(pane).toContainText('Building the summary pane demo.')
})

test('project pane shows the empty-state hint and refresh button when no summary exists', async ({ page, request }) => {
  const res = await request.post(`${API}/api/tasks`, {
    data: { title: 'No summary seed task', category: 'Work', project: 'BareProj' },
  })
  expect(res.ok()).toBeTruthy()

  await page.reload()
  await showEverything(page)

  const projBtn = page.locator('.todo-group-name-btn', { hasText: 'BareProj' }).first()
  await projBtn.waitFor({ state: 'visible', timeout: 15_000 })
  await projBtn.click()

  const pane = page.locator('.project-detail-pane')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  await expect(pane).toContainText('No summary yet')
  await expect(pane.locator('.detail-summary-refresh')).toBeVisible()
})
