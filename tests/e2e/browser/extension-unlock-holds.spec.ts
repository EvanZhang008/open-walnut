/**
 * The extension's unlock holds (packages/browser-extension/src/walnut-api.ts keeps its vault session
 * in IndexedDB; bg-autolock.ts): unlocked in the popup, it stays unlocked after its service worker
 * restarts and after the browser itself restarts (the same profile launched again), with the default
 * auto-lock "Walnut's setting"; a person's own "When the browser closes" still locks at the next
 * start. The popup's settings say how long it stays unlocked. Fake data only.
 */
import { expect, chromium, test, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { ensureVaultSetUp } from './vault-session-helper'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/extension-unlock-holds'
let base = ''
let extDir = ''
let profile = ''
let ctx: BrowserContext
let extId = ''

async function launch(): Promise<void> {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1000, height: 720 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  extId = new URL(worker.url()).host
}

async function popup(): Promise<Page> {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  return p
}

const unlockedView = (p: Page) => p.getByLabel('Search Walnut')
const lockedView = (p: Page) => p.getByTestId('popup-unlock')

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-holds-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', out, '--no-zip'], { stdio: 'pipe' })
  extDir = path.join(out, 'chrome')
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-holds-profile-'))
  await launch()
  // The fixture's vault, set up when no other spec did (the same master password as theirs).
  const p = await ctx.newPage()
  await ensureVaultSetUp(p, base, { password: MASTER })
  // Connect, as a person does.
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  // Agents in this browser stay off here, as the person may choose on this page (on by default):
  // a browser of this spec must not join the fixture Walnut's agents beside the agent specs' own.
  await connect.getByTestId('connect-extension-agents').uncheck()
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()
})

test.afterAll(async () => { await ctx?.close() })

test('unlocked once, the extension stays unlocked across a service worker restart and a browser restart', async () => {
  test.setTimeout(180_000)
  const p = await popup()
  await p.getByLabel('Master password').fill(MASTER)
  await lockedView(p).click()
  await expect(unlockedView(p)).toBeVisible({ timeout: 30_000 })
  await p.close()

  // The service worker stops (Chrome does this after 30 s idle) and starts again on the next message.
  const cdp = await ctx.newCDPSession(await ctx.newPage())
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')
  const p2 = await popup()
  await expect(unlockedView(p2)).toBeVisible({ timeout: 30_000 })
  await p2.close()

  // The browser quits and starts again on the same profile.
  await ctx.close()
  await launch()
  const p3 = await popup()
  await expect(unlockedView(p3)).toBeVisible({ timeout: 30_000 })
  await expect(lockedView(p3)).toHaveCount(0)
  await p3.close()
})

test('the popup settings say how long it stays unlocked; "When the browser closes" locks at the next start', async () => {
  test.setTimeout(180_000)
  const p = await popup()
  await expect(unlockedView(p)).toBeVisible({ timeout: 30_000 })
  await p.getByTestId('popup-settings').click()
  const select = p.getByTestId('popup-autolock')
  await expect(select).toHaveValue('walnut')
  await expect(p.getByTestId('popup-autolock-help')).toContainText(/Stays unlocked|Locks after/)
  await p.setViewportSize({ width: 380, height: 640 })
  await p.screenshot({ path: `${SHOTS}/popup-settings.png` })
  await select.selectOption('browser')
  await expect(p.getByTestId('popup-autolock-help')).toContainText('Locks when the browser closes')
  await p.close()

  await ctx.close()
  await launch()
  const p2 = await popup()
  await expect(lockedView(p2)).toBeVisible({ timeout: 30_000 })
  await p2.close()
})
