/**
 * Shared steps for the Routines page (/routines, and the same RoutinesView in the
 * homepage side panel).
 *
 * The page lists routines in groups (Global, then one per project); each routine is
 * one line (`li.routine-row`) that opens in place to its detail and its actions
 * (Run now / Run check now, Edit, Open task, Delete). The switch beside the line
 * pauses and resumes. The plain-language composer only shows after New routine,
 * when there are no routines at all, or while it holds an unsent draft.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** Open a routine's row (click its line) and wait for the detail. */
export async function openRoutineRow(row: Locator): Promise<Locator> {
  const line = row.locator('.routine-row-main')
  if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  const detail = row.locator('.routine-detail')
  await expect(detail).toBeVisible()
  return detail
}

/** Open the row, then click one of its action buttons by its exact name. */
export async function clickRoutineAction(row: Locator, name: string): Promise<void> {
  const detail = await openRoutineRow(row)
  await detail.getByRole('button', { name, exact: true }).click()
}

/** The /routines page's view (the homepage panel's compact one stays mounted beside it). */
export function routinesPageView(page: Page): Locator {
  return page.locator('.routines-view:not(.routines-view-compact)')
}

/**
 * Show the composer (New routine), unless it already shows: an empty list shows
 * it on its own, and so does an unsent draft. A Page means the /routines view.
 */
export async function openRoutineComposer(scope: Page | Locator): Promise<Locator> {
  const view = 'goto' in scope ? routinesPageView(scope) : scope
  const composer = view.locator('.routine-composer')
  const newBtn = view.locator('button.routines-new-btn')
  await expect(composer.or(newBtn).first()).toBeVisible({ timeout: 15_000 })
  // Parallel specs add and delete routines: the list can empty (the composer then
  // shows on its own and the button goes) between one look and the next.
  await expect(async () => {
    if (await composer.isVisible()) return
    if ((await newBtn.getAttribute('aria-expanded', { timeout: 1000 })) !== 'true') await newBtn.click({ timeout: 2000 })
    await expect(composer).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 20_000 })
  return composer
}

/** The manual path: New routine, then "Build it myself". */
export async function openManualRoutineForm(page: Page): Promise<Locator> {
  const composer = await openRoutineComposer(page)
  await composer.getByRole('button', { name: 'Build it myself' }).click()
  const form = page.locator('.routine-modal')
  await expect(form).toBeVisible()
  return form
}
