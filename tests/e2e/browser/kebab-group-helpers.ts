/**
 * Every task ⋮ menu groups its rows (KebabGroup): Dates, Move & transfer on the task
 * half (TaskMenuRows), Views, Copy & open, Debug and Session info on the session half. Every group starts closed each
 * time the menu opens, so a spec reaching a row inside one opens its group first.
 */
import { expect, type Locator } from '@playwright/test'

export type KebabGroupId =
  | 'kebab-group-dates'
  | 'kebab-group-move'
  | 'session-kebab-views'
  | 'session-kebab-copy-open'
  | 'session-kebab-debug'
  | 'session-kebab-details'

/** Open one group of an open task or session menu (idempotent); returns the group's rows. */
export async function openKebabGroup(menu: Locator, id: KebabGroupId): Promise<Locator> {
  const group = menu.getByTestId(id)
  const toggle = group.locator('.task-kebab-group-toggle')
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return group.locator('.task-kebab-group-body')
}
