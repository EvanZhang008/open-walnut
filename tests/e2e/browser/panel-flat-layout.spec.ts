/**
 * The home task panel's Flat layout (panel-design.ts, the product default; 2026-10-30
 * the user picked it from ten designs): the panel is its status sections, each row two
 * lines (the project and its tags on a small line, then the title), with no list of
 * tiers or projects under them. Display's Group row picks Flat or By project, the list
 * as it was. A snoozed task waits under Waiting / snoozed even when it needs the user
 * (2026-10-30: "I already snoozed it, why doesn't it leave?").
 */
import { test, expect } from './shortcut-test-fixture'
import type { Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { closeDisplayMenu, displayMenu, openDisplayMenu } from './filter-bar-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSectionRows } from './status-section-helpers'

// The fixture server is shared: every task made here goes again (other specs measure the panel).
const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}`).catch(() => {})
  }
})

async function seed(page: Page, project: string, title: string, patch: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  if (Object.keys(patch).length) {
    const p = await page.request.patch(`/api/tasks/${id}`, { data: patch })
    expect(p.ok(), await p.text()).toBe(true)
  }
  return id
}

test.describe('Flat layout', () => {
  test.describe.configure({ timeout: 120_000 })

  test('sections only, two-line rows, a snoozed task under Waiting, Group switches to By project and back', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    // A user who never picked a tier sees no tier headings while one tier holds cards (5.10).
    await page.addInitScript(() => localStorage.setItem('walnut-todo-tier-used', '1'))
    const stamp = Date.now()
    const project = `Flatland${stamp}`
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const needs = await seed(page, project, `flat needs ${stamp}`, { phase: 'NEED_ACTION' })
    const working = await seed(page, project, `flat working ${stamp}`, { phase: 'IN_PROGRESS' })
    // Pinned in Focus, so By project draws a Focus heading.
    expect((await page.request.post(`/api/focus/tasks/${working}`)).ok()).toBe(true)
    expect((await page.request.put(`/api/focus/tasks/${working}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
    const parked = await seed(page, project, `flat parked ${stamp}`, { phase: 'WAITING' })
    const snoozed = await seed(page, project, `flat snoozed ${stamp}`, { phase: 'NEED_ACTION', start_date: '2099-01-01' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()

    // Needs you leads with no heading; its row is two lines, the project on the small one.
    const needsRow = panel.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${needs}"]`)
    await expect(needsRow).toBeVisible({ timeout: 20_000 })
    await expect(needsRow.locator('.status-card-meta .status-card-project')).toHaveText(project)
    await expect(needsRow.locator('.status-card-body > .todo-pinned-title')).toHaveText(`flat needs ${stamp}`)
    await expect(panel.getByTestId('status-section-needs')).toHaveCount(0)
    // The snoozed one is not among them (its user status is the status owner's: src/core).
    await expect(panel.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${snoozed}"]`)).toHaveCount(0)

    // No list of tiers or projects: Working is a section like the rest.
    await expect(panel.locator('.todo-panel-list')).toHaveCount(0)
    await expect(panel.locator('[data-testid="project-status-counts"]')).toHaveCount(0)
    await setStatusSectionOpen(panel, 'working', true)
    await expect(await showSectionCard(panel, 'working', working)).toBeVisible()
    await setStatusSectionOpen(panel, 'waiting', true)
    await expect(await showSectionCard(panel, 'waiting', parked)).toBeVisible()
    await expect(await showSectionCard(panel, 'waiting', snoozed)).toBeVisible()
    await expect(statusSectionRows(panel, 'waiting').locator(`[data-task-id="${needs}"]`)).toHaveCount(0)

    // Display: Group is the layout, and Sort has nothing to act on in Flat.
    await openDisplayMenu(page)
    const menu = displayMenu(page)
    const group = menu.locator('[data-view-option="group"]')
    await expect(group.locator('[data-choice]')).toHaveText(['Flat', 'By project', 'In one list'])
    await expect(group.locator('[data-choice="status"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(menu.locator('[data-view-option="sort"]')).toHaveCount(0)
    await group.locator('[data-choice="project"]').click()
    await expect(menu.locator('[data-view-option="sort"]')).toBeVisible()
    await closeDisplayMenu(page)

    // By project: the list as it was (the new tasks sit in their tier), the waiting and
    // snoozed rows folded at the end of their project's run, no status counts anywhere.
    await expect(panel.locator(`[data-task-id="${needs}"]:not(.status-section-card)`).first()).toBeVisible({ timeout: 20_000 })
    // No Flat section rows (Watching, which By project keeps on top, may hold other specs' rows).
    for (const key of ['needs', 'working', 'waiting', 'done']) await expect(panel.getByTestId(`status-section-${key}-rows`)).toHaveCount(0)
    // Its rows are one line: the project heading names the project already.
    await expect(panel.locator('.status-card-two-line')).toHaveCount(0)
    await expect(panel.locator(`[data-testid="project-status-folds"][data-project="${project}"]`).first()).toBeVisible()
    await expect(panel.locator('[data-testid="project-status-counts"]')).toHaveCount(0)
    await expect(panel.locator(`[data-task-id="${snoozed}"]`)).toHaveCount(0)
    // Its tier headings are the sections' divider row, "Focus (N) ---- >", with no glyph,
    // and stay 26 px tall (the sticky offsets in home-navigation.css count on it).
    const tierHeading = panel.locator('.todo-pinned-subgroup-heading [data-navigation-id="focus"]')
    await expect(tierHeading).toHaveClass(/navigation-heading-divider/)
    await expect(tierHeading.locator('.navigation-heading-count')).toHaveText(/^\d+$/)
    await expect(tierHeading.locator('.navigation-heading-rule')).toHaveCount(1)
    await expect(tierHeading.locator('.navigation-icon')).toHaveCount(0)
    expect(Math.round((await tierHeading.boundingBox())!.height)).toBe(26)

    // And back.
    await openDisplayMenu(page)
    await displayMenu(page).locator('[data-view-option="group"] [data-choice="status"]').click()
    await closeDisplayMenu(page)
    await expect(panel.locator('.todo-panel-list')).toHaveCount(0)
    await expect(needsRow).toBeVisible()
  })
})
