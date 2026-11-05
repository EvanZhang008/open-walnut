/**
 * By project draws completed tasks once, in one Completed row at the bottom of the view,
 * never inside a project (2026-11-05, the user: "the completed don't show in general, show
 * a drop down below to open all completed ... not each project"; before, the Focus tab
 * listed project groups holding nothing but "2 Completed"). The model is pinned in
 * tests/web/by-project-completed.test.ts; this walks the real panel on every tab kind.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

async function seed(page: Page, project: string, title: string, phase: string): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
  expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
  const p = await page.request.patch(`/api/tasks/${id}`, { data: { phase } })
  expect(p.ok(), await p.text()).toBe(true)
  return id
}

/** No project draws a Completed fold, and a project with only completed tasks draws nothing. */
async function expectNoCompletedInProjects(panel: Locator, onlyDone: string): Promise<void> {
  await expect(panel.getByTestId('project-status-fold-done')).toHaveCount(0)
  await expect(panel.locator(`[data-testid="project-status-folds"][data-project="${onlyDone}"]`)).toHaveCount(0)
  await expect(panel.locator('.tier-project-label-name', { hasText: onlyDone })).toHaveCount(0)
  // ONE Completed row for the whole view.
  await expect(panel.getByTestId('status-section-done')).toHaveCount(1)
}

test.describe('By project: one Completed row', () => {
  test.describe.configure({ timeout: 180_000 })

  test('completed tasks leave their projects for one row at the bottom, on every tab', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'project')
    await presetPanelView(page, { section: 'focus' })
    const stamp = Date.now()
    const onlyDone = `OnlyDone${stamp}`
    const mixed = `Mixed${stamp}`
    const doneA = await seed(page, onlyDone, `only done ${stamp}`, 'COMPLETE')
    const open = await seed(page, mixed, `mixed open ${stamp}`, 'NEED_ACTION')
    const doneB = await seed(page, mixed, `mixed done ${stamp}`, 'COMPLETE')

    await page.goto('/')
    const panel = page.locator('.todo-panel')
    const openRow = panel.locator(`[data-task-id="${open}"]:not(.status-section-card)`).first()
    await expect(openRow).toBeVisible({ timeout: 30_000 })

    for (const tab of ['Focus', 'All', 'Tasks'] as const) {
      await selectSection(page, tab)
      await expect(openRow).toBeVisible({ timeout: 30_000 })
      await expectNoCompletedInProjects(panel, onlyDone)
      // The row sits below the list, and opens every completed task of the view, each naming its project.
      const heading = panel.getByTestId('status-section-done')
      // After the list (outside its scroller when the list is long, so compare document order).
      const after = await openRow.evaluate((row, h) => !!(row.compareDocumentPosition(h as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await heading.elementHandle())
      expect(after, `${tab}: Completed below the list`).toBe(true)
      await setStatusSectionOpen(panel, 'done', true)
      for (const [id, project] of [[doneA, onlyDone], [doneB, mixed]] as const) {
        const card = await showSectionCard(panel, 'done', id)
        await expect(card.locator('.status-card-project')).toHaveText(project)
      }
      // The completed tasks are drawn only there: never as a row of their project.
      for (const id of [doneA, doneB]) await expect(panel.locator(`[data-task-id="${id}"]`)).toHaveCount(1)
      await setStatusSectionOpen(panel, 'done', false)
    }
  })
})
