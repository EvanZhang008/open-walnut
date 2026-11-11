/**
 * Background: the home task list's group for long-running work (2026-11-11, the user: a CR review
 * or a cron job he puts there himself, "无论 task 是什么 status，它不会出来"). Real clicks in both
 * panel layouts: the row menu's "Move to Background" takes a task that needs the user out of Needs
 * you into Background (its heading carries the dot), in every tier tab; a reload keeps it; "Take
 * out of Background" puts it back where its status says.
 */
import { test, expect, type Page } from './shortcut-test-fixture'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, statusSection, statusSectionCard, type PanelDesign } from './status-section-helpers'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`)
})

async function menuRow(page: Page, card: ReturnType<typeof statusSectionCard>, testId: string) {
  await card.hover()
  await card.locator('.task-kebab-btn').first().click()
  const row = page.getByTestId(testId).first()
  await expect(row).toBeVisible()
  return row
}

for (const design of ['status', 'project'] as PanelDesign[]) {
  test(`${design}: Move to Background holds a task that needs the user, in every tier, and takes it back out`, async ({ page }) => {
    test.setTimeout(120_000)
    await isolateUiPrefs(page)
    await presetPanelDesign(page, design)
    await page.setViewportSize({ width: 1280, height: 800 })
    const res = await page.request.post('/api/tasks', { data: { title: `CR review ${design} ${Date.now()}`, source: 'local' } })
    expect(res.ok()).toBe(true)
    const id = (await res.json()).task.id as string
    made.push(id)
    expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
    expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
    expect((await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)

    await page.goto('/')
    await selectSection(page, 'Focus')
    // Flat draws Needs you as a section; By project keeps those rows in its list.
    const before = design === 'status' ? statusSectionCard(page, 'needs', id) : page.locator(`.todo-panel [data-task-id="${id}"]`).first()
    await expect(before).toBeVisible({ timeout: 30_000 })
    const move = await menuRow(page, before, 'task-kebab-background')
    await expect(move).toHaveText('Move to Background')
    await move.click()

    await expect(statusSection(page, 'background')).toBeVisible()
    await expect(page.getByTestId('status-section-background-asks')).toBeVisible()
    await expect(page.locator(`.todo-panel [data-task-id="${id}"]`)).toHaveCount(0)
    await setStatusSectionOpen(page, 'background', true)
    const card = statusSectionCard(page, 'background', id)
    await expect(card).toBeVisible()
    expect((await (await page.request.get(`/api/tasks/${id}`)).json()).task.background_at).toBeTruthy()

    await selectSection(page, 'All')
    await setStatusSectionOpen(page, 'background', true)
    await expect(statusSectionCard(page, 'background', id)).toBeVisible()
    if (design === 'status') await expect(statusSectionCard(page, 'needs', id)).toHaveCount(0)

    await page.reload()
    await selectSection(page, 'Focus')
    await setStatusSectionOpen(page, 'background', true)
    const after = statusSectionCard(page, 'background', id)
    await expect(after).toBeVisible({ timeout: 30_000 })
    const out = await menuRow(page, after, 'task-kebab-background')
    await expect(out).toHaveText('Take out of Background')
    await out.click()
    await expect(page.locator(`[data-testid="status-section-background-rows"] [data-task-id="${id}"]`)).toHaveCount(0)
    await expect(page.locator(`.todo-panel [data-task-id="${id}"]`).first()).toBeVisible()
    expect((await (await page.request.get(`/api/tasks/${id}`)).json()).task.background_at).toBeFalsy()
  })
}
