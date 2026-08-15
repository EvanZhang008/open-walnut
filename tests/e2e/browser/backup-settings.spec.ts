/**
 * Playwright test: S3 Backup settings section.
 *
 * Real-UI flow: navigate to Settings via the sidebar, click the "S3 Backup"
 * nav item, fill the form, exercise Test Connection (fails fast against a
 * nonexistent bucket — we assert the error path renders, no real AWS needed),
 * and check the status line + restore hint render.
 */
import { test, expect } from '@playwright/test'

test.describe('S3 Backup settings', () => {
  test('section renders, saves, and test-connection reports failure honestly', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Real UI navigation (SPA click, not goto): sidebar → Settings.
    if ((await page.locator('.sidebar.collapsed').count()) > 0) {
      await page.locator('.sidebar-collapse-btn').click()
    }
    await page.locator('.sidebar-nav a[href="/settings"]').click()
    await page.locator('.settings-nav-item', { hasText: 'S3 Backup' }).click()

    const section = page.locator('#backup')
    await expect(section).toBeVisible({ timeout: 5000 })

    // The what-gets-backed-up explanation renders (users must know scope + that
    // credentials ride along before pointing this at a bucket).
    await expect(section).toContainText('What gets backed up')
    await expect(section).toContainText('auth.json')

    // Form fields present with defaults.
    await expect(section.locator('#backup-bucket')).toBeVisible()
    await expect(section.locator('#backup-region')).toHaveValue('us-west-2')
    await expect(section.locator('#backup-prefix')).toHaveValue('walnut')
    await expect(section.locator('#backup-interval')).toHaveValue('24')

    // Credential method selector offers the three methods.
    const method = section.locator('#backup-auth-method')
    await expect(method).toBeVisible()
    await method.selectOption('access_keys')
    await expect(section.locator('#backup-access-key')).toBeVisible()
    await expect(section.locator('#backup-secret-key')).toHaveAttribute('type', 'password')
    await method.selectOption('aws_chain')

    // Buttons disabled until a bucket is set.
    const testBtn = section.locator('button', { hasText: 'Test Connection' })
    const runBtn = section.locator('button', { hasText: 'Back Up Now' })
    await expect(testBtn).toBeDisabled()
    await expect(runBtn).toBeDisabled()

    await section.locator('#backup-bucket').fill('walnut-e2e-nonexistent-bucket-1234')
    await expect(testBtn).toBeEnabled()
    await expect(runBtn).toBeEnabled()

    // Status line: no backup yet.
    await expect(section).toContainText('No backup has run yet')

    // Restore hint names the CLI and the agent skill.
    await expect(section).toContainText('open-walnut backup restore')
    await expect(section).toContainText('restore-backup')

    // Test Connection against a nonexistent bucket must fail loudly, not hang:
    // STS/HeadBucket errors land in the red "Connection failed" line.
    await testBtn.click()
    await expect(section.locator('text=/Connection failed/')).toBeVisible({ timeout: 60_000 })
  })
})
