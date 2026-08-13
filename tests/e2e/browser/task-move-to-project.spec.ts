/**
 * Kebab "Project" picker — move a task to another project without dragging.
 *
 * Reported (2026-08-09): the task kebab had Pin/Priority/Start/Due but no way to
 * move the task to a different PROJECT — the only path was dragging the row
 * across group headers, which is impossible when the target project is collapsed
 * or off-screen. The kebab now carries a custom in-menu Project picker fed by
 * the project REGISTRY (so empty projects are valid targets), wired to the same
 * moveTask mutation as drag-and-drop.
 *
 * Follow-up in the same report: the first cut used a native <select>, which (a)
 * looked foreign in the styled menu and (b) on macOS swallowed the pointerup so
 * dnd-kit saw a held-down pointer and DRAGGED the row after picking a project.
 * The picker is now custom rows, and the menu stops pointerdown propagation so
 * no interaction inside it can arm the row's drag sensor. The right-click test
 * below asserts the no-drag invariant.
 *
 * The action under test is exercised through the real UI; REST is used only to
 * seed and to assert persistence.
 */
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = 'http://localhost:3457'

// Serial for the same reason as task-multi-select-batch.spec.ts: these tests
// mutate the one shared fixture task list.
test.describe.configure({ mode: 'serial', timeout: 90_000 })

/** Seed a task via REST (setup only — never the action under test). */
async function seedTask(title: string, project: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, project }),
  })
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string } }
  return body.task
}

