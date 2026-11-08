/**
 * A host whose link keeps dropping and coming back reads as unstable, not "Connected"
 * (2026-11-08: a laptop on the host network dropped every 30 s for hours, and Hosts, the
 * notification pane and host_list said Connected between drops). The real-replica fixture with
 * the Mac-to-companion link cut and restored on purpose three times (cloud-host-server.ts
 * CLOUD_HOST_LINK_CONTROL=1), then real clicks: the bell's host row, the folder picker's host
 * tab dot, and Settings > Remote Hosts' host row all say the link is unstable while it is up.
 *
 * Run with cloud-host-link-down.config.ts (one project at a time). PW_VIDEO=1 records it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { draftCwdPill, loadHome, openDraft } from './draft-helpers'
import { openBell, openRemoteHosts } from './host-problems-fixture-helpers'
import { pickRail } from './banner-placement-helpers'

const CLOUD = '__cloudbox__'
/** PW_SHOTS=<dir> keeps a picture of each surface it checks. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (process.env.PW_SHOTS) await page.screenshot({ path: path.join(process.env.PW_SHOTS, `${name}.png`) })
}
const UNSTABLE = /Unstable: its link dropped [3-9] times in the last 30 min/

interface Fixture { linkControlPort: number }
async function fixture(): Promise<Fixture> {
  const port = new URL(String(test.info().project.use.baseURL)).port
  const file = path.join(os.tmpdir(), `walnut-cloudhost-pw-${port}.json`)
  for (let i = 0; i < 240 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Fixture
}
const setLink = async (fx: Fixture, m: 'pass' | 'drop-hold') =>
  (await fetch(`http://127.0.0.1:${fx.linkControlPort}/mode?m=${m}`)).json()

async function cloudFrame(page: Page): Promise<{ connected?: boolean; drops?: number[] } | undefined> {
  const res = await page.request.get('/api/hosts/status')
  const body = await res.json() as { hosts?: Array<{ host: string; connected?: boolean; drops?: number[] }> }
  return body.hosts?.find((h) => h.host === CLOUD)
}
async function waitLink(page: Page, connected: boolean): Promise<void> {
  await expect.poll(async () => (await cloudFrame(page))?.connected ?? false, { timeout: 120_000, intervals: [500] }).toBe(connected)
}

test('a link that dropped three times reads unstable on the bell, the picker and the fleet card', async ({ page }) => {
  test.setTimeout(480_000)
  const fx = await fixture()
  await setLink(fx, 'pass')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await loadHome(page)
  await waitLink(page, true)

  // Before: a steady link reads Connected.
  let bellPanel = await openBell(page)
  await pickRail(page, 'System')
  const row = bellPanel.locator(`.nfc-daemon-row[data-host="${CLOUD}"] .nfc-daemon-status`)
  await expect(row).toHaveText(/^Connected/, { timeout: 30_000 })
  await shot(page, 'bell-before')
  await page.keyboard.press('Escape')

  // The link drops and comes back, three times.
  for (let i = 0; i < 3; i++) {
    await setLink(fx, 'drop-hold')
    await waitLink(page, false)
    await setLink(fx, 'pass')
    await waitLink(page, true)
  }
  expect((await cloudFrame(page))?.drops?.length ?? 0).toBeGreaterThanOrEqual(3)

  // The bell's host row.
  bellPanel = await openBell(page)
  await pickRail(page, 'System')
  await expect(bellPanel.locator(`.nfc-daemon-row[data-host="${CLOUD}"] .nfc-daemon-status`)).toHaveText(UNSTABLE, { timeout: 30_000 })
  await expect(bellPanel.getByTestId('nfc-remote-hosts')).toHaveClass(/\bwarn\b/)
  await shot(page, 'bell')
  await page.waitForTimeout(1500)
  await page.keyboard.press('Escape')

  // The folder picker's host tab wears the warn dot, its title naming the drops.
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  const tab = page.locator(`.session-path-selector .sps-host-tab[data-host="${CLOUD}"]`)
  await expect(tab).toBeVisible({ timeout: 60_000 })
  const dot = tab.locator('[data-kind]').first()
  await expect(dot).toHaveAttribute('data-kind', 'warn', { timeout: 30_000 })
  await tab.hover()
  await shot(page, 'picker')
  await page.waitForTimeout(1500)
  await page.keyboard.press('Escape')

  // Settings > Remote Hosts: the host's row says the link is unstable, under an amber dot.
  await openRemoteHosts(page)
  const settingsRow = page.locator(`[data-testid="remote-hosts-list"] .rh-host-row[data-host-alias="${CLOUD}"]`)
  await expect(settingsRow).toBeVisible({ timeout: 60_000 })
  await settingsRow.scrollIntoViewIfNeeded()
  await expect(settingsRow.getByTestId('rh-row-state')).toContainText(/^Unstable: dropped [3-9] times in 30 min/, { timeout: 60_000 })
  await expect(settingsRow.getByTestId('rh-row-warning')).toContainText('Link unstable: dropped')
  await expect(settingsRow.locator('.sps-host-dot').first()).toHaveAttribute('data-kind', 'warn')
  await shot(page, 'fleet-card')
  await page.waitForTimeout(2000)
  expect(errors).toEqual([])
})
