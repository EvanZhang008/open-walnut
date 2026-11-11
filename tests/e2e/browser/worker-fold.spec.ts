/**
 * Workers fold into their leader on Home's Flat sections (worker-fold.ts, WorkerFoldTree.tsx;
 * 2026-11-11, the user picked design 2, "inline tree", of ten). A worker of a real leader is no
 * row of its own: the leader's row says "N workers" with the team's mix and opens a tree below
 * it. "Show separately" makes one worker a row again, "Fold back" puts it back, "Show all N
 * separately" does the whole team, and Display's "Fold workers into leaders" turns it off; each
 * choice outlives a reload. A worker whose leader is not in the view (Focus) still folds: the
 * leader is drawn as a quiet row in its place.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { closeDisplayMenu, displayMenu, openDisplayMenu } from './filter-bar-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSectionCard } from './status-section-helpers'
import { openHome } from './home-navigation-helpers'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0).reverse()) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

async function seed(page: Page, data: Record<string, unknown>): Promise<string> {
  const { phase, ...create } = data
  const res = await page.request.post('/api/tasks', { data: { source: 'local', ...create } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  // The phase is a move of its own (a create starts at TODO).
  if (phase) {
    const p = await page.request.patch(`/api/tasks/${id}`, { data: { phase } })
    expect(p.ok(), await p.text()).toBe(true)
  }
  return id
}

async function team(page: Page, extra: Record<string, unknown> = {}) {
  const project = `Fold ${Date.now().toString(36)}`
  const leader = await seed(page, { title: 'Ship the fold leader', project, phase: 'WAITING', ...extra.leader as object })
  const w1 = await seed(page, { title: 'Fold worker one', project, parent_task_id: leader, phase: 'WAITING', ...extra.worker as object })
  const w2 = await seed(page, { title: 'Fold worker two', project, parent_task_id: leader, phase: 'WAITING', ...extra.worker as object })
  return { project, leader, w1, w2 }
}

test.describe('worker fold', () => {
  test.describe.configure({ timeout: 150_000 })

  test('a leader carries its workers; separate, fold back, show all and the Display switch, kept across reloads', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await openHome(page, baseURL!)
    const { leader, w1, w2 } = await team(page)
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)

    // Folded: the leader's row carries the team, the workers are no rows.
    const lead = await showSectionCard(panel, 'waiting', leader)
    await expect(lead.getByTestId('worker-fold-toggle')).toHaveText('2 workers')
    await expect(lead.getByTestId('worker-fold-mix')).toHaveText('2 waiting')
    await expect(lead.getByTestId('leader-pill')).toHaveCount(0)
    await expect(statusSectionCard(panel, 'waiting', w1)).toHaveCount(0)
    await expect(statusSectionCard(panel, 'waiting', w2)).toHaveCount(0)

    // Open the tree: both workers, each with its state.
    await lead.getByTestId('worker-fold-toggle').click()
    const tree = panel.locator(`[data-testid="worker-fold-tree"][data-host-id="${leader}"]`)
    await expect(tree.getByTestId('worker-fold-item')).toHaveCount(2)
    const item1 = tree.locator(`[data-fold-task-id="${w1}"]`)
    await expect(item1).toContainText('Fold worker one')
    await expect(item1).toContainText('Waiting')

    // Show one separately: it is a row again, and the tree says so.
    await item1.hover()
    await item1.getByTestId('worker-fold-separate').click()
    const row1 = statusSectionCard(panel, 'waiting', w1)
    await expect(row1).toBeVisible()
    await expect(item1).toContainText('Shown separately')
    await expect(lead.getByTestId('worker-fold-mix')).toHaveText('2 waiting · 1 in the list')
    await page.reload()
    await selectSection(page, 'All')
    await setStatusSectionOpen(panel, 'waiting', true)
    await expect(statusSectionCard(panel, 'waiting', w1)).toBeVisible({ timeout: 30_000 })
    await expect(statusSectionCard(panel, 'waiting', w2)).toHaveCount(0)
    // The tree stayed open across the reload.
    await expect(tree.getByTestId('worker-fold-item')).toHaveCount(2)

    // Fold back from the row itself.
    await statusSectionCard(panel, 'waiting', w1).hover()
    await statusSectionCard(panel, 'waiting', w1).getByTestId('worker-fold-row-back').click()
    await expect(statusSectionCard(panel, 'waiting', w1)).toHaveCount(0)

    // The whole team, then all back.
    await tree.getByTestId('worker-fold-show-all').click()
    await expect(statusSectionCard(panel, 'waiting', w1)).toBeVisible()
    await expect(statusSectionCard(panel, 'waiting', w2)).toBeVisible()
    await expect(lead.getByTestId('worker-fold-mix')).toHaveText('2 waiting · all in the list')
    await tree.getByTestId('worker-fold-all-back').click()
    await expect(statusSectionCard(panel, 'waiting', w1)).toHaveCount(0)
    await expect(statusSectionCard(panel, 'waiting', w2)).toHaveCount(0)

    // A tree line opens its task.
    await tree.locator(`[data-fold-task-id="${w2}"] .worker-fold-open`).click()
    await expect(tree.locator(`[data-fold-task-id="${w2}"]`)).toHaveClass(/is-focused/)

    // Display: off lists every worker as before, and stays off after a reload.
    await openDisplayMenu(page)
    const sw = displayMenu(page).locator('[data-view-option="worker-fold"]')
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await closeDisplayMenu(page)
    await expect(statusSectionCard(panel, 'waiting', w1)).toBeVisible()
    await expect(statusSectionCard(panel, 'waiting', leader).getByTestId('worker-fold-line')).toHaveCount(0)
    await page.reload()
    await selectSection(page, 'All')
    await setStatusSectionOpen(panel, 'waiting', true)
    await expect(statusSectionCard(panel, 'waiting', w2)).toBeVisible({ timeout: 30_000 })
    await openDisplayMenu(page)
    await displayMenu(page).locator('[data-view-option="worker-fold"]').click()
    await closeDisplayMenu(page)
    await expect(statusSectionCard(panel, 'waiting', w2)).toHaveCount(0)
  })

  test('Show all shows every level of a nested team, and Fold all back folds every level', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await openHome(page, baseURL!)
    const { project, leader, w1 } = await team(page)
    const grand = await seed(page, { title: 'Fold grand worker', project, parent_task_id: w1, phase: 'WAITING' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    const lead = await showSectionCard(panel, 'waiting', leader)
    await expect(lead.getByTestId('worker-fold-toggle')).toHaveText('3 workers')
    await lead.getByTestId('worker-fold-toggle').click()
    const tree = panel.locator(`[data-testid="worker-fold-tree"][data-host-id="${leader}"]`)
    // The grand worker sits one level in, under its own leader.
    await expect(tree.locator(`[data-fold-task-id="${grand}"]`)).toBeVisible()
    await tree.getByTestId('worker-fold-show-all').click()
    await expect(statusSectionCard(panel, 'waiting', w1)).toBeVisible()
    await expect(statusSectionCard(panel, 'waiting', grand)).toBeVisible()
    await tree.getByTestId('worker-fold-all-back').click()
    await expect(statusSectionCard(panel, 'waiting', w1)).toHaveCount(0)
    await expect(statusSectionCard(panel, 'waiting', grand)).toHaveCount(0)
  })

  test('Show separately opens the folded section the worker is drawn in', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await openHome(page, baseURL!)
    // The leader needs the user (Needs you never folds, so it stays there); its workers wait.
    const { leader, w1 } = await team(page, { leader: { phase: 'NEED_ACTION' } })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', false)
    const lead = await showSectionCard(panel, 'needs', leader)
    await lead.getByTestId('worker-fold-toggle').click()
    const item = panel.locator(`[data-testid="worker-fold-tree"][data-host-id="${leader}"] [data-fold-task-id="${w1}"]`)
    await item.hover()
    await item.getByTestId('worker-fold-separate').click()
    // On screen with no click of the user's: the section it is drawn in opened (Waiting, or Not
    // started while its status is not derived yet).
    await expect(panel.locator(`.status-section-card[data-task-id="${w1}"]`)).toBeVisible()
  })

  test('a worker whose leader is not in the view folds into a quiet leader row', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await openHome(page, baseURL!)
    const { leader, w1, w2 } = await team(page, { worker: { pinned: true, focus_tier: 'focus' } })
    await page.reload()
    await selectSection(page, 'Focus')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    const lead = await showSectionCard(panel, 'waiting', leader)
    await expect(lead).toHaveAttribute('data-fold-quiet', '1')
    await expect(lead.getByTestId('worker-fold-toggle')).toHaveText('2 workers')
    await expect(statusSectionCard(panel, 'waiting', w1)).toHaveCount(0)
    await expect(statusSectionCard(panel, 'waiting', w2)).toHaveCount(0)
    // Shown separately, the worker is a Focus row and the leader stays for the other one.
    await lead.getByTestId('worker-fold-toggle').click()
    const item = panel.locator(`[data-testid="worker-fold-tree"][data-host-id="${leader}"] [data-fold-task-id="${w1}"]`)
    await item.hover()
    await item.getByTestId('worker-fold-separate').click()
    await expect(statusSectionCard(panel, 'waiting', w1)).toBeVisible()
    await expect(lead).toHaveAttribute('data-fold-quiet', '1')
  })
})
