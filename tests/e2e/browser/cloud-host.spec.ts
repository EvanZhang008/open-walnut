/**
 * The cloud companion as a host in the folder picker, with a REAL replica and
 * the real /daemon-tunnel behind it (fixture: cloud-host-server.ts).
 *
 *   1. The picker lists a "Cloud" host tab without anyone configuring it.
 *   2. Picking it lists the BOX's folders (alpha, beta), live through the tunnel.
 *   3. Starting a session there opens a home column on host Cloud, and the
 *      box's mock CLI answers in it.
 *   4. The server's history re-read after the turn (through the tunnel) finds
 *      the streamed reply: no "may not have been saved" toast.
 *   5. The column offers no Terminal tab: Cloud has no SSH (its status frame
 *      carries terminal: false).
 *   6. The operator turns cloud.exec off: the real Cloud card names it with
 *      ONE details toggle, and Retry after turning it back on reconnects.
 *
 * page.goto only loads the app; everything after is a real click or keystroke.
 * Screenshots are cropped to the picker / the column. CLOUD_HOST_SHOTS picks
 * their directory (default under the OS temp dir).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftComposer, draftCwdPill, draftPanel, draftSend, loadHome, openDraft, REAL_PANEL } from './draft-helpers'

const SHOTS = process.env.CLOUD_HOST_SHOTS ?? path.join(os.tmpdir(), 'walnut-cloud-host-shots')
const CLOUD = '__cloudbox__'
const PORT = Number(process.env.PW_TEST_PORT ?? 3466)

test.describe.configure({ mode: 'serial' })

/** The fixture's port-keyed file (cloud-host-server.ts). */
async function fixture(): Promise<{ projects: string; boxConfig: string }> {
  const file = path.join(os.tmpdir(), `walnut-cloudhost-pw-${PORT}.json`)
  for (let i = 0; i < 120 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as { projects: string; boxConfig: string }
}
/** The box's folders (the replica's projects root). */
async function projectsDir(): Promise<string> {
  return (await fixture()).projects
}

const picker = (page: Page): Locator => page.locator('.session-path-selector')
const hostTab = (page: Page, host: string): Locator => picker(page).locator(`.sps-host-tab[data-host="${host}"]`)

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

test('the picker offers Cloud, lists the box folders, and a session starts there', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const projects = await projectsDir()

  await loadHome(page)
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible({ timeout: 15_000 })

  // 1. Cloud is there without any configuration, labelled "Cloud".
  const tab = hostTab(page, CLOUD)
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await expect(tab).toContainText('Cloud')
  await picker(page).screenshot({ path: path.join(SHOTS, `picker-cloud-chip-${browserName}.png`) })

  // 2. Selecting it lists the box's folders through the tunnel.
  await tab.click()
  await expect(tab).toHaveClass(/active/)
  const input = picker(page).locator('.sps-search-input')
  await input.fill(`${projects}/`)
  const rows = picker(page).locator('.sps-path-item')
  await expect(rows.filter({ hasText: 'alpha' }).first()).toBeVisible({ timeout: 90_000 })
  await expect(rows.filter({ hasText: 'beta' }).first()).toBeVisible()
  await picker(page).screenshot({ path: path.join(SHOTS, `picker-cloud-folders-${browserName}.png`) })

  // 3. Pick alpha and start a session there.
  await input.fill(`${projects}/alpha`)
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await input.press('Shift+Enter')
  await expect(picker(page)).toBeHidden({ timeout: 15_000 })
  await expect(draftCwdPill(panel)).toContainText('alpha')

  const reply = `hello from the cloud box in ${browserName}`
  await draftComposer(page).fill(`snapshot-clean-turn:${reply}`)
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
  // The composer's send arrow starts the draft (its one start affordance).
  await draftSend(draftPanel(page)).click()
  let res = await started
  if (res.status() === 409) {
    // A readiness gate the user may override: press it the way a user would.
    const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions/quick-start', { timeout: 120_000 })
    await page.getByRole('button', { name: 'Start anyway' }).click()
    res = await again
  }
  expect(res.status(), await res.text()).toBe(200)
  const { sessionId } = await res.json() as { sessionId: string }
  expect(sessionId).toBeTruthy()

  const column = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(column).toBeVisible({ timeout: 60_000 })
  // Exact: the user's own bubble ("snapshot-clean-turn:<reply>") contains the reply too.
  await expect(column.getByText(reply, { exact: true }).first()).toBeVisible({ timeout: 90_000 })
  await expect(column.getByText('Claude Code is working')).toHaveCount(0, { timeout: 30_000 })
  const record = await (await page.request.get(`/api/sessions/${sessionId}`)).json() as { host?: string; session?: { host?: string } }
  expect(record.host ?? record.session?.host).toBe(CLOUD)
  // Cloud has no SSH, so no terminal: its status frame says so and the tab is gone.
  const chips = column.locator('.session-action-chip')
  await expect(chips.filter({ hasText: 'Files' })).toBeVisible()
  await expect(chips.filter({ hasText: 'Terminal' })).toHaveCount(0)
  const status = await (await page.request.get('/api/hosts/status')).json() as { hosts: Array<{ host: string; terminal?: boolean }> }
  expect(status.hosts.find((h) => h.host === CLOUD)?.terminal).toBe(false)
  await column.screenshot({ path: path.join(SHOTS, `session-on-cloud-${browserName}.png`) })

  // 15s after a turn the server re-reads the history (through the tunnel, for
  // Cloud) and checks every streamed message is in it; a miss shows a toast.
  await page.waitForTimeout(17_000)
  await expect(page.getByText('Some session output may not have been saved')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('hosting turned off on the box: the Cloud card says so with ONE details toggle, and Retry brings Cloud back', async ({ page, browserName }) => {
  test.setTimeout(360_000)
  const { boxConfig } = await fixture()
  const original = fs.readFileSync(boxConfig, 'utf-8')
  await loadHome(page)
  const card = page.locator(`[data-testid="attention-banner"] li.hpb-row[data-host="${CLOUD}"]`).first()
  const toggles = card.locator('button.hft-details:visible')

  // The operator turns cloud.exec off. The open tunnel closes within one
  // heartbeat (30s); the Mac's redial hears 403 and the card appears.
  fs.writeFileSync(boxConfig, original.replace('enabled: true', 'enabled: false'))
  try {
    // A "Reconnecting to Cloud" row may stand there first; wait for the verdict.
    await expect(page.locator(`[data-testid="attention-banner"] li.hpb-row[data-host="${CLOUD}"][data-kind="cloud_exec_off"]`).first())
      .toBeVisible({ timeout: 150_000 })
    await expect(card).toContainText('Cloud companion has session hosting turned off')
    await expect(card).toContainText('cloud.exec.enabled: true')

    if (await toggles.first().innerText() === 'Show details') await toggles.first().click()
    await expect(toggles).toHaveCount(1)
    await expect(toggles).toHaveText('Hide details')
    await expect(card.locator('pre.hft-summary')).toContainText('cloud.exec.enabled is off there')
    // The host list is the card's one scroll region: scroll the open row's tail
    // into it as a user would, and prove it is on screen (toBeInViewport counts
    // every scrolling ancestor's clip; :visible does not).
    const cardShot = page.locator('[data-testid="attention-banner"]')
      .filter({ has: page.locator(`li.hpb-row[data-host="${CLOUD}"]`) }).first()
    await toggles.scrollIntoViewIfNeeded()
    await expect(toggles).toBeInViewport()
    await expect(card.locator('pre.hft-summary')).toBeInViewport()
    await cardShot.screenshot({ path: path.join(SHOTS, `cloud-card-exec-off-open-${browserName}.png`) })
    await toggles.click()
    await expect(toggles).toHaveCount(1)
    await expect(toggles).toHaveText('Show details')
    await expect(card.locator('pre.hft-summary')).toHaveCount(0)
    await toggles.scrollIntoViewIfNeeded()
    await expect(toggles).toBeInViewport()
    await cardShot.screenshot({ path: path.join(SHOTS, `cloud-card-exec-off-closed-${browserName}.png`) })
  } finally {
    fs.writeFileSync(boxConfig, original)
  }
  // Hosting back on: the user's Retry re-asks the companion and Cloud connects.
  await card.getByRole('button', { name: 'Retry' }).click()
  await expect(card).toHaveCount(0, { timeout: 90_000 })
  await expect.poll(async () => {
    const s = await (await page.request.get('/api/hosts/status')).json() as { hosts: Array<{ host: string; connected: boolean }> }
    return s.hosts.find((h) => h.host === CLOUD)?.connected
  }, { timeout: 60_000 }).toBe(true)
})
