/**
 * The Board pane opens on Status, every task of the team by the one user status
 * (web/src/components/board/BoardStatusView.tsx); Cards is the team's kanban
 * (web/src/components/board/kanban/), and the leader's page is the Page view
 * (`board-view-custom`). Specs switch views the way a user does: the bar's segment.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** Show the leader's page in `pane` (the `task-board-pane`): waits for one to exist, then picks Page. */
export async function showCustomBoard(pane: Locator): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  if ((await custom.getAttribute('aria-checked')) !== 'true') await custom.click()
  await expect(custom).toHaveAttribute('aria-checked', 'true')
}

/** The phone layout's query (web/src/hooks/usePhoneLayout.ts PHONE_LAYOUT_QUERY). */
export const PHONE_QUERY = '(max-width: 768px), (pointer: coarse) and (max-height: 500px)'

/**
 * Opens the Board of the session in `panel` the way its layout offers it, and returns the
 * `task-board-pane`. A window 768px wide or less is the phone layout (since 2026-10-15), where
 * the Board is a row of the top bar's More actions; a desktop header too narrow for the chip
 * folds it into its "..." menu (2026-10-31: the 520px kanban specs waited up to 240 s on the
 * desktop chip, which a phone keeps hidden).
 */
export async function openSessionBoard(page: Page, panel: Locator, beforeClick?: () => Promise<void>): Promise<Locator> {
  const chip = panel.getByTestId('session-board-chip')
  await expect(chip).toHaveCount(1, { timeout: 30_000 })
  // A chip on the row that turns live (the record loaded) is the one click, whatever the
  // width, as a plain click waits for it: the specs measure the Board as it opens from
  // there. Only a chip that stays folded or hidden takes the layout's other way.
  const onRow = await expect.poll(async () => await chip.isEnabled() && (await chip.getAttribute('data-hidden')) !== 'true' && await chip.isVisible(),
    { timeout: 30_000 }).toBe(true).then(() => true, () => false)
  if (beforeClick) await beforeClick()
  if (onRow) {
    await chip.click()
  } else if (await page.evaluate((q) => window.matchMedia(q).matches, PHONE_QUERY)) {
    await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
    const row = page.getByTestId('phone-row-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await row.click()
  } else if ((await chip.getAttribute('data-hidden')) === 'true') {
    await panel.getByTestId('session-header-more-btn').click()
    const row = page.getByTestId('session-header-more-item-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await row.click()
  } else {
    await chip.click()
  }
  const pane = page.getByTestId('task-board-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}

/**
 * A task reference on the Board (a card's title, the leader's button) opens that task's session on
 * Home (useOpenTask), where the leader's column shows its chat in place of the Board. This brings the
 * Cards back the way a user does (the leader's Board chip, then Cards); a Board on screen is left as
 * it is. `leader` is the leader's session panel. Returns the `task-board-pane`.
 */
export async function backToBoard(page: Page, leader: Locator): Promise<Locator> {
  const pane = page.getByTestId('task-board-pane')
  const kanban = pane.getByTestId('board-kanban')
  await expect(async () => {
    if (await kanban.isVisible()) return
    if (await pane.count() === 0) await openSessionBoard(page, leader)
    await pane.getByTestId('board-view-cards').click({ timeout: 5_000 })
    await expect(kanban).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  return pane
}

/**
 * A synthetic open subtask of `parentId`, shaped as a row of the task list (GET /api/tasks), built
 * from the parent's own row when there is one (its session, team and status fields left out).
 */
export const openSubtaskId = (parentId: string) => `pw-open-subtask-of-${parentId}`

export function openSubtaskRow(parentId: string, parentRow?: Record<string, unknown>): Record<string, unknown> {
  const base = parentRow
    ? Object.fromEntries(Object.entries(parentRow).filter(([k]) => !/session|parent|children|subtask|user_status|org_|board|pinned|focus/i.test(k)))
    : { source: 'local', project: '', created_at: new Date().toISOString() }
  return {
    ...base,
    id: openSubtaskId(parentId),
    title: 'Open subtask (page-local)',
    parent_task_id: parentId,
    phase: 'IN_PROGRESS',
    status: 'in_progress',
    updated_at: new Date().toISOString(),
  }
}

/**
 * Make `taskId` a lead for this page only. The Board tab is a lead's, and a lead is a task with an
 * open subtask in the page's task store (web/src/components/sessions/board-tab-model.ts; a Board of
 * its own no longer counts, 2026-11-19), so every task list answer the store loads (GET /api/tasks
 * without `ids`) gains one open subtask of it. Nothing is written to the server.
 *
 * It acts from the next list fetch on: install it before the page loads (or reload after it).
 * Returns the subtask's id and how many list answers it changed.
 */
export async function leadForPage(page: Page, taskId: string): Promise<{ childId: string; lists: () => number }> {
  let lists = 0
  await page.route((url) => url.pathname === '/api/tasks' && !url.searchParams.has('ids'), async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return }
    try {
      const res = await route.fetch()
      if (!res.ok()) { await route.fulfill({ response: res }); return }
      const body = await res.json() as { tasks?: Array<Record<string, unknown>> }
      if (Array.isArray(body.tasks)) {
        body.tasks.push(openSubtaskRow(taskId, body.tasks.find((t) => t.id === taskId)))
        lists++
      }
      await route.fulfill({ response: res, json: body })
    } catch { /* the page is gone */ }
  })
  return { childId: openSubtaskId(taskId), lists: () => lists }
}
