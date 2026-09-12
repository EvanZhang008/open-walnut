import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * A plugin's account link, end to end: the sync loop finds a dead credential,
 * the bell gets ONE card with a Sign in button, the button lands on the plugin's
 * row in Settings → Plugins, Sign in there shows a device code, and when the
 * flow completes the row turns "signed in", sync succeeds, and the card retires.
 *
 * What it pins:
 *   1. The notification is immediate (first failing tick, not the fifth), says
 *      what to do, and carries a labelled Sign in button.
 *   2. Settings shows the link's state on the row (badge) AND in a panel under
 *      it, together with what the sync loop saw (N failures, last error).
 *   3. Signing in never needs the terminal: device code + link + copy, and the
 *      panel updates by itself.
 *   4. Recovery is automatic: no dismiss, no reload. The card goes quiet, the
 *      badge leaves the row, the panel says signed in as whom.
 *
 * Runs against tests/e2e/browser/plugin-connection-server.ts (its own throwaway
 * home), because the real Microsoft plugin needs a real human at a real
 * Microsoft page.
 */

const SCREENSHOT_DIR = '/tmp/mstodo-auth'

interface Fixture {
  port: number
  home: string
  pluginId: string
  pluginName: string
  signInCompletesMs: number
  syncIntervalMs: number
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 900 } })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Plugin connection fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const check = () => {
      const match = /PLUGIN_CONNECTION_READY (\{.*\})/.exec(output)
      if (!match) return false
      clearTimeout(deadline)
      resolve(JSON.parse(match[1]!) as Fixture)
      return true
    }
    const timer = setInterval(() => {
      if (check()) clearInterval(timer)
      else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Plugin connection fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/plugin-connection-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_CONNECTION_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  await fs.writeFile(`${SCREENSHOT_DIR}/fixture-output.log`, output).catch(() => {})
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (child.exitCode === null) child.kill('SIGKILL')
})

