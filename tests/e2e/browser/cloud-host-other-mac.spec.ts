/**
 * A second Mac on a companion that belongs to another one, with a REAL
 * replica behind it (fixture: cloud-host-server.ts with CLOUD_HOST_SECOND_MAC=1).
 *
 *   1. Picking Cloud asks the companion for a machine credential; it answers 409,
 *      and Cloud's problem row (notification panel) says "Another Mac is connected to this cloud companion.
 *      Disconnect it there first." with how to hand it over and ONE details toggle.
 *   2. Retry asks again (the row stays: the companion is still that Mac's).
 *   3. Settings › Phones & Cloud › Remove the other Mac: refused (only that Mac
 *      itself, or the Mac the companion belongs to, may), and the row says so in full, as plain
 *      text, and the page's Saved / Not saved indicator stays away (a refusal is
 *      not an unsaved change). Show QR on it is refused on that same row. This Mac's own record is
 *      "This Mac" under Settings › Advanced › Device records (never in Phones & Cloud's
 *      All devices): no QR, and Unpair warns first (Cancel here). The handover is what
 *      the row says: `walnut device owner mac-second` on the companion.
 *   4. Retry on the row: this Mac mints, Cloud connects, and the box runs a
 *      daemon of this Mac's own (its own dir, keyed by its device id), never the
 *      other Mac's.
 *   5. Unpair this Mac (Settings › Advanced), confirmed: the companion drops it and what
 *      it minted, and All devices says this Mac is no longer paired, never that no phone
 *      has the app signed in.
 *
 * page.goto only loads the app; everything after is a real click or keystroke.
 */
import { bunRuntime } from '../../helpers/bun-runtime.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openBell } from './host-problems-fixture-helpers'
import { closePanel, pickRail, problemHosts, problemRow } from './host-attention-helpers'
import { draftCwdPill, loadHome, openDraft } from './draft-helpers'
import { backToDevices, cloudSyncRow, openWay } from './devices-ways-helpers'

const SHOTS = process.env.CLOUD_HOST_SHOTS ?? path.join(os.tmpdir(), 'walnut-cloud-host-shots')
const CLOUD = '__cloudbox__'
const SENTENCE = 'Another Mac is connected to this cloud companion. Disconnect it there first.'
const REFUSED = 'Only mac-primary itself or the Mac this cloud companion belongs to can remove or re-pair mac-primary.'
const UNPAIR_WARNING = 'Unpairing this Mac stops cloud sync, cuts your phones off from this Mac through the companion, and takes the Cloud host offline. Pairing it again needs a new token made on the companion.'
const UNPAIRED = 'This Mac is no longer paired with the cloud companion.'

/** Settings › Phones & Cloud › Devices, by real clicks. */
async function openDevices(page: Page): Promise<Locator> {
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByTestId('settings-nav-devices').click()
  return backToDevices(page)
}
/** The page-level Saved / Not saved indicator (settings-pane-context.tsx), wherever it renders. */
const savedIndicator = (page: Page) => page.getByTestId('settings-saved-indicator')
/**
 * Settings › Advanced, its "Device records" fold open (it remembers its state for the
 * session): this Mac's own cloud link lives there. Settings must be open.
 */
