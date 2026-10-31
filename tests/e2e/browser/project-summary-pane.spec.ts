/**
 * Project detail pane — AI project summary ("About" section).
 *
 * The summary is generated server-side by project-summary.ts (fast model) and
 * stored in the project registry's metadata (task_projects.metadata — the
 * .metadata_project sentinel task is retired). The pane must:
 *   1. show the stored summary when present,
 *   2. show the empty-state hint (with the ↻ affordance) when absent.
 *
 * The fixture server disables background AI (WALNUT_DISABLE_BACKGROUND_AI), so
 * the "stored summary" case is seeded through the real metadata PATCH API —
 * exactly the storage path refreshProjectSummary writes through.
 */
import { test, expect } from '@playwright/test'
import { openProjectDetails, showEverything } from './todo-panel-helpers'

const API = 'http://localhost:3457'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await showEverything(page)
})

test('project pane shows the stored AI summary', async ({ page, request }) => {
  // Seed: a real task auto-creates the project registry row; metadata carries the summary.
  // Unpinned: a new task is born in Focus, outside the project groups.
  const res = await request.post(`${API}/api/tasks`, {
    data: { title: 'Summary pane seed task', project: 'SummaryProj', pinned: false },
  })
  expect(res.ok()).toBeTruthy()
  const put = await request.put(
    `${API}/api/projects/SummaryProj/metadata`,
    { data: { summary: 'Building the summary pane demo.', summary_task_count: 1 } },
  )
  expect(put.ok()).toBeTruthy()

  await page.reload()
  await showEverything(page)

  const pane = await openProjectDetails(page, 'SummaryProj')
  await expect(pane).toContainText('About')
  await expect(pane).toContainText('Building the summary pane demo.')
})

test('project pane shows the empty-state hint and refresh button when no summary exists', async ({ page, request }) => {
  const res = await request.post(`${API}/api/tasks`, {
    data: { title: 'No summary seed task', project: 'BareProj', pinned: false },
  })
  expect(res.ok()).toBeTruthy()

  await page.reload()
  await showEverything(page)

  const pane = await openProjectDetails(page, 'BareProj')
  await expect(pane).toContainText('No summary yet')
  await expect(pane.locator('.detail-summary-refresh')).toBeVisible()
})
