/**
 * Every task ⋮ menu groups its rows (KebabGroup): Pin to, Dates, More fields and Move &
 * transfer on the task half (TaskMenuRows); Open and Window at the top of a session's menu
 * (SessionMenuOpen) and one Session group at its foot holding Copy & open, Debug and Session
 * info. Every group starts closed each time the menu opens, so a spec reaching a row inside
 * one opens its group first; a group nested in Session opens Session on the way.
 */
import { expect, type Locator } from '@playwright/test'

export type KebabGroupId =
  | 'kebab-group-pin'
  | 'kebab-group-dates'
  | 'kebab-group-fields'
  | 'kebab-group-move'
  | 'session-kebab-open'
  | 'session-kebab-window'
  | 'session-kebab-session'
  | 'session-kebab-copy-open'
  | 'session-kebab-debug'
  | 'session-kebab-details'

/** The groups that live inside the Session group. */
const IN_SESSION: ReadonlySet<KebabGroupId> = new Set(['session-kebab-copy-open', 'session-kebab-debug', 'session-kebab-details'])

async function expand(group: Locator): Promise<Locator> {
  const toggle = group.locator('> .task-kebab-group-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return group.locator('> .task-kebab-group-body')
}

/** Open one group of an open task or session menu (idempotent); returns the group's rows. */
export async function openKebabGroup(menu: Locator, id: KebabGroupId): Promise<Locator> {
  if (IN_SESSION.has(id)) await expand(menu.getByTestId('session-kebab-session'))
  // Pin choices are already on the first level, with no group toggle to press.
  if (id === 'kebab-group-pin') return menu.getByTestId(id)
  return expand(menu.getByTestId(id))
}

/**
 * Where a task comes from, in its open task menu. The source row (the badge and
 * "Local", the service's name, or "Open in <service> ↗") lives inside Move & transfer
 * (TaskMenuRows.tsx, 3a4de0c38); only a broken or pending sync keeps a first-level row,
 * the sync warning ("<service> (unsynced)", "(sync error)").
 */
export async function openTaskSourceRow(menu: Locator): Promise<Locator> {
  const move = await openKebabGroup(menu, 'kebab-group-move')
  const row = move.locator('[data-testid="kebab-source-row"], [data-testid="kebab-source-link"]')
  await expect(row).toBeVisible()
  return row
}

/** The first-level sync warning row of an open task menu (count 0 when the sync is fine). */
export function taskSyncWarning(menu: Locator): Locator {
  return menu.getByTestId('kebab-sync-warning')
}
