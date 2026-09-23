/**
 * Playwright test: S3 Backup settings pane.
 *
 * Real-UI flow: navigate to Settings via the sidebar, click the "S3 Backup"
 * nav item, turn scheduled backups on, fill the form, exercise Test connection
 * (fails fast against a nonexistent bucket; we assert the error path renders,
 * no real AWS needed), and check the status row and restore hint render.
 *
 * Config writes are answered in the page (PUT /api/config never reaches the
 * shared fixture server), so turning backups on here cannot start a scheduler
 * for the other specs that share that server.
 */
import { test, expect, type Page } from '@playwright/test'

async function holdConfigWrites(page: Page): Promise<void> {
  let written: Record<string, unknown> | null = null
  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      written = (body.config as Record<string, unknown> | undefined) ?? body
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    const res = await route.fetch()
    const data = await res.json() as { config: Record<string, unknown> }
    data.config = written
      ? { ...data.config, ...written }
      : { ...data.config, backup: { enabled: false, bucket: '', region: 'us-west-2', prefix: 'walnut', interval_hours: 24 } }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
}

test.describe('S3 Backup settings', () => {
  test('section renders, saves, and test-connection reports failure honestly', async ({ page }) => {
    await holdConfigWrites(page)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // Real UI navigation (SPA click, not goto): sidebar, then Settings, then the pane.
    if ((await page.locator('.sidebar.collapsed').count()) > 0) {
      await page.locator('.sidebar-collapse-btn').click()
    }
    await page.locator('.sidebar-nav a[href^="/settings"]').click()
    await page.getByTestId('settings-nav-backup').click()

    const section = page.locator('#backup')
    await expect(section).toBeVisible({ timeout: 5000 })

    // The what-gets-backed-up explanation renders (users must know scope + that
    // credentials ride along before pointing this at a bucket).
    await expect(section).toContainText('What gets backed up')
    await expect(section).toContainText('auth.json')

    // The master switch leads; the form under it is dimmed until it is on.
    const enabled = section.locator('#backup-enabled')
    await expect(enabled).toHaveAttribute('aria-checked', 'false')
    await enabled.click()
    await expect(enabled).toHaveAttribute('aria-checked', 'true')

    // Form fields present with defaults.
    await expect(section.locator('#backup-bucket')).toBeVisible()
    await expect(section.locator('#backup-region')).toHaveValue('us-west-2')
    await expect(section.locator('#backup-prefix')).toHaveValue('walnut')
    await expect(section.locator('#backup-interval')).toHaveValue('24')

    // Credential method is a segmented control offering the three methods.
    await expect(section.locator('#backup-auth-method')).toBeVisible()
    await section.getByTestId('backup-auth-access_keys').click()
    await expect(section.locator('#backup-access-key')).toBeVisible()
    await expect(section.locator('#backup-secret-key')).toHaveAttribute('type', 'password')
    await section.getByTestId('backup-auth-aws_chain').click()
    await expect(section.locator('#backup-access-key')).toHaveCount(0)

    // Buttons disabled until a bucket is set.
    const testBtn = section.getByTestId('backup-test-connection')
    const runBtn = section.getByTestId('backup-run-now')
    await expect(testBtn).toHaveText('Test connection')
    await expect(runBtn).toHaveText('Back up now')
    await expect(testBtn).toBeDisabled()
    await expect(runBtn).toBeDisabled()

    await section.locator('#backup-bucket').fill('walnut-e2e-nonexistent-bucket-1234')
    await expect(testBtn).toBeEnabled()
    await expect(runBtn).toBeEnabled()

    // Status row: no backup yet.
    await expect(section.getByTestId('backup-last-row')).toContainText('No backup has run yet')

    // Restore hint names the CLI and links the agent skill.
    await expect(section).toContainText('open-walnut backup restore')
    await expect(
      section.locator('a[href*="skills/restore-backup"]', { hasText: 'restore-backup skill' }),
    ).toBeVisible()

    // Test connection against a nonexistent bucket must fail loudly, not hang:
    // STS/HeadBucket errors land in the Connection row's error help.
    await testBtn.click()
    await expect(section.getByTestId('backup-connection-row')).toContainText(/Couldn't connect/, { timeout: 60_000 })
    // A config re-read can still be inside the route callback when the page closes.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
})
