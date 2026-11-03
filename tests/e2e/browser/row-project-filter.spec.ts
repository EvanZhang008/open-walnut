/**
 * A click on the project name above a task row filters the panel to that project and shows all
 * of it (2026-11-03, the user: "if user click the project I thik it shoud do a filter on the
 * project show all in this project", then "and kind of expand all secitino"). The panel's own
 * Project chip takes the project, the view goes to All with every status section open, and
 * removing the chip puts the tab and the folds back as they were (web/src/components/tasks/project-jump.ts).
 */
import { test, expect } from '@playwright/test'
import { boot, cleanup, runStamp, seed, selectTab, tab, panelClip } from './filter-bar-board-helpers'
import { filterChip, removeFilterChip } from './filter-bar-helpers'
import { LS_STATUS_SECTIONS_KEY, presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSectionCard, statusSectionToggle } from './status-section-helpers'

test.setTimeout(150_000)

const SHOTS = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots` : '/tmp/row-project-filter'

test('the project name on a row filters to that project, opens every section, and clearing puts the view back', async ({ page, baseURL }) => {
  const stamp = runStamp()
  const garden = `Garden ${stamp}`
  const kitchen = `Kitchen ${stamp}`
  const ids = [
    ...await seed(page, garden, [
      { title: `garden focus ${stamp}`, pin: 'focus', phase: 'NEED_ACTION' },
      { title: `garden needs ${stamp}`, phase: 'NEED_ACTION' },
      { title: `garden todo ${stamp}` },
      { title: `garden parked ${stamp}`, phase: 'WAITING' },
      { title: `garden done ${stamp}`, phase: 'COMPLETE' },
    ]),
    ...await seed(page, kitchen, [{ title: `kitchen focus ${stamp}`, pin: 'focus', phase: 'NEED_ACTION' }]),
  ]
  const [gFocus, gNeeds, gTodo, gParked, gDone, kFocus] = ids
  await presetPanelDesign(page, 'status')
  await boot(page, baseURL!, { 'walnut-todo-tier-used': '1' })
  try {
    const panel = page.locator('.todo-panel').first()
    await selectTab(page, 'Pinned')
    // The saved folds the jump must not touch: the defaults, Waiting and Completed folded.
    const savedFolds = await page.evaluate((k) => localStorage.getItem(k), LS_STATUS_SECTIONS_KEY)

    const focusRow = statusSectionCard(panel, 'needs', gFocus)
    await expect(focusRow).toBeVisible({ timeout: 20_000 })
    await expect(statusSectionCard(panel, 'needs', kFocus)).toBeVisible()
    // Only the pinned tasks of the project are here before the click.
    await expect(panel.locator(`[data-task-id="${gNeeds}"]`)).toHaveCount(0)

    // The name reads as a link when the pointer is on it: underlined, in the accent colour.
    const link = focusRow.getByTestId('row-project-link')
    await expect(link).toHaveText(garden)
    const before = await link.evaluate((el) => getComputedStyle(el).textDecorationLine)
    expect(before).not.toContain('underline')
    await link.hover()
    await expect.poll(() => link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain('underline')
    await page.screenshot({ path: `${SHOTS}/project-link-hover.png`, clip: await panelClip(page) })

    await link.click()
    // The panel's own Project chip, the All view, and every section open.
    await expect(filterChip(page, 'project')).toHaveCount(1)
    await expect(filterChip(page, 'project')).toContainText(garden)
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
    for (const key of ['needs', 'waiting', 'done'] as const) {
      await expect(statusSectionToggle(panel, key)).toHaveAttribute('aria-expanded', 'true')
    }
    await expect(statusSectionCard(panel, 'needs', gFocus)).toBeVisible()
    await expect(statusSectionCard(panel, 'needs', gNeeds)).toBeVisible()
    await expect(await showSectionCard(panel, 'waiting', gTodo)).toBeVisible()
    await expect(await showSectionCard(panel, 'waiting', gParked)).toBeVisible()
    await expect(await showSectionCard(panel, 'done', gDone)).toBeVisible()
    // Another project's task is out, and the click did not open the row.
    await expect(panel.locator(`[data-task-id="${kFocus}"]`)).toHaveCount(0)
    await expect(panel.locator('.todo-pinned-card-active')).toHaveCount(0)
    await page.screenshot({ path: `${SHOTS}/project-jump.png`, clip: await panelClip(page) })

    // A fold inside the jump is the jump's own; the saved folds stay as they were.
    await setStatusSectionOpen(panel, 'done', false)
    expect(await page.evaluate((k) => localStorage.getItem(k), LS_STATUS_SECTIONS_KEY)).toBe(savedFolds)

    // A reload keeps the jump, with the filter.
    await page.reload()
    await expect(filterChip(page, 'project')).toContainText(garden, { timeout: 30_000 })
    await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true')
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'true')
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')

    // Clearing the chip puts the view back: Pinned, Waiting and Completed folded again.
    await removeFilterChip(page, 'project')
    await expect(tab(page, 'Pinned')).toHaveAttribute('aria-selected', 'true')
    await expect(statusSectionCard(panel, 'needs', kFocus)).toBeVisible()
    await expect(panel.locator(`[data-task-id="${gNeeds}"]`)).toHaveCount(0)
    for (const key of ['waiting', 'done'] as const) {
      const toggle = statusSectionToggle(panel, key)
      if (await toggle.count()) await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }
    expect(await page.evaluate((k) => localStorage.getItem(k), LS_STATUS_SECTIONS_KEY)).toBe(savedFolds)

    // The row itself still opens on a click away from the name.
    await statusSectionCard(panel, 'needs', gFocus).locator('.todo-pinned-title').click()
    await expect(statusSectionCard(panel, 'needs', gFocus)).toHaveClass(/todo-pinned-card-active/)
  } finally {
    await cleanup(page, ids)
  }
})