async function fetchTaskProject(id: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/${id}`)
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  const body = (await res.json()) as { task: { project?: string } }
  return body.task.project ?? ''
}

function row(page: Page, title: string) {
  return page.locator('.todo-panel-item', { hasText: title }).first()
}

/** Open the Project picker inside an open kebab menu and pick an option.
 *  The option list is a PORTALLED flyout on <body>, not a child of the menu. */
async function pickProject(page: Page, optionName: string) {
  const menu = page.locator('.task-kebab-menu:visible')
  await menu.locator('.task-kebab-project-current').click()
  const list = page.locator('.task-kebab-project-flyout')
  await expect(list).toBeVisible()
  await list.locator('.task-kebab-project-opt', { hasText: optionName }).first().click()
}

/** Assert an element's box sits fully inside the viewport. */
async function assertInsideViewport(page: Page, locator: ReturnType<Page['locator']>, label: string) {
  const box = (await locator.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.y, `${label}: top edge above viewport`).toBeGreaterThanOrEqual(-1)
  expect(box.y + box.height, `${label}: bottom edge past viewport`).toBeLessThanOrEqual(vp.height + 1)
}

test('the row kebab moves a task to another project', async ({ page }) => {
  const task = await seedTask('Move me via kebab', 'Marina')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  const taskRow = row(page, 'Move me via kebab')
  await expect(taskRow).toBeVisible({ timeout: 15_000 })
  await taskRow.locator('.task-kebab-btn').click()

  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()

  // The Project row exists and reflects the CURRENT project.
  const currentBtn = menu.locator('.task-kebab-project-current')
  await expect(currentBtn).toBeVisible()
  await expect(currentBtn).toContainText('Marina')

  // Opening the picker must NOT grow the kebab menu past the viewport — the
  // list is a flyout, so both the menu and the flyout stay fully on screen.
  await currentBtn.click()
  const flyout = page.locator('.task-kebab-project-flyout')
  await expect(flyout).toBeVisible()
  await assertInsideViewport(page, menu, 'kebab menu with picker open')
  await assertInsideViewport(page, flyout, 'project flyout')

  // Move to an existing fixture project through the real control.
  await flyout.locator('.task-kebab-project-opt', { hasText: 'Ideas' }).first().click()

  // The menu closes and the row re-renders under the new project group.
  await expect(menu).toHaveCount(0)
  const ideasGroup = page.locator('.todo-group-project', { hasText: 'Ideas' })
  await expect(ideasGroup.locator('.todo-panel-item', { hasText: 'Move me via kebab' })).toBeVisible()

  // Persisted server-side, not just optimistic local state.
  await expect.poll(() => fetchTaskProject(task.id)).toBe('Ideas')
})

test('the kebab can move a task to Inbox (empty project)', async ({ page }) => {
  const task = await seedTask('Send me to inbox', 'Marina')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  const taskRow = row(page, 'Send me to inbox')
  await expect(taskRow).toBeVisible({ timeout: 15_000 })
  await taskRow.locator('.task-kebab-btn').click()

  await pickProject(page, 'Inbox')
  await expect.poll(() => fetchTaskProject(task.id)).toBe('')
})

test('picking a project from the right-click menu does not drag the row', async ({ page }) => {
  // The reported bug: right-click → pick project → the row followed the cursor
  // as a drag. dnd-kit arms its PointerSensor on pointerdown anywhere in the
  // sortable row; the portalled menu's events bubble through the React tree, so
  // without stopPropagation the pick armed the sensor and the next 5px of mouse
  // travel started a drag.
  const task = await seedTask('Right click move', 'Marina')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  // NO search filter here: search-mode rows render OUTSIDE the DndContext, so
  // they can't drag at all and the no-drag assertion would pass vacuously. The
  // drag bug lives in the grouped list. Rows shift as async loads land, so wait
  // for this row's position to hold still before measuring the click point
  // (observed: a stale box landed the right-click on a "+ Add" row).
  const taskRow = row(page, 'Right click move')
  await expect(taskRow).toBeVisible({ timeout: 15_000 })
  await taskRow.scrollIntoViewIfNeeded()
  let box = (await taskRow.boundingBox())!
  await expect.poll(async () => {
    const prev = box
    box = (await taskRow.boundingBox())!
    return Math.abs(box.y - prev.y) < 1
  }, { timeout: 10_000, intervals: [300] }).toBe(true)

  // Right-click the row body — this opens the same kebab menu at the cursor.
  // Explicit move + down/up (same as kebab-menu-viewport-fit.spec.ts): the
  // contextmenu handler lives on the [data-task-id] row element.
  await page.mouse.move(box.x + 60, box.y + box.height / 2)
  await page.mouse.down({ button: 'right' })
  await page.mouse.up({ button: 'right' })
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()

  await pickProject(page, 'Ideas')

  // Move the mouse right after the pick — with the bug this dragged the row
  // (a .drag-overlay-item appears while dnd-kit is dragging).
  await page.mouse.move(box.x + 200, box.y + 150, { steps: 5 })
  await expect(page.locator('.drag-overlay-item')).toHaveCount(0)

  await expect.poll(() => fetchTaskProject(task.id)).toBe('Ideas')
})

test('the multi-select batch menu moves every selected task to a project', async ({ page }) => {
  const a = await seedTask('Batch move one', 'Marina')
  const b = await seedTask('Batch move two', 'Marina')
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  // Enter multi-select via the first row's kebab, then click the second row.
  const first = row(page, 'Batch move one')
  await expect(first).toBeVisible({ timeout: 15_000 })
  await first.locator('.task-kebab-btn').click()
  await page.locator('.task-kebab-menu:visible').getByText('Select…').click()
  await row(page, 'Batch move two').click()
  await expect(page.locator('.task-selection-count')).toHaveText('2 selected')

  // Batch overflow menu → Project picker → Ideas.
  await page.locator('.task-selection-bar').getByRole('button', { name: /^More/ }).click()
  const dropdown = page.locator('.task-batch-dropdown')
  await expect(dropdown).toBeVisible()
  await dropdown.locator('.task-kebab-project-current').click()
  const list = page.locator('.task-kebab-project-flyout')
  await expect(list).toBeVisible()
  await list.locator('.task-kebab-project-opt', { hasText: 'Ideas' }).first().click()

  await expect.poll(() => fetchTaskProject(a.id)).toBe('Ideas')
  await expect.poll(() => fetchTaskProject(b.id)).toBe('Ideas')
})
