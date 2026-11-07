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
import { endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn, statusSectionRows } from './status-section-helpers'
import { openHome } from './home-navigation-helpers'

// The fixture server is shared: every task made here goes again (other specs measure the panel).
const made: string[] = []
const turns: string[] = []
test.afterEach(async ({ request }) => {
  for (const sid of turns.splice(0)) await endRunningTurn(request, sid)
  for (const id of made.splice(0)) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
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

  // 2026-11-06, the user: "when people first use this please only default to the project,
  // the flat (show experimental, not default)". A fresh profile (nothing stored, no synced
  // prefs) opens By project; a Flat the user picked stays Flat across a reload.
  test('a first visit opens By project, Flat is marked experimental, and a picked Flat is kept', async ({ page, baseURL }) => {
    await isolateUiPrefs(page, { newInstall: true })
    await openHome(page, baseURL!)
    await seed(page, `First visit ${Date.now()}`, 'Wait for the first visit approval', { phase: 'WAITING' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await expect(panel.locator('[data-task-id]').first()).toBeAttached({ timeout: 30_000 })
    // By project draws no Waiting / snoozed section of its own (each project folds its own).
    await expect(panel.getByTestId('status-section-waiting')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('walnut-todo-panel-design'))).toBeNull()
    await openDisplayMenu(page)
    const group = displayMenu(page).locator('[data-view-option="group"]')
    await expect(group.locator('[data-choice]')).toHaveText(['By project', 'Flat', 'In one list'])
    await expect(group.locator('[data-choice="project"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(displayMenu(page).locator('[data-view-option="experimental-note"]')).toHaveText('Group: Flat and In one list are experimental')
    await group.locator('[data-choice="status"]').click()
    await closeDisplayMenu(page)
    await expect(panel.getByTestId('status-section-waiting').first()).toBeAttached()
    await page.reload()
    await selectSection(page, 'All')
    await expect(panel.getByTestId('status-section-waiting').first()).toBeAttached({ timeout: 30_000 })
    await openDisplayMenu(page)
    await expect(displayMenu(page).locator('[data-view-option="group"] [data-choice="status"]')).toHaveAttribute('aria-pressed', 'true')
    await closeDisplayMenu(page)
  })

  test('status sentences are hidden by default; Display toggles every row and keeps the choice after reload', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await openHome(page, baseURL!)
    const project = `Status lines ${Date.now()}`
    const needs = await seed(page, project, 'Choose the rollout date', { phase: 'NEED_ACTION' })
    const waiting = await seed(page, project, 'Prepare the rollout', {})
    await seed(page, project, 'Wait for rollout approval', { phase: 'WAITING' })
    const report = await page.request.put(`/api/v1/tasks/${needs}/report`, { data: { state: 'needs', ask: 'Which date should the rollout use?' } })
    expect(report.ok(), await report.text()).toBe(true)
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'needs', true)
    await setStatusSectionOpen(panel, 'waiting', true)
    const needsRow = await showSectionCard(panel, 'needs', needs)
    const waitingRow = await showSectionCard(panel, 'waiting', waiting)
    await expect(needsRow.getByTestId('status-card-needs-line')).toHaveCount(0)
    await expect(waitingRow.getByTestId('status-card-reason')).toHaveCount(0)
    await openDisplayMenu(page)
    await displayMenu(page).locator('[data-view-option="group"] [data-choice="project"]').click()
    await closeDisplayMenu(page)
    const projectFold = panel.locator(`[data-testid="project-status-folds"][data-project="${project}"]`).first()
    await projectFold.getByTestId('project-status-fold-waiting').click()
    await expect(projectFold.locator('.status-card-reason')).toHaveCount(0)
    await openDisplayMenu(page)
    await displayMenu(page).locator('[data-view-option="group"] [data-choice="status"]').click()
    await closeDisplayMenu(page)
    await expect(needsRow.locator('.task-unread-dot')).toBeVisible()
    await expect(needsRow.locator('.todo-pinned-title')).toHaveText('Choose the rollout date')
    for (let i = 0; i < 2; i++) {
      await openDisplayMenu(page)
      const toggle = displayMenu(page).getByRole('switch', { name: 'Show task status line', exact: true })
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expect(needsRow.getByTestId('status-card-needs-line')).toContainText('Which date should the rollout use?')
      await expect(waitingRow.getByTestId('status-card-reason')).toHaveText('Not started yet')
      await closeDisplayMenu(page)
      await page.reload()
      await expect(needsRow.getByTestId('status-card-needs-line')).toBeVisible()
      await openDisplayMenu(page)
      await displayMenu(page).getByRole('switch', { name: 'Show task status line', exact: true }).click()
      await closeDisplayMenu(page)
      await expect(needsRow.getByTestId('status-card-needs-line')).toHaveCount(0)
      await expect(waitingRow.getByTestId('status-card-reason')).toHaveCount(0)
      await page.reload()
      await expect(needsRow.getByTestId('status-card-needs-line')).toHaveCount(0)
    }
  })

  test('sections only, two-line rows, a snoozed task under Waiting, Group switches to By project and back', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.addInitScript(() => localStorage.setItem('open-walnut-view:tasks.statusLines', 'true'))
    // A user who never picked a tier sees no tier headings while one tier holds cards (5.10).
    await page.addInitScript(() => localStorage.setItem('walnut-todo-tier-used', '1'))
    const stamp = Date.now()
    const project = `Flatland${stamp}`
    await openHome(page, baseURL!)
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const needs = await seed(page, project, `flat needs ${stamp}`, { phase: 'NEED_ACTION' })
    const working = await seed(page, project, `flat working ${stamp}`, { phase: 'IN_PROGRESS' })
    // Working is a turn that runs now; a task only marked In progress waits.
    turns.push(await startRunningTurn(page.request, working))
    // Pinned in Focus, so By project draws a Focus heading.
    expect((await page.request.post(`/api/focus/tasks/${working}`)).ok()).toBe(true)
    expect((await page.request.put(`/api/focus/tasks/${working}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
    const parked = await seed(page, project, `flat parked ${stamp}`, { phase: 'WAITING' })
    const snoozed = await seed(page, project, `flat snoozed ${stamp}`, { phase: 'NEED_ACTION', start_date: '2099-01-01' })
    // A to-do nobody started waits like the rest of its user status (2026-10-31: it read Working).
    const todo = await seed(page, project, `flat todo ${stamp}`, {})
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()

    // Needs you has its heading like every section; its row is two lines, the project on the small one.
    const needsRow = panel.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${needs}"]`)
    await expect(needsRow).toBeVisible({ timeout: 20_000 })
    await expect(needsRow.locator('.status-card-meta .status-card-project')).toHaveText(project)
    await expect(needsRow.locator('.status-card-body > .todo-pinned-title')).toHaveText(`flat needs ${stamp}`)
    await expect(panel.getByTestId('status-section-needs')).toHaveCount(1)
    await expect(panel.getByTestId('status-section-needs')).toContainText('Needs you')
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
    // Each Waiting row says why: not started, snoozed.
    const todoRow = await showSectionCard(panel, 'waiting', todo)
    await expect(todoRow.getByTestId('status-card-reason')).toHaveText('Not started yet')
    await expect((await showSectionCard(panel, 'waiting', snoozed)).getByTestId('status-card-reason')).toHaveText('Snoozed')
    // What it waits on is a third line under the title (2026-11-02, the user: on the top line
    // the sentence was cut); "Snoozed" is a label and stays on the top line, with no third line.
    await expect(todoRow.locator('.status-card-body > .status-card-wait-line')).toHaveText('Not started yet')
    await expect(todoRow.locator('.status-card-meta [data-testid="status-card-reason"]')).toHaveCount(0)
    const titleBox = (await todoRow.locator('.status-card-body > .todo-pinned-title').boundingBox())!
    const waitBox = (await todoRow.locator('.status-card-wait-line').boundingBox())!
    expect(waitBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height - 1)
    const snoozedRow = await showSectionCard(panel, 'waiting', snoozed)
    await expect(snoozedRow.locator('.status-card-meta [data-testid="status-card-reason"]')).toHaveText('Snoozed')
    await expect(snoozedRow.locator('.status-card-wait-line')).toHaveCount(0)
    await expect(statusSectionRows(panel, 'working').locator(`[data-task-id="${todo}"]`)).toHaveCount(0)

    // Display: Group is the layout, and Sort has nothing to act on in Flat.
    await openDisplayMenu(page)
    const menu = displayMenu(page)
    const group = menu.locator('[data-view-option="group"]')
    await expect(group.locator('[data-choice]')).toHaveText(['By project', 'Flat', 'In one list'])
    await expect(group.locator('[data-choice="status"]')).toHaveAttribute('aria-pressed', 'true')
    await expect(menu.locator('[data-view-option="experimental-note"]')).toHaveText('Group: Flat and In one list are experimental')
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
    // By project is the to-do list: the to-do stays in it, in one place only.
    await expect(panel.locator(`[data-task-id="${todo}"]`)).toHaveCount(1)
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
