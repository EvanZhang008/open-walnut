/**
 * Settings > Walnut Health (HealthMonitorSection.tsx) against the fixture's real
 * monitor, seeded with a busy day (health-monitor-fixture.ts): the alarm list with
 * states, values and sparks, a row that opens to what Walnut did and its history,
 * Mute and Unmute round-tripping to the server, and the keyboard opening a row.
 */
import { test, expect, type Page } from '@playwright/test'
import { HEALTH_HOST, HEALTH_SPIKE_SIG } from './health-monitor-fixture'
import { signatureId } from '../../../src/core/health-monitor/log-alarms'
import { isolateUiPrefs } from './todo-panel-helpers'

async function openHealth(page: Page): Promise<void> {
  // Opening the sidebar is a synced layout pref: kept to this spec on the shared fixture.
  await isolateUiPrefs(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-walnut-health').click()
  await expect(page.locator('#walnut-health')).toBeVisible({ timeout: 10_000 })
}

test.describe('Walnut Health', () => {
  test('lists the alarms, opens one to what Walnut did, and mutes it through the server', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await openHealth(page)
    const section = page.locator('#walnut-health')

    // the seeded alarms lead the list, in ALARM
    const link = section.locator(`tr[data-alarm="host.link{host=${HEALTH_HOST}}"]`)
    await expect(link).toBeVisible()
    await expect(link.locator('.health-pill')).toHaveText('Alarm')
    await expect(link).toContainText('Host link keeps dropping')
    await expect(link).toContainText(HEALTH_HOST)
    await expect(link.locator('.health-did')).toContainText('filed a fix task')
    await expect(link.locator('svg.health-spark path')).toHaveCount(1)
    // The seeded spike by its id: the shared fixture server's own log lines raise spike
    // alarms of their own as other specs run, each with the same title.
    const spike = section.locator(`tr[data-alarm="log.spike:${signatureId(HEALTH_SPIKE_SIG)}"]`)
    await expect(spike).toContainText('Log line far above its normal')
    await expect(spike).toContainText(HEALTH_SPIKE_SIG)
    await expect(section.getByTestId('health-summary')).toContainText('in alarm')
    // every built-in alarm has a row, the ones without data too
    expect(await section.locator('tr.health-row').count()).toBeGreaterThanOrEqual(12)

    // open the disk alarm: what Walnut did, its condition and its history
    const disk = section.locator('tr[data-alarm="disk.free"]')
    await disk.click()
    const detail = section.getByTestId('health-detail')
    await expect(detail).toContainText('Alarm when:')
    await expect(detail).toContainText('task-directory sweep')
    await expect(detail).toContainText('History')

    // mute round-trips to the server and back into the row
    await detail.getByRole('button', { name: 'Mute 24 hours' }).click()
    await expect(detail.getByRole('button', { name: 'Unmute' })).toBeVisible()
    await expect(disk.locator('.health-did')).toHaveText('Muted: no actions for now')
    const after = await page.request.get('/api/v1/health-monitor/alarms/disk.free')
    expect((await after.json()).held).toBe(true)
    await detail.getByRole('button', { name: 'Unmute' }).click()
    await expect(detail.getByRole('button', { name: 'Mute 24 hours' })).toBeVisible()
    expect((await (await page.request.get('/api/v1/health-monitor/alarms/disk.free')).json()).held).toBe(false)

    // the same row closes on a second click; the keyboard opens another
    await disk.click()
    await expect(section.getByTestId('health-detail')).toHaveCount(0)
    await link.focus()
    await page.keyboard.press('Enter')
    await expect(section.getByTestId('health-detail')).toContainText('filed a fix task')
    expect(errors).toEqual([])
  })
})
