/**
 * The Board pane opens on Status, every task of the team by the one user status
 * (web/src/components/board/BoardStatusView.tsx); Cards is the team's kanban
 * (web/src/components/board/kanban/), and the leader's page is the Page view
 * (`board-view-custom`). Specs switch views the way a user does: the bar's segment.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/**
 * How a helper presses a control: a plain Playwright click by default; a spec that drives the
 * page by native input passes its own (`press` in real-press.ts).
 */
export type Press = (page: Page, target: Locator) => Promise<void>
const plainClick: Press = (_page, target) => target.click()

/** Show the leader's page in `pane` (the `task-board-pane`): waits for one to exist, then picks Page. */
export async function showCustomBoard(pane: Locator, press: Press = plainClick): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  if ((await custom.getAttribute('aria-checked')) !== 'true') await press(pane.page(), custom)
  await expect(custom).toHaveAttribute('aria-checked', 'true')
}

/** The phone layout's query (web/src/hooks/usePhoneLayout.ts PHONE_LAYOUT_QUERY). */
export const PHONE_QUERY = '(max-width: 768px), (pointer: coarse) and (max-height: 500px)'

export interface OpenBoardOptions {
  /** Runs right before the click that opens the Board (a spec that measures the open). */
  beforeClick?: () => Promise<void>
  press?: Press
}

/**
 * Opens the Board of the session in `panel` the way its layout offers it, and returns the
 * `task-board-pane`; a Board already open in it is left as it is. The ONLY way a spec opens a
 * Board from a session header (tests/scripts/board-chip-click-ratchet.test.ts): the header folds
 * the Board chip into its "..." menu when the row is too narrow (useSessionHeaderFit.ts, Board
 * leaves just before Terminal), and a direct chip click waits forever on a folded chip
 * (2026-11-22: the button family's wider keys folded it in a 460px Home column, and the replica
 * specs timed out). A window 768px wide or less is the phone layout (since 2026-10-15), where the
 * Board is a row of the top bar's More actions.
 */
export async function openSessionBoard(page: Page, panel: Locator, opts: OpenBoardOptions = {}): Promise<Locator> {
  const press = opts.press ?? plainClick
  const chip = panel.getByTestId('session-board-chip')
  const pane = page.getByTestId('task-board-pane')
  await expect(chip).toHaveCount(1, { timeout: 30_000 })
  if ((await chip.getAttribute('aria-pressed')) === 'true' && await pane.isVisible()) return pane
  const phone = await page.evaluate((q) => window.matchMedia(q).matches, PHONE_QUERY)
  // A chip on the row that turns live (the record loaded) is the one click: the specs measure
  // the Board as it opens from there. A chip the header folded (live on a desktop, any on a
  // phone, which keeps it hidden) takes the layout's other way, once it stays folded a beat.
  const place = async (): Promise<'row' | 'folded' | 'wait'> => {
    const hidden = (await chip.getAttribute('data-hidden')) === 'true'
    const enabled = await chip.isEnabled()
    if (!hidden && enabled && await chip.isVisible()) return 'row'
    return hidden && (phone || enabled) ? 'folded' : 'wait'
  }
  let where = await place()
  for (let folds = 0, deadline = Date.now() + 30_000; Date.now() < deadline;) {
    if (where === 'row') break
    if (where === 'folded' && ++folds >= 3) break
    if (where === 'wait') folds = 0
    await page.waitForTimeout(250)
    where = await place()
  }
  if (opts.beforeClick) await opts.beforeClick()
  if (where === 'row') {
    await press(page, chip)
  } else if (phone) {
    await press(page, page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }))
    const row = page.getByTestId('phone-row-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await press(page, row)
  } else if ((await chip.getAttribute('data-hidden')) === 'true') {
    await press(page, panel.getByTestId('session-header-more-btn'))
    const row = page.getByTestId('session-header-more-item-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await press(page, row)
  } else {
    await press(page, chip)
  }
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}

/**
 * Leaves the Board of the session in `panel` for its chat: on a phone the top bar's Back; on a
 * desktop the Board control toggles it (the chip, or its row in the header's "..." menu when
 * the chip is folded).
 */
export async function closeSessionBoard(page: Page, panel: Locator, press: Press = plainClick): Promise<void> {
  if (await page.evaluate((q) => window.matchMedia(q).matches, PHONE_QUERY)) {
    return press(page, page.locator('.phone-topbar').getByRole('button', { name: 'Back' }))
  }
  const chip = panel.getByTestId('session-board-chip')
  if ((await chip.getAttribute('data-hidden')) !== 'true') return press(page, chip)
  await press(page, panel.getByTestId('session-header-more-btn'))
  await press(page, page.getByTestId('session-header-more-item-board'))
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