test('dead credential → one Sign in card → Settings row → device code → signed in, card retires', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const failedRequests: string[] = []
  page.on('response', (res) => {
    if (res.status() >= 500 && res.url().includes('/api/')) failedRequests.push(`${res.status()} ${res.url()}`)
  })
  const { pluginId, pluginName } = fixture!
  // Every notification frame the page's socket saw, for the recovery assertion
  // below and for the failure report.
  const wsFrames: string[] = []
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString()
      if (text.includes('"notification:')) wsFrames.push(`${new Date().toISOString()} ${text.slice(0, 400)}`)
    })
  })
  const dumpFrames = () => fs.writeFile(`${SCREENSHOT_DIR}/ws-frames.log`, wsFrames.join('\n')).catch(() => {})

  // ── 1. The card ──
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail').getByRole('button', { name: /^Errors/ }).click()

  // The loop's first tick fails on the dead credential → the card, at once.
  const card = panel.locator('.notification-feed-item', { hasText: `${pluginName} needs you to sign in again` })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText('Sync is paused until you sign in; retrying will not fix this.')
  // One card, not one per failing tick.
  await expect(panel.locator('.notification-feed-item', { hasText: 'needs you to sign in again' })).toHaveCount(1)
  // No "run the auth command" anywhere on it.
  await expect(card).not.toContainText(/walnut auth|open-walnut auth/)
  const signInButton = card.getByTestId('nfc-producer-action')
  await expect(signInButton).toHaveText(/Sign in/)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/1-sign-in-card.png` })

  // ── 2. The button lands on the plugin's row in Settings → Plugins ──
  await signInButton.click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 })
  const row = page.getByTestId(`plugin-row-${pluginId}`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText('on')
  await expect(row.getByTestId(`plugin-row-connection-${pluginId}`)).toHaveText('sign in needed')

  const connection = page.getByTestId(`plugin-connection-${pluginId}`)
  await expect(connection).toBeVisible()
  await expect(connection).toHaveAttribute('data-connection-state', 'sign-in-required')
  await expect(connection.getByTestId(`plugin-connection-badge-${pluginId}`)).toHaveText('sign in needed')
  // The plugin's own sentence AND what Walnut's loop saw, side by side.
  await expect(connection.getByTestId(`plugin-connection-detail-${pluginId}`)).toContainText('invalid_grant')
  await expect(connection.getByTestId(`plugin-connection-sync-${pluginId}`)).toContainText(/Sync has failed \d+ times? in a row/)
  await page.locator('#plugin-store').screenshot({ path: `${SCREENSHOT_DIR}/2-settings-sign-in-needed.png` })

  // ── 3. Sign in from the row: device code, link, copy ──
  await connection.getByTestId(`plugin-sign-in-${pluginId}`).click()
  const prompt = connection.getByTestId(`plugin-signin-prompt-${pluginId}`)
  await expect(prompt).toBeVisible({ timeout: 15_000 })
  await expect(connection).toHaveAttribute('data-connection-state', 'signing-in')
  await expect(connection.getByTestId(`plugin-signin-code-${pluginId}`)).toHaveText('FIX-2468')
  await expect(prompt.getByRole('link')).toHaveAttribute('href', 'https://example.invalid/devicelogin')
  await expect(prompt).toContainText('This panel updates by itself once you finish.')
  await expect(row.getByTestId(`plugin-row-connection-${pluginId}`)).toHaveText('signing in…')
  await page.locator('#plugin-store').screenshot({ path: `${SCREENSHOT_DIR}/3-device-code.png` })

  // ── 4. The flow completes on its own: connected, no reload ──
  await expect(connection).toHaveAttribute('data-connection-state', 'connected', { timeout: 30_000 })
  await expect(connection.getByTestId(`plugin-connection-badge-${pluginId}`)).toHaveText('signed in')
  await expect(connection).toContainText('fixture@example.com')
  await expect(connection).toContainText('renews automatically')
  await expect(prompt).toHaveCount(0)
  await expect(connection.getByTestId(`plugin-sign-in-${pluginId}`)).toHaveCount(0)
  // A healthy link is not a badge on the title line.
  await expect(row.getByTestId(`plugin-row-connection-${pluginId}`)).toHaveCount(0)
  // The next good tick clears the failure streak on the panel.
  await expect(connection.getByTestId(`plugin-connection-sync-${pluginId}`)).toHaveCount(0, { timeout: 30_000 })
  await expect(connection).toContainText('last sync')
  await page.locator('#plugin-store').screenshot({ path: `${SCREENSHOT_DIR}/4-signed-in.png` })

  // ── 5. The card retired by itself ──
  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail').getByRole('button', { name: /^Errors/ }).click()
  await dumpFrames()
  await expect(panel.locator('.notification-feed-item', { hasText: 'needs you to sign in again' })).toHaveCount(0, { timeout: 30_000 })
  await panel.locator('.nfc-rail').getByRole('button', { name: /^All/ }).click()
  const recovered = panel.locator('.notification-feed-item', { hasText: 'needs you to sign in again' })
  await expect(recovered).toHaveCount(1)
  await expect(recovered).toContainText('Recovered')
  await expect(recovered.getByTestId('nfc-producer-action')).toHaveCount(0)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/5-card-recovered.png` })
  // The card went quiet because the server SAID so over the live socket, not
  // because the page refetched: recovery is pushed, never polled.
  await dumpFrames()
  expect(wsFrames.some((f) => f.includes('"notification:updated"') && f.includes('"resolved":"recovered"'))).toBe(true)

  expect(pageErrors).toEqual([])
  expect(failedRequests).toEqual([])
})

test('the connection API tells a sign-in from an outage, and refuses sign-in where none exists', async ({ request }) => {
  const base = `http://127.0.0.1:${fixture!.port}`
  const list = await request.get(`${base}/api/integrations/connections`)
  expect(list.ok()).toBeTruthy()
  const { connections } = await list.json() as { connections: Array<{ pluginId: string; state: string; canSignIn: boolean }> }
  const mine = connections.find((c) => c.pluginId === fixture!.pluginId)
  expect(mine?.state).toBe('connected')
  expect(mine?.canSignIn).toBe(true)

  // Plugins without an account link are not in the list and 404 on the detail route.
  expect(connections.some((c) => c.pluginId === 'calendar')).toBe(false)
  expect((await request.get(`${base}/api/integrations/calendar/connection`)).status()).toBe(404)
  expect((await request.post(`${base}/api/integrations/calendar/connection/sign-in`)).status()).toBe(404)
})
