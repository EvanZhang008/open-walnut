/**
 * Rows of a session panel's ⋮ menu (the `.task-kebab-btn` in its header; on an Org node page the
 * header is the node's, so the kebab sits in `[data-testid="org-detail-chat-tools"]`).
 *
 * Locate and Watch were the header's crosshair and eye until 2026-11-09 (the user: "this 2 put iot
 * in the drop down"): Locate is now a first-level row of the menu (`session-menu-locate`, "Locate
 * task" when the page gave a handler, else "Find on Home"), present once the session record names
 * a task, and Watch is the task's row (`task-kebab-watch`, "Watch" / "Stop watching"), which comes
 * with the task. A click on either row closes the menu.
 */
import { expect, type Locator } from '@playwright/test'

/** The ⋮ button of the session panel (or Org node header) `scope` holds: the first one in it. */
export function sessionKebabButton(scope: Locator): Locator {
  return scope.locator('.task-kebab-btn').first()
}

/** Open the ⋮ menu of `scope`'s session and return the open menu (portalled to the body). */
export async function openSessionKebab(scope: Locator): Promise<Locator> {
  const btn = sessionKebabButton(scope)
  await expect(btn).toBeVisible({ timeout: 20_000 })
  const menu = scope.page().locator('.task-kebab-menu')
  if (!(await menu.isVisible())) await btn.click()
  await expect(menu).toBeVisible()
  return menu
}

/** Open the ⋮ menu and return one of its rows by test id, once it is there (the task half loads with the task). */
export async function kebabRow(scope: Locator, testId: string): Promise<Locator> {
  const menu = await openSessionKebab(scope)
  const row = menu.getByTestId(testId)
  await expect(row).toBeVisible({ timeout: 30_000 })
  return row
}

/**
 * Close an open ⋮ menu by clicking its button again (a no-op when none is open). Not Escape: the
 * menu does not stop that key, so a layer under it (a Board peek's tab, full screen) would close too.
 */
export async function closeSessionKebab(scope: Locator): Promise<void> {
  const menu = scope.page().locator('.task-kebab-menu')
  if (!(await menu.isVisible())) return
  await sessionKebabButton(scope).click()
  await expect(menu).toHaveCount(0)
}

/** Locate the session's task from its ⋮ menu: open the menu and click its Locate row. */
export async function locateFromKebab(scope: Locator): Promise<void> {
  const row = await kebabRow(scope, 'session-menu-locate')
  await row.click()
  await expect(scope.page().locator('.task-kebab-menu')).toHaveCount(0)
}
