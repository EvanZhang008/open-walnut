/**
 * The "Sub" pill (web/src/components/tasks/SubtaskPill.tsx): a task with a
 * parent_task_id carries it on its pinned card and on its list row, a top-level
 * task never does, and clicking it leads to the parent. Its twin, the
 * "Leader · N" pill (LeaderPill.tsx), sits on the parent and lists every
 * subtask, the ones in other projects included; a row leads to that subtask.
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
import { REAL_PANEL } from './draft-helpers'

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
  // The parent's card carries the Leader pill with the count; the others do not.
  await expect(card(parent).locator('[data-testid="leader-pill"]')).toHaveText('Leader · 2')
  await expect(card(pinnedChild).locator('[data-testid="leader-pill"]')).toHaveCount(0)
  await expect(card(loose).locator('[data-testid="leader-pill"]')).toHaveCount(0)

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


test('a subtask in another project is a top-level row there, and its Sub pill leads to the parent', async ({ page, browserName }) => {
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
  // The parent leads both, across projects.
  const leaderPill = row(parent).locator('[data-testid="leader-pill"]')
  await expect(leaderPill).toHaveText('Leader · 2')
  await expect(row(near).locator('[data-testid="leader-pill"]')).toHaveCount(0)

  // Clicking the pill locates the PARENT (selects it), not the row it sits in.
  await farPill.click()
  await expect(row(parent)).toHaveClass(/task-focused/, { timeout: 10_000 })
  await expect(row(far)).not.toHaveClass(/task-focused/)

  // The Leader pill opens the list of subtasks: both of them, the one in the
  // other project labelled with that project; a row leads to that subtask.
  await leaderPill.click()
  const flyout = page.locator('[data-testid="leader-subtasks-flyout"]')
  await expect(flyout).toBeVisible()
  await expect(flyout.locator('[data-testid="leader-sub-row"]')).toHaveCount(2)
  const farRow = flyout.locator(`[data-testid="leader-sub-row"][data-task-id="${far}"]`)
  await expect(farRow.locator('.leader-sub-place')).toHaveText(projectB)
  await expect(flyout.locator(`[data-testid="leader-sub-row"][data-task-id="${near}"] .leader-sub-place`)).toHaveCount(0)
  // The flyout never leaves the viewport.
  const box = await flyout.boundingBox()
  const vp = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 0.5)
  // The leader's row and its open flyout together, for the human review of the run.
  const rowBox = (await row(parent).boundingBox())!
  const x = Math.max(0, Math.min(rowBox.x, box!.x) - 8), y = Math.max(0, Math.min(rowBox.y, box!.y) - 8)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SHOT_DIR}/${browserName}-leader-flyout.png`,
    clip: { x, y, width: Math.min(vp.width - x, Math.max(rowBox.x + rowBox.width, box!.x + box!.width) - x + 8), height: Math.min(vp.height - y, Math.max(rowBox.y + rowBox.height, box!.y + box!.height) - y + 8) },
  })
  await farRow.click()
  await expect(flyout).toHaveCount(0)
  await expect(row(far)).toHaveClass(/task-focused/, { timeout: 10_000 })
  await expect(row(parent)).not.toHaveClass(/task-focused/)
  // Escape closes a reopened flyout without leaving the page.
  await leaderPill.click()
  await expect(flyout).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)

  // The three rows across two projects, for the human review of the run.
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.locator('.todo-panel-list').first().screenshot({ path: `${SHOT_DIR}/${browserName}-cross-project.png` })
})


test('a parent\'s session header carries the Leader pill, and its list leads to each subtask', async ({ page, browserName }) => {
  // A Personal AI ask is never a board row: the session header is where a parent
  // that lives in the chat slot shows its team. The seeded "Model switch test
  // task" has a live session record, so a row click opens its column.
  test.setTimeout(120_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const parent = 'pw-task-model-switch'
  const near = await createTask(`Write the release note ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: parent })
  const far = await createTask(`Tell the ops channel ${stamp}`, { project: `Sub pill C ${stamp}`, pinned: false, parent_task_id: parent })

  await presetPanelView(page, { section: 'all', project: '' })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  const parentRow = page.locator(`.todo-panel-item[data-task-id="${parent}"]`)
  await expect(parentRow).toBeVisible({ timeout: 90_000 })
  await parentRow.locator('.todo-item-title').click()

  const panel = page.locator(`${REAL_PANEL}[data-session-id="pw-model-switch-session"]`)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const header = panel.locator('.session-panel-title-meta')
  const leader = header.locator('[data-testid="leader-pill"]')
  await expect(leader).toHaveText('Leader · 2')
  // It has no parent of its own, so no Sub pill in its header.
  await expect(header.locator('[data-testid="subtask-pill"]')).toHaveCount(0)

  await leader.click()
  const flyout = page.locator('[data-testid="leader-subtasks-flyout"]')
  await expect(flyout).toBeVisible()
  await expect(flyout.locator('[data-testid="leader-sub-row"]')).toHaveCount(2)
  await expect(flyout.locator(`[data-testid="leader-sub-row"][data-task-id="${far}"] .leader-sub-place`)).toHaveText(`Sub pill C ${stamp}`)
  const box = (await flyout.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5)
  const hb = (await header.boundingBox())!
  const x = Math.max(0, Math.min(hb.x, box.x) - 8), y = Math.max(0, hb.y - 8)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SHOT_DIR}/${browserName}-session-header-leader.png`,
    clip: { x, y, width: Math.min(vp.width - x, Math.max(hb.x + hb.width, box.x + box.width) - x + 8), height: Math.min(vp.height - y, box.y + box.height - y + 8) },
  })

  await flyout.locator(`[data-testid="leader-sub-row"][data-task-id="${near}"]`).click()
  await expect(flyout).toHaveCount(0)
  await expect(page.locator(`.todo-panel-item[data-task-id="${near}"]`)).toHaveClass(/task-focused/, { timeout: 10_000 })
})
