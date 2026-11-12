/**
 * Workers fold into their leader on Home's Flat sections (worker-fold.ts, WorkerFoldTree.tsx;
 * 2026-11-11, the user picked design 2, "inline tree", of ten). A worker of a real leader is no
 * row of its own: the leader's row says "N workers" (and how many need the user) and opens a tree below
 * it. The take-out arrow at a line's end makes one worker a row again, the put-back arrow puts it
 * back (each says what it does the moment the pointer is on it), "All" does the whole team, and
 * Display's "Fold workers into leaders" turns it off; each
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
    // Only who needs the user is counted on the folded line: nobody here.
    await expect(lead.getByTestId('worker-fold-mix')).toHaveCount(0)
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

    // Take one out: it is a row again, and its line wears the put-back arrow. The arrow says what
    // it does as soon as the pointer is on it (no native title delay).
    await item1.hover()
    const takeOut = item1.getByTestId('worker-fold-separate')
    await expect(takeOut).toHaveAttribute('data-fold-tip', /Take out/)
    await expect(takeOut).not.toHaveAttribute('title', /./)
    await takeOut.hover()
    const tip = page.getByTestId('worker-fold-tip')
    await expect(tip).toBeVisible({ timeout: 500 })
    await expect(tip).toHaveText('Take out: show as its own row in the list')
    await takeOut.click()
    // The new row pushes the line down, out from under the pointer: no hint stays behind.
    await expect(tip).toBeHidden()
    // React keeps the same button, now the put-back arrow: its hint has the new words.
    await item1.getByTestId('worker-fold-back').hover()
    await expect(tip).toHaveText(/^Put back into Ship the fold leader/)
    await page.mouse.move(1, 1)
    await expect(tip).toBeHidden()
    const row1 = statusSectionCard(panel, 'waiting', w1)
    await expect(row1).toBeVisible()
    await expect(item1.getByTestId('worker-fold-back')).toHaveAttribute('data-fold-tip', /^Put back into /)
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
    const { project, leader, w1 } = await team(page, { leader: { phase: 'NEED_ACTION' } })
    await seed(page, { title: 'Fold worker that needs you', project, parent_task_id: leader, phase: 'NEED_ACTION' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', false)
    const lead = await showSectionCard(panel, 'needs', leader)
    // The folded line counts only who needs the user.
    await expect(lead.getByTestId('worker-fold-toggle')).toHaveText('3 workers')
    await expect(lead.getByTestId('worker-fold-mix')).toHaveText('1 needs you')
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

  // On the user's data the Focus column was about 120px wide: the hint ran off the column's left
  // edge and each line showed only "Waiting / snoozed", its title squeezed to nothing (2026-11-12).
  test('in a narrow column the hint stays whole in the window and a line keeps its title', async ({ page, baseURL }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await openHome(page, baseURL!)
    const { leader, w1 } = await team(page)
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    const lead = await showSectionCard(panel, 'waiting', leader)
    await lead.getByTestId('worker-fold-toggle').click()
    const item = panel.locator(`[data-testid="worker-fold-tree"][data-host-id="${leader}"] [data-fold-task-id="${w1}"]`)
    const view = page.viewportSize()!
    for (const width of [180, 240, 420]) {
      await page.locator('#home-task-navigation').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, width)
      await item.scrollIntoViewIfNeeded()
      // The title is drawn before the state: some of it always shows.
      const title = await item.locator('.worker-fold-title').evaluate((e) => e.getBoundingClientRect().width)
      expect(title, `title width in a ${width}px column`).toBeGreaterThan(30)
      await item.hover()
      const ctl = item.getByTestId('worker-fold-separate')
      await ctl.hover()
      const tip = page.getByTestId('worker-fold-tip')
      await expect(tip).toBeVisible({ timeout: 500 })
      const box = (await tip.boundingBox())!
      expect(box.x, `hint left edge in a ${width}px column`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `hint right edge in a ${width}px column`).toBeLessThanOrEqual(view.width)
      expect(box.y).toBeGreaterThanOrEqual(0)
      // The words are whole, not cut by the column.
      expect(await tip.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
      await page.mouse.move(view.width - 2, view.height - 2)
      await expect(tip).toBeHidden()
    }
    // Keyboard focus shows the hint too, and a pointer moving elsewhere leaves it.
    await page.locator('#home-task-navigation').evaluate((el) => { (el as HTMLElement).style.width = '' })
    await item.hover()
    const ctl = item.getByTestId('worker-fold-separate')
    await ctl.focus()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    const tip = page.getByTestId('worker-fold-tip')
    await expect(tip).toHaveText('Take out: show as its own row in the list')
    await page.mouse.move(view.width - 2, view.height - 2)
    await page.mouse.move(view.width - 40, view.height - 40)
    await expect(tip).toBeVisible()
    // Focus moves on: the box names the newly focused control, or hides when it has no hint.
    await page.keyboard.press('Tab')
    const next = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.foldTip ?? null)
    if (next) await expect(tip).toHaveText(next)
    else await expect(tip).toBeHidden()
  })
})
