/**
 * Rows of a session panel's ⋮ menu (the `.task-kebab-btn` in its header; on an Org node page the
 * header is the node's, so the kebab sits in `[data-testid="org-detail-chat-tools"]`), and the
 * header's own Watch and Locate buttons.
 *
 * Locate and Watch are window buttons of the header since 2026-11-19 (the user: "why locate task is
 * not at top right?"), first in the row: Watch, Locate, Minimize, Lock, Expand, Close. Locate is
 * `session-locate-btn` (aria-label "Locate task" when the page gave a handler, else "Find on
 * Home"), disabled while the session record that names the task is on its way; Watch is
 * `session-watch-btn` (aria-pressed, aria-label "Watch" / "Stop watching"). A desktop session menu
 * has neither a Locate row nor a `task-kebab-watch` row; a phone, with no header, keeps the Watch
 * row and has no Locate. Open in new tab is only the Window group's row (`session-menu-popout`):
 * the header has no button for it.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { openKebabGroup } from './kebab-group-helpers'

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

/**
 * The header's Locate button of `scope`'s session. A column inside a host surface (a Board peek)
 * draws its header in the host's and keeps its own hidden, so only the one on screen counts.
 */
export function sessionLocateButton(scope: Locator): Locator {
  return scope.getByTestId('session-locate-btn').filter({ visible: true }).first()
}

/** The header's Watch eye of `scope`'s session (the one on screen, as Locate). */
export function sessionWatchButton(scope: Locator): Locator {
  return scope.getByTestId('session-watch-btn').filter({ visible: true }).first()
}

/** Locate the session's task from its header: click the crosshair once the record names the task. */
export async function locateFromHeader(scope: Locator): Promise<void> {
  const btn = sessionLocateButton(scope)
  await expect(btn).toBeEnabled({ timeout: 30_000 })
  await btn.click()
}

/**
 * Open `scope`'s session in a new tab from its ⋮ menu (Window > Open in new tab) and return the
 * new page once it opened.
 */
export async function popoutFromKebab(scope: Locator): Promise<Page> {
  const page = scope.page()
  const menu = await openSessionKebab(scope)
  const windowRows = await openKebabGroup(menu, 'session-kebab-window')
  const opened = page.context().waitForEvent('page')
  await windowRows.getByTestId('session-menu-popout').click()
  return opened
}
