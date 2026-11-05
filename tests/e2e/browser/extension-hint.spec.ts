/**
 * The master password hint in the extension (packages/browser-extension/src/popup.ts): the
 * locked popup, its unlock window and the side panel's Passwords tab show "Show hint" once the
 * vault has a hint, and the hint at once after a wrong password. The hint is set and removed
 * through Walnut's API; the shared fixture vault keeps the other specs' master password.
 */
import path from 'node:path'
import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { openPanel, startPanelLab, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const HINT = 'the stable by the river'
const SHOTS = process.env.HINT_SHOTS_DIR

let lab: PanelLab

async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await p.waitForTimeout(200)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** A vault session from Walnut itself (set up the vault when nothing did yet). */
async function webSession(p: Page): Promise<string> {
  const st = await (await p.request.get(`${lab.base}/api/v1/vault/status`)).json()
  const r = st.setUp
    ? await p.request.post(`${lab.base}/api/v1/vault/unlock`, { data: { password: MASTER, kdfSalt: st.kdf?.salt } })
    : await p.request.post(`${lab.base}/api/v1/vault/setup`, { data: { password: MASTER } })
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).session.token
}

async function setHint(hint: string): Promise<void> {
  const p = await lab.ctx.newPage()
  const s = await webSession(p)
  const r = await p.request.put(`${lab.base}/api/v1/vault/hint`, { headers: { 'x-walnut-vault-session': s }, data: { hint, ...(hint ? { password: MASTER } : {}) } })
  expect(r.ok(), await r.text()).toBe(true)
  await p.request.post(`${lab.base}/api/v1/vault/lock`, { headers: { 'x-walnut-vault-session': s }, data: {} })
  await p.close()
}

async function popup(query = ''): Promise<Page> {
  const p = await lab.ctx.newPage()
  await p.setViewportSize({ width: 360, height: 520 })
  await p.goto(`chrome-extension://${lab.extId}/popup.html${query}`)
  return p
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'hint')
  await setHint(HINT)
})
test.afterAll(async () => {
  if (lab) await setHint('').catch(() => undefined)
  await lab?.close()
})

test('the locked popup shows the hint behind a link, and at once after a wrong password', async () => {
  const p = await popup()
  await expect(p.getByRole('heading', { name: 'Walnut is locked' })).toBeVisible({ timeout: 20_000 })
  await expect(p.getByTestId('popup-hint-shown')).toHaveCount(0)
  await shot(p, 'ext-popup-locked-link')
  await p.getByTestId('popup-show-hint').click()
  await expect(p.getByTestId('popup-hint-shown')).toHaveText(`Hint: ${HINT}`)
  await shot(p, 'ext-popup-hint-shown')
  await p.close()

  const again = await popup()
  await expect(again.getByTestId('popup-show-hint')).toBeVisible({ timeout: 20_000 })
  await again.getByLabel('Master password').fill('not my password')
  await again.getByTestId('popup-unlock').click()
  await expect(again.getByTestId('popup-hint-shown')).toHaveText(`Hint: ${HINT}`, { timeout: 30_000 })
  await shot(again, 'ext-popup-wrong-password')
  await again.close()
})

test('the unlock window and the side panel\'s Passwords tab show it too', async () => {
  const win = await popup('?window=1')
  await expect(win.getByTestId('popup-show-hint')).toBeVisible({ timeout: 20_000 })
  await win.close()

  const { panel } = await openPanel(lab, 'passwords')
  await panel.setViewportSize({ width: 400, height: 640 })
  const view = panel.frameLocator('iframe.panel-frame-passwords')
  await view.getByTestId('popup-show-hint').click({ timeout: 20_000 })
  await expect(view.getByTestId('popup-hint-shown')).toHaveText(`Hint: ${HINT}`)
  await shot(panel, 'ext-sidepanel-hint-shown')
  await panel.close()
})

test('with no hint, the locked popup has no link', async () => {
  await setHint('')
  const p = await popup()
  await expect(p.getByRole('heading', { name: 'Walnut is locked' })).toBeVisible({ timeout: 20_000 })
  await expect(p.getByTestId('popup-show-hint')).toHaveCount(0)
  await p.close()
})
