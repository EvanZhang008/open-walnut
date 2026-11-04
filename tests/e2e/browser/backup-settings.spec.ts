/**
 * Playwright: Settings → Backup, the real pane in the browser.
 *
 * Config writes are answered in the page (PUT /api/config never reaches the
 * shared fixture server), and the backup routes that would reach outside the
 * machine (a bucket, Google) are answered in the page too, so the specs that
 * share the fixture server never start a backup. The routes themselves are
 * covered against real stores in tests/e2e/backup-encrypted-routes.test.ts.
 */
import { test, expect, type Page } from '@playwright/test'

// Fake, invented for this test: shaped like a recovery key, opens nothing.
const KEY = 'WB1-FAKE0-FAKE0-FAKE0-FAKE0-FAKE0-FAKE0-FAKE0-FAKE0-FAKE0-FAKE0-00'

async function holdConfigWrites(page: Page, initialBackup: Record<string, unknown>): Promise<{ last: () => Record<string, unknown> | null }> {
  let written: Record<string, unknown> | null = null
  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      written = { ...(written ?? {}), ...((body.config as Record<string, unknown> | undefined) ?? body) }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    }
    const res = await route.fetch()
    const data = await res.json() as { config: Record<string, unknown> }
    data.config = { ...data.config, backup: initialBackup, ...(written ?? {}) }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
  })
  return { last: () => written }
}

async function answer(page: Page, glob: string, body: unknown, status = 200): Promise<void> {
  await page.route(glob, (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }))
}

async function openBackup(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-backup').click()
  const section = page.locator('#backup')
  await expect(section).toBeVisible({ timeout: 5000 })
  return section
}

