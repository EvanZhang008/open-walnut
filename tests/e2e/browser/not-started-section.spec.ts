/**
 * Flat's Not started section (web/src/components/tasks/status-sections.ts drawnSectionOf).
 * 2026-11-09, the user, on Focus's Waiting / snoozed holding tasks whose menu said "Status: Not
 * started": "there shudl be a new category not started, to put the not stared one not mix in to
 * wait and snooze they are completeli differnet , auto collpes also, icon change also".
 *
 * A task nobody started folds under its own heading between Waiting / snoozed and Completed, with
 * the dashed ring on its heading and its row; a parked task and a snoozed one stay in Waiting /
 * snoozed; Not started starts folded and folds again 60 s after the last action, like Waiting.
 * By project keeps those tasks in its list and draws no Not started heading.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSection, statusSectionRows, statusSectionToggle } from './status-section-helpers'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

async function seed(page: Page, project: string, title: string, patch: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  if (Object.keys(patch).length) expect((await page.request.patch(`/api/tasks/${id}`, { data: patch })).ok()).toBe(true)
  return id
}

const tomorrow = () => new Date(Date.now() + 36 * 3600e3).toISOString().slice(0, 10)

test.describe('Flat: Not started is its own section', () => {
  test.describe.configure({ timeout: 150_000 })

  test('a task nobody started folds under Not started with the dashed ring, never under Waiting / snoozed', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Seedbed${stamp}`
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const fresh = await seed(page, project, `never started ${stamp}`, {})
    const parked = await seed(page, project, `parked ${stamp}`, { phase: 'WAITING' })
    const snoozed = await seed(page, project, `snoozed not started ${stamp}`, { start_date: tomorrow() })
    const done = await seed(page, project, `finished ${stamp}`, { phase: 'COMPLETE' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()

    // Its heading: "Not started", folded on a first visit, between Waiting and Completed.
    const heading = statusSection(panel, 'notstarted')
    await expect(heading).toBeVisible({ timeout: 30_000 })
    await expect(heading.locator('.navigation-label')).toHaveText('Not started')
    await expect(statusSectionToggle(panel, 'notstarted')).toHaveAttribute('aria-expanded', 'false')
    await expect(panel.getByTestId('status-section-notstarted-rows')).toHaveCount(0)
    const order = await panel.evaluate((root) => [...root.querySelectorAll('[data-testid^="status-section-"][class*="status-section-heading"]')]
      .map((el) => el.getAttribute('data-testid')))
    expect(order.indexOf('status-section-waiting')).toBeLessThan(order.indexOf('status-section-notstarted'))
    expect(order.indexOf('status-section-notstarted')).toBeLessThan(order.indexOf('status-section-done'))
    // Its mark is the dashed ring, not Waiting's hourglass.
    const mark = (key: 'waiting' | 'notstarted') => statusSection(panel, key).locator('.status-section-heading-icon').innerHTML()
    expect(await mark('notstarted')).toContain('stroke-dasharray')
    expect(await mark('notstarted')).not.toBe(await mark('waiting'))

    // Opened: the task nobody started is there, wearing the dashed ring; the others are not.
    await setStatusSectionOpen(panel, 'notstarted', true)
    const row = await showSectionCard(panel, 'notstarted', fresh)
    await expect(row.locator('.pinned-phase-picker')).toHaveAttribute('data-row-mark', 'not-started')
    expect(await row.locator('.pinned-phase-picker').innerHTML()).toContain('stroke-dasharray')
    for (const id of [parked, snoozed, done]) await expect(statusSectionRows(panel, 'notstarted').locator(`[data-task-id="${id}"]`)).toHaveCount(0)

    // Waiting / snoozed keeps the parked task and the snoozed one, not the one nobody started.
    await setStatusSectionOpen(panel, 'waiting', true)
    await showSectionCard(panel, 'waiting', parked)
    await showSectionCard(panel, 'waiting', snoozed)
    await expect(statusSectionRows(panel, 'waiting').locator(`[data-task-id="${fresh}"]`)).toHaveCount(0)
    await expect(panel.locator(`[data-task-id="${fresh}"]`)).toHaveCount(1)

    // It folds 60 s after the last action, like Waiting.
    await page.mouse.move(5, (page.viewportSize()?.height ?? 800) - 5)
    await page.clock.fastForward(55_000)
    await expect(statusSectionToggle(panel, 'notstarted')).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(7_000)
    await expect(statusSectionToggle(panel, 'notstarted')).toHaveAttribute('aria-expanded', 'false')
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'false')
  })

  test('By project keeps the task nobody started in its list, with no Not started heading', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'project')
    const stamp = Date.now()
    const fresh = await seed(page, `Seedbed${stamp}`, `never started ${stamp}`, {})
    await page.goto('/')
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await expect(panel.locator(`[data-task-id="${fresh}"]`).first()).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByTestId('status-section-notstarted')).toHaveCount(0)
  })
})
