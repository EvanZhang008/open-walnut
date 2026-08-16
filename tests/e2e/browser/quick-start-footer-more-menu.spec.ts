import { test, expect } from '@playwright/test'
import { openDraft } from './draft-helpers'

const PIN_TIER_KEY = 'open-walnut-launcher-pin-tier'

test('Quick Start footer keeps primary controls visible and opens task settings upward', async ({ page }) => {
  // The launcher's pin tier is sticky and MIRRORED TO THE SERVER, whose
  // ui-prefs.json is shared by every spec in the run — so the "defaults to
  // Satellite" assertion below has to seed its own state rather than inherit
  // whatever tier another spec last picked. A local value beats the server copy
  // in ui-prefs-sync's boot merge, so set it before any app code runs.
  await page.addInitScript((key) => {
    try { localStorage.setItem(key as string, 'satellite') } catch { /* storage disabled */ }
  }, PIN_TIER_KEY)
  await page.goto('/')

  // The launcher is reached through a DRAFT session column now: "+" grows the
  // column, its cwd pill opens this same picker (unchanged `.sps-*` markup).
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()

  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })

  const footer = selector.locator('.sps-meta-footer')
  await expect(footer.getByRole('combobox', { name: 'Session model' })).toBeVisible()
  await expect(footer.getByRole('group', { name: 'Coding agent engine' })).toBeVisible()
  // The pin tier is a per-launch decision — it stays in the PRIMARY row, and a
  // fresh launcher defaults to Satellite.
  const tiers = footer.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers).toBeVisible()
  await expect(tiers.getByRole('button', { name: 'Satellite' })).toHaveAttribute('aria-pressed', 'true')

  await expect(footer.getByTitle('Start this task marked unread')).toHaveCount(0)
  await expect(footer.getByText('Priority', { exact: true })).toHaveCount(0)

  const more = footer.getByRole('button', { name: /More/ })
  await more.click()

  // PAGE-scoped: the More popover pops out of its host (portalled to <body>,
  // fixed own width, placed at the button by useMenuPlacement) — it is no
  // longer a footer descendant.
  const popover = page.getByRole('dialog', { name: 'More task settings' })
  await expect(popover).toBeVisible()
  // The retired star toggle is gone from the menu entirely (pin + focus tier is
  // the working set now).
  await expect(popover.getByTitle('Star this task')).toHaveCount(0)
  await expect(popover.getByTitle('Start this task marked unread')).toBeVisible()
  await expect(popover.getByText('Priority', { exact: true })).toBeVisible()
  // The task dates trio lives here too (start leads; end/due ghost when empty) —
  // the launch IS a task create, so the Quick Task form's dates exist on it.
  await expect(popover.locator('.sps-meta-dates .dp-trigger')).toHaveCount(3)
  // Pin moved OUT of the menu — it must not be duplicated there.
  await expect(popover.getByRole('group', { name: 'Pin new task to tier' })).toHaveCount(0)

  await page.screenshot({ path: '/tmp/quick-start-footer/more-open.png' })

  // Toggling a menu-owned field flips the "More · N" changed-from-default badge.
  // (This used to click the star toggle; unread is the remaining boolean there.)
  const before = await more.textContent()
  await popover.getByTitle('Start this task marked unread').click()
  await expect(more).toHaveClass(/active/)
  await expect(more).not.toHaveText(before ?? '')

  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(selector).toBeVisible()
})