async function openOthers(page: Page): Promise<Locator> {
  await page.getByTestId('settings-nav-advanced').click()
  const section = page.locator('#advanced')
  await expect(section).toBeVisible({ timeout: 30_000 })
  const toggle = section.getByTestId('devices-others')
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  if (await toggle.getAttribute('data-open') !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('data-open', 'true')
  return section
}

interface Fixture { tunnelDir: string; boxAuth: string; boxData: string; boxHome: string; base: string; ids: Record<string, string> }
/** This engine's own companion (the config starts one per project, keyed by its port). */
async function fixture(): Promise<Fixture> {
  const port = new URL(String(test.info().project.use.baseURL)).port
  const file = path.join(os.tmpdir(), `walnut-cloudhost-pw-${port}.json`)
  for (let i = 0; i < 120 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Fixture
}
const owners = (f: Fixture) => (JSON.parse(fs.readFileSync(f.boxAuth, 'utf-8')) as { devices: Array<{ name: string; kind?: string; ownerId?: string; daemonKey?: string }> })
  .devices.filter((d) => d.kind === 'machine')
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')
/** `walnut device <args>` on the companion, as its operator runs it (its own data dir, a local caller); colours stripped. */
function boxCli(f: Fixture, ...args: string[]): string {
  return runBoxCli(f, args).replace(/\x1b\[[0-9;]*m/g, '')
}
function runBoxCli(f: Fixture, args: string[]): string {
  return execFileSync(bunRuntime(), [path.join(REPO, 'src', 'cli.ts'), 'device', ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    timeout: 90_000,
    env: {
      ...process.env,
      OPEN_WALNUT_HOME: f.boxData, HOME: f.boxHome, USERPROFILE: f.boxHome,
      WALNUT_CLOUD_MODE: '1', WALNUT_DAEMON_DIR: path.join(f.base, 'box-cli-logs'),
    },
  })
}

const picker = (page: Page): Locator => page.locator('.session-path-selector')
/** Cloud's row in the notification panel's problems, while it says another Mac holds the companion. */
const otherMacRow = (page: Page): Locator => page.locator(`.notification-panel [data-testid="nfc-problem-hosts"] li.hpb-row[data-host="${CLOUD}"][data-kind="cloud_other_mac"]`)
/** Open the bell on All, where the problem rows are. */
async function openAll(page: Page): Promise<void> {
  await openBell(page)
  await pickRail(page, 'All')
}

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

test('a second Mac hears another Mac is connected, and takes the companion over once the box operator names it', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const f = await fixture()
  expect(owners(f).map((d) => d.ownerId)).toEqual([f.ids['mac-primary'], f.ids['mac-primary']])

  // 1. Picking Cloud is what asks the companion.
  await loadHome(page)
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })
  const tab = picker(page).locator(`.sps-host-tab[data-host="${CLOUD}"]`)
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  await expect(picker(page)).toContainText('Another Mac is connected to this cloud companion', { timeout: 120_000 })
  await picker(page).screenshot({ path: path.join(SHOTS, `picker-cloud-other-mac-${browserName}.png`) })
  // The picker's keys live on its path box (the tab click left focus on the tab):
  // Escape there leaves the path edit first and closes the picker on the next
  // press. An open picker would sit on top of the rail's bell.
  const pathBox = picker(page).locator('.sps-search-input')
  await expect(async () => {
    if (await picker(page).isVisible()) await pathBox.press('Escape')
    await expect(picker(page)).toBeHidden({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })

  const row = problemRow(page, CLOUD)
  await openAll(page)
  await expect(otherMacRow(page)).toBeVisible({ timeout: 60_000 })
  await expect(row).toContainText('Another Mac is connected to this cloud companion')
  // A dense row shows its headline and Retry; how to hand it over is one Show details away.
  const toggles = row.locator('button.hft-details:visible')
  if (await toggles.first().innerText() === 'Show details') await toggles.first().click()
  await expect(toggles).toHaveCount(1)
  await expect(toggles).toHaveText('Hide details')
  await expect(row).toContainText('hand it to this Mac on the companion')
  await expect(row).toContainText('walnut device owner <name>')
  await expect(row.locator('pre.hft-summary')).toContainText(SENTENCE)
  await toggles.scrollIntoViewIfNeeded()
  await expect(row.locator('pre.hft-summary')).toBeInViewport()
  await problemHosts(page).screenshot({ path: path.join(SHOTS, `cloud-row-other-mac-open-${browserName}.png`) })
  await toggles.click()
  await expect(toggles).toHaveText('Show details')

  // 2. Retry asks again; the companion is still that Mac's, so the row stays.
  await row.getByRole('button', { name: 'Retry' }).click()
  await page.waitForTimeout(3_000)
  await expect(otherMacRow(page)).toBeVisible()
  expect(owners(f).map((d) => d.ownerId)).toEqual([f.ids['mac-primary'], f.ids['mac-primary']])
  expect(fs.existsSync(path.join(`${f.tunnelDir}.by-device`, f.ids['mac-primary'], 'daemon', 'daemon.pid'))).toBe(false)

  // 3. This Mac may not remove the other one: Settings › Phones & Cloud › Remove is refused, and says why.
  // The other Mac is listed as a Mac (the companion belongs to it), in its own
  // group: no phone wording and no Show QR.
  await closePanel(page, 'escape')
  let section = await openDevices(page)
  const macs = section.getByTestId('devices-macs')
  const other = macs.locator('.devices-row[data-device-name="mac-primary"]')
  await expect(other).toBeVisible({ timeout: 30_000 })
  await expect(other).toHaveAttribute('data-device-role', 'mac')
  await expect(macs).toContainText('Other Macs')
  await expect(other).not.toContainText('phone')
  await expect(other.getByTestId('devices-show-qr')).toHaveCount(0)
  await expect(section.locator('.devices-row[data-device-name="mac-primary"]')).toHaveCount(1)
  const remove = other.getByTestId('devices-remove')
  await remove.click()
  await expect(remove).toHaveText('Confirm remove')
  await remove.click()
  // The row's error line sits right under the row (SettingsRow renders it as its sibling).
  const refusal = section.locator('.devices-row[data-device-name="mac-primary"] + .settings-row-error')
  await expect(refusal).toHaveText(`Couldn't remove: ${REFUSED}`, { timeout: 30_000 })
  expect(await refusal.innerText()).not.toContain('`')
  await expect(other).toBeVisible()
  // A refusal is not an unsaved settings change: the page's Saved / Not saved
  // indicator stays away (it said "Not saved" here before).
  await expect(savedIndicator(page)).toHaveCount(0)
  await expect(page.getByText('Not saved')).toHaveCount(0)
  await section.screenshot({ path: path.join(SHOTS, `devices-remove-refused-${browserName}.png`) })
  expect(owners(f).map((d) => d.ownerId)).toEqual([f.ids['mac-primary'], f.ids['mac-primary']])

  await expect(section.locator('.settings-row-error')).toHaveCount(1)
  await expect(section.locator('.devices-qr-block')).toHaveCount(0)
  await macs.screenshot({ path: path.join(SHOTS, `devices-other-macs-${browserName}.png`) })

  // This Mac's own record is "This Mac" (the companion said which record its token
  // matched), in Settings › Advanced, not among the devices a person reaches Walnut
  // with: no QR, and Unpair warns before anything happens.
  await expect(section.locator('.devices-row[data-device-name="mac-second"]')).toHaveCount(0)
  await expect(section.getByTestId('devices-others')).toHaveCount(0)
  const advanced = await openOthers(page)
  await expect(advanced.getByTestId('devices-others-group')).toContainText('Device records')
  const self = advanced.locator('.devices-row[data-device-role="self"]')
  await expect(self).toHaveAttribute('data-device-name', 'mac-second')
  await expect(self.locator('.settings-row-label')).toHaveText(/^This Mac/)
  await expect(self.getByTestId('devices-show-qr')).toHaveCount(0)
  await expect(self.getByTestId('devices-remove')).toHaveCount(0)
  await self.getByTestId('devices-unpair-self').click()
  await expect(self.getByRole('alert')).toHaveText(UNPAIR_WARNING)
  await self.scrollIntoViewIfNeeded()
  await advanced.getByTestId('devices-others-group').screenshot({ path: path.join(SHOTS, `devices-this-mac-unpair-warning-${browserName}.png`) })
  await self.getByTestId('devices-unpair-self-cancel').click()
  await expect(self.getByRole('alert')).toHaveCount(0)
  await expect(self.getByTestId('devices-unpair-self')).toBeVisible()
  expect(JSON.parse(fs.readFileSync(f.boxAuth, 'utf-8')).devices.some((d: { name: string }) => d.name === 'mac-second')).toBe(true)

  // The handover, the way the row says: on the companion, `walnut device list` then `owner`.
  expect(boxCli(f, 'list')).toMatch(/mac-primary\s+\(owner\)/)
  expect(boxCli(f, 'owner', 'mac-second')).toContain('This cloud companion now belongs to "mac-second".')
  expect(owners(f)).toEqual([])
  expect(boxCli(f, 'list')).toMatch(/mac-second\s+\(owner\)/)

  // 4. The bell, from Settings: Retry on the row mints for this Mac and Cloud connects.
  await openAll(page)
  await row.getByRole('button', { name: 'Retry' }).click()
  await expect(row).toHaveCount(0, { timeout: 90_000 })
  await closePanel(page, 'escape')
  await expect.poll(async () => {
    const s = await (await page.request.get('/api/hosts/status')).json() as { hosts: Array<{ host: string; connected: boolean }> }
    return s.hosts.find((h) => h.host === CLOUD)?.connected
  }, { timeout: 60_000 }).toBe(true)
  expect(owners(f)).toEqual([expect.objectContaining({ name: 'bridge-local', ownerId: f.ids['mac-second'], daemonKey: f.ids['mac-second'] })])
  // Its own daemon, in its own dir (its device id, never its name); the other Mac's dir never came to be.
  expect(fs.existsSync(path.join(`${f.tunnelDir}.by-device`, f.ids['mac-second'], 'daemon', 'daemon.pid'))).toBe(true)
  expect(fs.existsSync(path.join(`${f.tunnelDir}.by-device`, 'mac-second'))).toBe(false)
  expect(fs.existsSync(path.join(`${f.tunnelDir}.by-device`, f.ids['mac-primary']))).toBe(false)
  expect(fs.existsSync(path.join(f.tunnelDir, 'daemon.pid'))).toBe(false)

  // 5. Unpair this Mac, confirmed: the companion drops it and the credential it
  // minted. All devices says so plainly (no red, no "may have been"), the Cloud
  // companion tab no longer pairs a phone, and it no longer says Connected.
  // The Cloud companion tab says Connected first (its Cloud sync row, under Manage cloud companion).
  section = await openDevices(page)
  const cloudCard = await openWay(page, 'cloud')
  await expect((await cloudSyncRow(page)).getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  const advancedAgain = await openOthers(page)
  const me = advancedAgain.locator('.devices-row[data-device-role="self"]')
  await me.getByTestId('devices-unpair-self').click()
  await expect(me.getByRole('alert')).toHaveText(UNPAIR_WARNING)
  await me.getByTestId('devices-unpair-self-confirm').click()
  // The record is gone from Advanced, with no error there.
  await expect(advancedAgain.locator('.devices-row[data-device-role="self"]')).toHaveCount(0, { timeout: 30_000 })
  await expect(advancedAgain.locator('.settings-notice-error')).toHaveCount(0)
  section = await openDevices(page)
  await expect(section.locator('.settings-notice-info', { hasText: UNPAIRED })).toHaveText(UNPAIRED, { timeout: 30_000 })
  await expect(section.locator('.settings-notice-error')).toHaveCount(0)
  await expect(section).not.toContainText('may have been unpaired')
  await expect(section.getByTestId('devices-phones-empty')).toHaveText('No phones paired with this Mac')
  await expect(section).not.toContainText('No phone has the Walnut app signed in yet')
  await expect(section.locator('.devices-row[data-device-role="self"]')).toHaveCount(0)
  const boxNames = (JSON.parse(fs.readFileSync(f.boxAuth, 'utf-8')) as { devices: Array<{ name: string }> }).devices.map((d) => d.name)
  expect(boxNames).not.toContain('mac-second')
  expect(owners(f)).toEqual([])
  await section.screenshot({ path: path.join(SHOTS, `devices-unpaired-plain-${browserName}.png`) })
  // And its tab no longer says Connected.
  await openWay(page, 'cloud')
  await expect(cloudCard.getByText('Not paired', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(cloudCard.getByText('Connected', { exact: true })).toHaveCount(0)
  await expect(cloudCard).toContainText(UNPAIRED)
  // Cloud is no longer a pairing target: its tab has no pairing of its own.
  await expect(cloudCard.getByTestId('way-pair-cloud')).toHaveCount(0)
  await cloudCard.scrollIntoViewIfNeeded()
  await cloudCard.screenshot({ path: path.join(SHOTS, `cloud-companion-unpaired-${browserName}.png`) })
  expect(errors).toEqual([])
})
