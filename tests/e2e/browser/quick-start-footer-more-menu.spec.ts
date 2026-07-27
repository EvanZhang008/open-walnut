import { test, expect } from '@playwright/test'

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

  const pill = page.getByRole('button', { name: /Quick session|\+ Session/i })
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()

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

  await expect(footer.getByTitle('Star this task')).toHaveCount(0)
  await expect(footer.getByTitle('Flag as needs attention')).toHaveCount(0)
  await expect(footer.getByText('Priority', { exact: true })).toHaveCount(0)

  const more = footer.getByRole('button', { name: /More/ })
  await more.click()

  const popover = footer.getByRole('dialog', { name: 'More task settings' })
  await expect(popover).toBeVisible()
  await expect(popover.getByTitle('Star this task')).toBeVisible()
  await expect(popover.getByTitle('Flag as needs attention')).toBeVisible()
  await expect(popover.getByText('Priority', { exact: true })).toBeVisible()
  // Pin moved OUT of the menu — it must not be duplicated there.
  await expect(popover.getByRole('group', { name: 'Pin new task to tier' })).toHaveCount(0)

  await page.screenshot({ path: '/tmp/quick-start-footer/more-open.png' })

  const before = await more.textContent()
  await popover.getByTitle('Star this task').click()
  await expect(more).toHaveClass(/active/)
  await expect(more).not.toHaveText(before ?? '')

  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(selector).toBeVisible()
})