test.describe('Backup settings', () => {
  test('a new setup: R2 fields, test, recovery key, restore', async ({ page }) => {
    const config = await holdConfigWrites(page, {})
    await answer(page, '**/api/backup/status', { configured: false, running: false, consecutiveFailures: 0, primary: true })
    await answer(page, '**/api/backup/destination/test', { ok: true, destination: 'r2://walnut-backup/walnut-backup', canWrite: true, hasBackups: false, hasKey: false })
    let keyMade = false
    await page.route('**/api/backup/recovery-key', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ key: keyMade ? KEY : null }) }))
    await page.route('**/api/backup/recovery-key/ensure', (route) => {
      keyMade = true
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ key: KEY, created: true }) })
    })
    await answer(page, '**/api/backup/snapshots', {
      engine: 'encrypted',
      snapshots: [
        { id: 'snap-2', createdAt: '2026-11-04T06:00:00Z', hostname: 'mac', fileCount: 22597, totalBytes: 7.3e9 },
        { id: 'snap-1', createdAt: '2026-11-03T06:00:00Z', hostname: 'mac', fileCount: 22501, totalBytes: 7.2e9 },
      ],
    })
    let restoreBody: Record<string, unknown> | null = null
    await page.route('**/api/backup/restore', (route) => {
      restoreBody = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ started: true }) })
    })

    const section = await openBackup(page)
    await expect(section).toContainText('Everything in your data folder is backed up')
    // The service picker leads, R2 first; its free tier is stated in place.
    await expect(section.getByTestId('backup-service-r2')).toHaveAttribute('aria-checked', 'true')
    await expect(section).toContainText('Free up to 10 GB a month')
    // The steps to get the keys are one click away.
    await section.getByTestId('backup-r2-help').click()
    await expect(section.getByTestId('backup-r2-steps')).toContainText('Object Read & Write')

    const testBtn = section.getByTestId('backup-test-connection')
    await expect(testBtn).toBeDisabled()
    await expect(section.getByTestId('backup-run-now')).toBeDisabled()
    // Nothing to back up to yet: the switch waits, and says why.
    await expect(section.locator('#backup-enabled')).toBeDisabled()
    await expect(section.getByTestId('backup-enabled-row')).toContainText('Where backups go')
    await section.locator('#backup-r2-account').fill('0123456789abcdef0123456789abcdef')
    await section.locator('#backup-r2-bucket').fill('walnut-backup')
    await section.locator('#backup-r2-access-key').fill('AKEXAMPLE')
    await expect(section.getByTestId('backup-connection-row')).toContainText('Fill in: secret access key')
    await section.locator('#backup-r2-secret').fill('secret-example')
    await expect(testBtn).toBeEnabled()
    await expect(testBtn).toHaveText('Test and save')
    // Typing alone saves no destination.
    await page.waitForTimeout(1500)
    expect((config.last()?.backup as Record<string, unknown> | undefined)?.destination).toBeUndefined()
    await testBtn.click()
    await expect(section.getByTestId('backup-connection-row')).toContainText('Saved: backups go here now')

    // The saved config is encrypted backups: no legacy bucket an older Walnut would upload to.
    await expect.poll(() => (config.last()?.backup as Record<string, unknown> | undefined)?.destination).toMatchObject({
      type: 'r2', bucket: 'walnut-backup', account_id: '0123456789abcdef0123456789abcdef',
    })
    expect((config.last()?.backup as Record<string, unknown>).bucket).toBeUndefined()

    // The recovery key: hidden until asked, then saved-it.
    const keyRow = section.getByTestId('backup-key-row')
    await expect(keyRow).toBeVisible({ timeout: 10000 })
    await expect(section.getByTestId('backup-key-value')).toHaveCount(0)
    await section.getByTestId('backup-key-show').click()
    await expect(section.getByTestId('backup-key-value')).toHaveText(KEY)
    await expect(section.getByTestId('backup-key-unsaved')).toBeVisible()
    await section.getByTestId('backup-key-saved').click()
    await expect(section.getByTestId('backup-key-unsaved')).toHaveCount(0)
    // With a destination and a key, the switch can go on.
    await expect(section.locator('#backup-enabled')).toBeEnabled()
    await section.locator('#backup-enabled').click()
    await expect.poll(() => (config.last()?.backup as Record<string, unknown> | undefined)?.enabled).toBe(true)

    // Restore lists the backups, newest first and picked, and restores the one chosen.
    await expect(section.getByTestId('backup-run-now')).toBeEnabled()
    await section.getByTestId('backup-restore-open').click()
    const list = section.getByTestId('backup-restore-list')
    await expect(list.locator('label')).toHaveCount(2)
    await expect(list).toContainText('22,597 files')
    await list.locator('label').nth(1).click()
    await section.getByTestId('backup-restore-start').click()
    await expect.poll(() => restoreBody).toMatchObject({ snapshotId: 'snap-1' })
    await expect(section.locator('a[href*="skills/restore-backup"]')).toBeVisible()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('the older S3 copy keeps its form until the user switches', async ({ page }) => {
    const config = await holdConfigWrites(page, { enabled: true, bucket: 'old-bucket', region: 'eu-west-1', prefix: 'walnut', interval_hours: 24 })
    await answer(page, '**/api/backup/status', { configured: true, running: false, consecutiveFailures: 0, primary: true, engine: 'mirror' })
    const section = await openBackup(page)
    await expect(section).toContainText('files go to the bucket unencrypted')
    await expect(section.locator('#backup-bucket')).toHaveValue('old-bucket')
    await expect(section.getByTestId('backup-service-r2')).toHaveCount(0)
    await answer(page, '**/api/backup/destination/test', { ok: true, destination: 's3://old-bucket/walnut-backup', canWrite: true, hasBackups: false, hasKey: false })
    await section.getByTestId('backup-legacy-switch').click()
    await expect(section.getByTestId('backup-service-s3')).toHaveAttribute('aria-checked', 'true')
    await expect(section.locator('#backup-s3-bucket')).toHaveValue('old-bucket')
    await expect(section.locator('#backup-s3-region')).toHaveValue('eu-west-1')
    // The old copy keeps running until the new one is tested and saved.
    expect((config.last()?.backup as Record<string, unknown> | undefined)?.destination).toBeUndefined()
    await section.getByTestId('backup-test-connection').click()
    await expect.poll(() => (config.last()?.backup as Record<string, unknown> | undefined)?.destination).toMatchObject({
      type: 's3', bucket: 'old-bucket', region: 'eu-west-1', prefix: 'walnut-backup',
    })
    expect((config.last()?.backup as Record<string, unknown>).bucket).toBeUndefined()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('Google Drive with the user\'s own Google client, and the paste fallback', async ({ page }) => {
    const config = await holdConfigWrites(page, { enabled: true, destination: { type: 'gdrive' } })
    await answer(page, '**/api/backup/status', { configured: false, running: false, consecutiveFailures: 0, primary: true })
    await answer(page, '**/api/backup/recovery-key', { key: KEY, savedAt: '2026-11-01T00:00:00Z' })
    let connected = false
    await page.route('**/api/backup/gdrive/status', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ builtinClient: false, client: connected ? 'custom' : null, connected, email: connected ? 'someone@example.com' : null, folderName: 'Walnut Backup', pending: false }),
    }))
    let connectBody: Record<string, unknown> | null = null
    await page.route('**/api/backup/gdrive/connect', (route) => {
      connectBody = route.request().postDataJSON() as Record<string, unknown>
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authUrl: 'about:blank#google', redirectUri: 'http://127.0.0.1:5555' }) })
    })
    await page.route('**/api/backup/gdrive/complete', (route) => {
      connected = true
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, email: 'someone@example.com' }) })
    })

    const section = await openBackup(page)
    await expect(section.getByTestId('backup-service-gdrive')).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByTestId('backup-gdrive-steps')).toContainText('Desktop app')
    await expect(section.getByTestId('backup-gdrive-steps')).toContainText('Publish app')
    const connect = section.getByTestId('backup-gdrive-connect')
    await expect(connect).toBeDisabled()
    await section.locator('#backup-gdrive-client-id').fill('1234-abc.apps.googleusercontent.com')
    await section.locator('#backup-gdrive-client-secret').fill('client-secret-example')
    await expect(connect).toBeEnabled()
    await connect.click()
    await expect.poll(() => connectBody).toMatchObject({ client_id: '1234-abc.apps.googleusercontent.com' })
    await expect(section.getByTestId('backup-gdrive-open-link')).toBeVisible()
    await section.locator('#backup-gdrive-paste').fill('http://127.0.0.1:5555/?state=s&code=c')
    await section.getByTestId('backup-gdrive-finish').click()
    await expect(section.getByTestId('backup-gdrive-connected')).toContainText('someone@example.com')
    // Connected: Drive with this client is where backups go now.
    await expect.poll(() => (config.last()?.backup as Record<string, unknown> | undefined)?.destination).toMatchObject({
      type: 'gdrive', client_id: '1234-abc.apps.googleusercontent.com',
    })
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('looking at another service changes nothing; its fields are kept apart', async ({ page }) => {
    const r2 = { type: 'r2', bucket: 'my-bucket', account_id: '0123456789abcdef0123456789abcdef', access_key_id: 'AKEXAMPLE', secret_access_key: '••••••mple' }
    const config = await holdConfigWrites(page, { enabled: true, interval_hours: 24, destination: r2 })
    await answer(page, '**/api/backup/status', { configured: true, running: false, consecutiveFailures: 0, primary: true, engine: 'encrypted' })
    await answer(page, '**/api/backup/recovery-key', { key: KEY, savedAt: '2026-11-01T00:00:00Z' })
    await answer(page, '**/api/backup/gdrive/status', { builtinClient: true, client: 'builtin', connected: false, email: null, folderName: null, pending: false })
    const section = await openBackup(page)
    await expect(section.getByTestId('backup-service-row')).toContainText('Backups go to Cloudflare R2')
    await section.getByTestId('backup-service-gdrive').click()
    // Walnut's own Google client: Connect is all there is; the user's own client is optional and folded.
    await expect(section.getByTestId('backup-gdrive-connect')).toBeEnabled()
    await expect(section.getByTestId('backup-gdrive-own-client')).toBeVisible()
    await expect(section.locator('#backup-gdrive-client-id')).toBeHidden()
    await section.getByTestId('backup-service-s3').click()
    await section.locator('#backup-s3-bucket').fill('something-else')
    await page.waitForTimeout(1500)
    expect(config.last()).toBeNull()
    await section.getByTestId('backup-service-r2').click()
    await expect(section.locator('#backup-r2-bucket')).toHaveValue('my-bucket')
    await expect(section.getByTestId('backup-test-connection')).toHaveText('Test connection')
    await expect(section.getByTestId('backup-service-row')).toContainText('Backups go to Cloudflare R2')
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
})
