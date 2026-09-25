/**
 * The "Sub" pill (web/src/components/tasks/SubtaskPill.tsx): a task with a
 * parent_task_id carries it on its pinned card and on its list row, a top-level
 * task never does, and clicking it leads to the parent.
 *
 * Why it matters: whatever a session files is that session's SUBTASK
 * (caller-placement.ts), wherever it lands: new tasks land pinned in Satellite,
 * where every task is a flat card, and a task filed into ANOTHER project is a
 * top-level row there. Without the pill a delegated piece of work looked like
 * an unrelated top-level task. The server half (who becomes a subtask) is
 * pinned by tests/web/routes/api-v1-task-create-placement.test.ts; this spec
 * owns what a human SEES and can click.
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOT_DIR = '/tmp/subtask-pill'
const litter: string[] = []

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`create ${title} failed: ${res.status} ${await res.text()}`)
  const { task } = await res.json() as { task: { id: string } }
  litter.push(task.id)
  return task.id
}

test.beforeEach(async ({ page }) => {
  litter.length = 0
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  // Children first, so no delete trips over a parent that still has children.
  for (const id of [...litter].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

test('a subtask shows Sub on its pinned card and its list row; a top-level task does not', async ({ page, browserName }) => {
  // A cold home load under machine load takes well past the default 30s.
  test.setTimeout(120_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Sub pill ${stamp}`
  const parent = await createTask(`Bakery website ${stamp}`, { project, pinned: true })
  const pinnedChild = await createTask(`Build the menu page ${stamp}`, { project, pinned: true, parent_task_id: parent })
  const listChild = await createTask(`Build the contact page ${stamp}`, { project, pinned: false, parent_task_id: parent })
  const loose = await createTask(`Order flour ${stamp}`, { project, pinned: true })

  await presetPanelView(page, { section: 'all', project: '' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')

  // Pinned tier: every task is a flat card, so the pill is the only sign.
  const card = (id: string) => page.locator(`.todo-pinned-card[data-task-id="${id}"], .todo-focus-card[data-task-id="${id}"]`).first()
  await expect(card(pinnedChild)).toBeVisible({ timeout: 90_000 })
  const pill = card(pinnedChild).locator('[data-testid="subtask-pill"]')
  await expect(pill).toBeVisible()
  await expect(pill).toHaveText('Sub')
  await expect(pill).toHaveAttribute('data-parent-task-id', parent)
  await expect(card(parent).locator('[data-testid="subtask-pill"]')).toHaveCount(0)
  await expect(card(loose).locator('[data-testid="subtask-pill"]')).toHaveCount(0)

  // Its own violet, not the base pill's grey: the stylesheet loads before
  // globals.css, so a selector that only ties the base rule loses on order.
  // The page runs in the light scheme (emulateMedia before load).
  const paint = await pill.evaluate((el) => {
    const s = getComputedStyle(el)
    return { color: s.color, background: s.backgroundColor }
  })
  expect(paint.color).toBe('rgb(106, 79, 216)')
  expect(paint.background).toBe('rgba(124, 92, 255, 0.12)')

  // The pill never pushes the card past its width: the title ellipsizes first.
  const cardBox = await card(pinnedChild).boundingBox()
  const pillBox = await pill.boundingBox()
  expect(cardBox && pillBox).toBeTruthy()
  expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5)

  await fs.mkdir(SHOT_DIR, { recursive: true })
  await card(pinnedChild).screenshot({ path: `${SHOT_DIR}/${browserName}-pinned-card.png` })

  // Main list: the unpinned child renders under its parent (auto-expanded on
  // load) and carries the same pill.
  const row = page.locator(`.todo-panel-item[data-task-id="${listChild}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('[data-testid="subtask-pill"]')).toHaveText('Sub')
  await row.screenshot({ path: `${SHOT_DIR}/${browserName}-list-row.png` })
})


test('a subtask in another project is a top-level row there, and its Sub pill leads to the parent', async ({ page }) => {
  test.setTimeout(120_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const projectA = `Sub pill A ${stamp}`, projectB = `Sub pill B ${stamp}`
  const parent = await createTask(`GitLab token expiry ${stamp}`, { project: projectA, pinned: false })
  const near = await createTask(`Check the sync job ${stamp}`, { project: projectA, pinned: false, parent_task_id: parent })
  const far = await createTask(`Rotate the token ${stamp}`, { project: projectB, pinned: false, parent_task_id: parent })

  await presetPanelView(page, { section: 'all', project: '' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')

  const row = (id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"]`)
  await expect(row(far)).toBeVisible({ timeout: 90_000 })
  await expect(row(near)).toBeVisible({ timeout: 15_000 })

  // Same project: indented under the parent. Another project: its own top-level
  // row, flush with the parent (an indent would have moved it under the parent's
  // project header). Measured against the parent, because a top-level row has a
  // base margin of its own.
  const indent = (id: string) => row(id).evaluate((el) => parseFloat(getComputedStyle(el).marginLeft) || 0)
  const top = await indent(parent)
  expect(await indent(near)).toBeGreaterThan(top)
  expect(await indent(far)).toBe(top)

  // Both carry the pill, and the pill names the parent.
  const farPill = row(far).locator('[data-testid="subtask-pill"]')
  await expect(farPill).toHaveText('Sub')
  await expect(farPill).toHaveAttribute('data-parent-task-id', parent)
  await expect(farPill).toHaveAttribute('title', new RegExp(`GitLab token expiry ${stamp}`))
  await expect(row(near).locator('[data-testid="subtask-pill"]')).toHaveText('Sub')
  // The parent counts both, across projects.
  await expect(row(parent).locator('.task-children-badge')).toHaveText('2 sub')

  // Clicking the pill locates the PARENT (selects it), not the row it sits in.
  await farPill.click()
  await expect(row(parent)).toHaveClass(/task-focused/, { timeout: 10_000 })
  await expect(row(far)).not.toHaveClass(/task-focused/)
})
