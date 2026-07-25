import { test, expect } from '@playwright/test'

test('Quick Start footer keeps primary controls visible and opens task settings upward', async ({ page }) => {
  await page.goto('/')

  const pill = page.getByRole('button', { name: /Quick session|\+ Session/i })
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()

  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })

  const footer = selector.locator('.sps-meta-footer')
  await expect(footer.getByRole('combobox', { name: 'Session model' })).toBeVisible()
  await expect(footer.getByRole('group', { name: 'Coding agent engine' })).toBeVisible()

  await expect(footer.getByTitle('Star this task')).toHaveCount(0)
  await expect(footer.getByTitle('Flag as needs attention')).toHaveCount(0)
  await expect(footer.getByText('Pin to', { exact: true })).toHaveCount(0)
  await expect(footer.getByText('Priority', { exact: true })).toHaveCount(0)

  const more = footer.getByRole('button', { name: /More/ })
  await more.click()

  const popover = footer.getByRole('dialog', { name: 'More task settings' })
  await expect(popover).toBeVisible()
  await expect(popover.getByTitle('Star this task')).toBeVisible()
  await expect(popover.getByTitle('Flag as needs attention')).toBeVisible()
  await expect(popover.getByText('Pin to', { exact: true })).toBeVisible()
  await expect(popover.getByText('Priority', { exact: true })).toBeVisible()

  await page.screenshot({ path: '/tmp/quick-start-footer/more-open.png' })

  const before = await more.textContent()
  await popover.getByTitle('Star this task').click()
  await expect(more).toHaveClass(/active/)
  await expect(more).not.toHaveText(before ?? '')

  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(selector).toBeVisible()
})
