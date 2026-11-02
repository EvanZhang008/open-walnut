/**
 * The /tasks table renders only the rows in its view (plus a few) once it holds more
 * than WINDOW_MIN_ITEMS items (web/src/components/tasks/tasks-table-window.ts: one per
 * group header, task row and ghost row). The shared fixture server passes that on CI,
 * where a shard's earlier specs have added their tasks, so a row or a project header
 * further down the list is not in the DOM until the table is scrolled to it, and a
 * spec that waited for it failed with "element(s) not found" (2026-11-01:
 * draft-surface-plus waited 25 s for the SurfacePlusProj header). A spec either
 * narrows the table first (types into `.tp-search`, picks a project in the rail) or
 * scrolls to what it needs through revealInTasksTable.
 * tests/scripts/browser-spec-ratchets.test.ts keeps every spec doing one of the two.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The table's scroller: the element the window follows. */
export function tasksTable(page: Page): Locator {
  return page.getByTestId('tasks-table')
}

/** Two frames: the table recomputes its window on the next frame after a scroll. */
async function settle(table: Locator): Promise<void> {
  await table.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/**
 * Scroll the /tasks table until `target` (a row or a group header in it) is rendered,
 * then bring it into view. Sweeps from the top a view at a time, and sweeps again until
 * `timeout` while the item has not arrived yet (a task made a moment ago). Leaves the
 * pointer where it was, so a rest-state reading after it is still a rest state.
 */
export async function revealInTasksTable(page: Page, target: Locator, timeout = 20_000): Promise<void> {
  const table = tasksTable(page)
  await expect(table).toBeVisible({ timeout: 30_000 })
  await expect(async () => {
    if ((await target.count()) === 0) {
      await table.evaluate((el) => { el.scrollTop = 0 })
      await settle(table)
      for (let step = 0; step < 400 && (await target.count()) === 0; step++) {
        const atEnd = await table.evaluate((el) => {
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return true
          el.scrollTop += Math.max(200, el.clientHeight - 80)
          return false
        })
        if (atEnd) break
        await settle(table)
      }
    }
    expect(await target.count(), 'not in the /tasks table, scrolled top to bottom').toBeGreaterThan(0)
    // Inside the retry: a table that redraws as more tasks arrive (the Complete chip loads
    // the archive) can take the row away again between the find and the scroll.
    await target.first().scrollIntoViewIfNeeded({ timeout: 2_000 })
    await settle(table)
    expect(await target.count(), 'left the /tasks table window again').toBeGreaterThan(0)
  }).toPass({ timeout })
}

/**
 * `target` is nowhere in the /tasks table: checked in every window, top to bottom, since
 * a count of 0 in one window says nothing about the rows the table did not render.
 */
export async function expectNotInTasksTable(page: Page, target: Locator): Promise<void> {
  const table = tasksTable(page)
  await expect(table).toBeVisible({ timeout: 30_000 })
  await table.evaluate((el) => { el.scrollTop = 0 })
  await settle(table)
  for (let step = 0; step < 400; step++) {
    await expect(target, 'in the /tasks table').toHaveCount(0, { timeout: 1_000 })
    const atEnd = await table.evaluate((el) => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return true
      el.scrollTop += Math.max(200, el.clientHeight - 80)
      return false
    })
    if (atEnd) return
    await settle(table)
  }
}
