/**
 * The extension's Settings at the toolbar popup's real size (360 by 600, Chrome's tallest
 * popup): the lock choice sits on one line with its select and its help runs under it at full
 * width (it was squeezed into a column ten lines tall beside the select), and the settings a
 * person changes (lock, filling, agents) fit in the first screen; the connection and Disconnect
 * close the page. Each state is saved as a screenshot (LOOK_SHOTS, else the task's review dir).
 */
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { VAULT_MASTER, vaultSession } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It needs its unlocks to hold on the shared fixture vault, where another file may end every unlock.
holdVaultLock('shared', 'file')

const POPUP = { width: 360, height: 600 }
const SHOTS = process.env.LOOK_SHOTS
  || (process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'review/round3-fixes-shots', process.env.LOOK_PHASE || 'after') : '')

let ctx: BrowserContext
let extId = ''
let base = ''

async function shot(p: Page, name: string, fullPage = false): Promise<void> {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await p.waitForTimeout(250)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage })
}

async function popup(): Promise<Page> {
  const p = await ctx.newPage()
  await p.setViewportSize(POPUP)
  await p.goto(`chrome-extension://${extId}/popup.html`)
  return p
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-set-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-set-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: POPUP,
    args: [`--disable-extensions-except=${path.join(dir, 'chrome')}`, `--load-extension=${path.join(dir, 'chrome')}`],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  extId = new URL(worker.url()).host

  // A vault to unlock, then the extension connected and unlocked.
  const p = await ctx.newPage()
  await vaultSession(p, base, { password: VAULT_MASTER })
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page', { timeout: 30_000 })
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  // Agents in this browser stay off here, as the person may choose on this page (on by default):
  // a browser of this spec must not join the fixture Walnut's agents beside the agent specs' own.
  await connect.getByTestId('connect-extension-agents').uncheck()
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  // The first page stays open: closing a persistent context's last page closes the browser.
  const un = await popup()
  // Walnut's own unlock may already open the extension too; else the master password here.
  const search = un.getByLabel('Search Walnut')
  const master = un.getByLabel('Master password')
  await expect(search.or(master)).toBeVisible({ timeout: 30_000 })
  if (await master.isVisible()) {
    await master.fill(VAULT_MASTER)
    await un.getByTestId('popup-unlock').click()
  }
  await expect(search).toBeVisible({ timeout: 30_000 })
  await un.close()
})

test.afterAll(async () => { await ctx?.close() })

test('Settings in the popup: the lock help runs under its select at full width, and lock, filling and agents fit the first screen', async () => {
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await p.getByTestId('popup-settings').click()
  const lock = p.getByTestId('popup-autolock')
  const help = p.getByTestId('popup-autolock-help')
  await expect(help).toContainText('Change it in Walnut')
  await shot(p, 'settings-first-screen')
  await shot(p, 'settings-whole', true)

  // The select shares one line with "Lock passwords"; the help starts below both and spans the row.
  const box = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!
  const title = await box(p.getByText('Lock passwords', { exact: true }))
  const sel = await box(lock)
  const text = await box(help)
  const row = await box(p.getByTestId('popup-lock-row'))
  expect(Math.abs((title.y + title.height / 2) - (sel.y + sel.height / 2))).toBeLessThan(8)
  expect(text.y).toBeGreaterThanOrEqual(sel.y + sel.height - 1)
  expect(text.width).toBeGreaterThan(row.width - 40)
  // A few lines, never the ten of a narrow column.
  const lineHeight = await help.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 16)
  expect(text.height / lineHeight).toBeLessThanOrEqual(4)

  // Without scrolling: the lock choice, both filling switches and the agents switch.
  for (const id of ['popup-autolock', 'popup-pagefill', 'popup-copytotp', 'popup-agents']) {
    const b = await box(p.getByTestId(id))
    expect(b.y + b.height, `${id} is on the first screen`).toBeLessThanOrEqual(POPUP.height)
  }
  // The connection and Disconnect close the page, still a click away.
  await expect(p.getByTestId('popup-disconnect')).toBeAttached()
  const conn = await box(p.getByTestId('popup-connection'))
  expect(conn.y).toBeGreaterThan((await box(p.getByTestId('popup-agents'))).y)

  // A choice still saves and its help follows it.
  await lock.selectOption('15')
  await expect(help).toContainText('after this long with no use')
  await shot(p, 'settings-lock-15')
  await lock.selectOption('walnut')
  await p.close()
})
