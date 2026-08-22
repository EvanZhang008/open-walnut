import { test, expect } from '@playwright/test'

test('Keep-Awake only prevents system sleep and releases after 15 minutes offline', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
  }
  await page.locator('.sidebar-nav a[href="/settings"]').click()
  await page.locator('.settings-nav-item', { hasText: 'Advanced' }).click()

  const section = page.locator('#advanced')
  await expect(section).toBeVisible()
  await section.getByText(/Keep Mac Awake During Sessions/).click()

  await expect(section).toContainText('prevents system sleep')
  await expect(section).toContainText('Closing the lid turns connected screens off')
  await expect(section).toContainText('Connect an iPhone hotspot yourself')
  await expect(section.locator('#ka-offline')).toHaveAttribute('placeholder', '15')
  await expect(section.locator('#ka-ssid')).toHaveCount(0)
  await expect(section.locator('#ka-password')).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Detect' })).toHaveCount(0)
})
