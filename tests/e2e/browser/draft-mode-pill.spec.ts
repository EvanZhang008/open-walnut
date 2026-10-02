/**
 * The draft composer shows the permission mode the session will START in.
 *
 * Before 2026-10-01 a New task column showed the model and nothing about the
 * mode: every launch silently spawned in the launch default (Bypass), and the
 * first place the user could see or change that was the running session's pill.
 * The draft now draws the SAME `.mode-toggle-pill` a running session draws, first
 * in the composer's controls row, reading the launch default until a pick; a
 * click or Shift+Tab steps through the enabled cycle; the launch carries the pick.
 *
 * Pinned here:
 *   1. default reads Bypass; it sits first in the row, the model select right after
 *   2. click and Shift+Tab cycle Plan → Auto → Bypass (Plan in its amber state)
 *   3. a folder pick keeps the mode AND still applies the folder's remembered
 *      model (a mode pick never switches the launch memory off)
 *   4. the launch body names the picked mode, and the spawned session runs in it
 *      (the mock CLI echoes `--permission-mode` back in its init event)
 *   5. an untouched pill sends NO mode key (the payload is byte-identical to before)
 *   6. the Ask Walnut tab keeps the pill and its launch carries the mode
 *   7. a fork draft draws no pill (the fork route takes no mode; the sibling inherits)
 *   8. the cycle follows Settings › Sessions › Enabled Session Modes
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  REAL_PANEL, captureDraftRequests, discoverFixtureRoot, draftComposer, draftPanel, draftPanels, draftQuickChipFor,
  draftSend, loadHome, nthRequest, openDraft, pickDraftFolder, rememberModelFor, seedColumns,
} from './draft-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-mode-pill'

test.setTimeout(180_000)
// Serial: two scenarios spawn real (mock) CLIs against the shared fixture store.
test.describe.configure({ mode: 'serial' })

const modePill = (panel: Locator): Locator => panel.locator('.draft-actions-bar .draft-mode-pill')
const modeLabel = (panel: Locator): Locator => modePill(panel).locator('.mode-toggle-pill-label')
const modelPill = (panel: Locator): Locator => panel.locator('.draft-actions-bar .draft-model-select')
const askWalnutCard = (page: Page): Locator => page.locator('.draft-intent-card-walnut')

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

/** `session.enabled_modes` as the client reads it from GET /api/config. */
async function enableModes(page: Page, modes: string[]): Promise<void> {
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue().catch(() => {})
    const res = await route.fetch().catch(() => null)
    if (!res) return
    const body = (await res.json().catch(() => ({}))) as { config?: { session?: Record<string, unknown> } }
    const config = body.config ?? (body.config = {})
    config.session = { ...config.session, enabled_modes: modes }
    await route.fulfill({ response: res, json: body }).catch(() => {})
  })
}

test('1+2. the pill reads the launch default first in the row, and click / Shift+Tab cycle it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)

  // 1. The default, in the words the running session's pill uses.
  await expect(modePill(panel)).toBeVisible()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'bypass')
  await expect(modeLabel(panel)).toHaveText('Bypass')
  await expect(modePill(panel)).not.toHaveClass(/plan-active/)
  // The row reads like a running session's: mode, then model, both before the arrow.
  const [mode, model, send, row] = await Promise.all([
    modePill(panel).boundingBox(), modelPill(panel).boundingBox(),
    draftSend(panel).boundingBox(), panel.locator('.draft-actions-bar').boundingBox(),
  ])
  if (!mode || !model || !send || !row) throw new Error('the composer controls row did not render')
  expect(Math.abs(mode.x - row.x), 'the mode pill is first in the controls row').toBeLessThan(6)
  expect(model.x, 'the model select follows the mode pill').toBeGreaterThan(mode.x + mode.width - 1)
  expect(Math.abs(model.y - mode.y), 'mode and model share one line in a wide column').toBeLessThan(4)
  expect(model.x, 'both sit before the send arrow').toBeLessThan(send.x)
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/1-default-bypass.png` })

  // 2. Click: Plan (amber) → Auto → Bypass, the default cycle.
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'plan')
  await expect(modeLabel(panel)).toHaveText('Plan')
  await expect(modePill(panel)).toHaveClass(/plan-active/)
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/2-plan.png` })
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'auto')
  await expect(modeLabel(panel)).toHaveText('Auto')
  await expect(modePill(panel)).not.toHaveClass(/plan-active/)
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'bypass')

  // Shift+Tab from the composer, the running session's shortcut, and the caret stays.
  const composer = draftComposer(page)
  await composer.click()
  await composer.press('Shift+Tab')
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'plan')
  await expect(composer).toBeFocused()
  await composer.press('Shift+Tab')
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'auto')
})

test('3+4. a folder pick keeps the mode and its remembered model, and the launch spawns in that mode', async ({ page }) => {
  const cwd = `${fixtureRoot}/projects/wallets`
  await rememberModelFor(page, { [cwd]: 'sonnet' })
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const log = await captureDraftRequests(page)
  const panel = await openDraft(page)

  // Pick the mode FIRST, then the folder: the pick must not have switched the
  // folder's launch memory off (that latch is model/engine only).
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'plan')
  await draftQuickChipFor(panel, cwd).click()
  await expect(modelPill(panel)).toHaveAttribute('data-model', 'sonnet')
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'plan')
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/3-plan-with-remembered-model.png` })

  // The launch names the mode, and the spawned session reports it back.
  await draftComposer(page).fill(`start in plan mode ${Date.now()}`)
  await draftSend(panel).click()
  const body = await nthRequest(log, 'quickStart') as { mode?: string; model?: string; sessionId?: string }
  expect(body.mode).toBe('plan')
  expect(body.model).toBe('sonnet')
  expect(body.sessionId).toBeTruthy()
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${body.sessionId}`)
    if (res.status() !== 200) return undefined
    return ((await res.json()) as { session?: { mode?: string } }).session?.mode
  }, { timeout: 30_000, message: 'the started session never reported plan mode' }).toBe('plan')
  // The running session's own pill says the same, where the draft's pill was.
  const live = page.locator(`${REAL_PANEL}[data-session-id="${body.sessionId}"]`)
  await expect(live).toBeVisible({ timeout: 30_000 })
  await expect(live.locator('[data-control-id="mode"] .mode-toggle-pill-label')).toHaveText('Plan', { timeout: 30_000 })
  await live.locator('.session-panel-input').screenshot({ path: `${SHOTS}/4-live-session-plan.png` })
})

test('5. an untouched pill sends no mode key, and the session runs in the default', async ({ page }) => {
  const cwd = `${fixtureRoot}/projects/wallets`
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const log = await captureDraftRequests(page)
  const panel = await openDraft(page)
  await draftQuickChipFor(panel, cwd).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'bypass')
  await draftComposer(page).fill(`start in the default mode ${Date.now()}`)
  await draftSend(panel).click()
  const body = await nthRequest(log, 'quickStart') as { mode?: string; sessionId?: string }
  expect(body).not.toHaveProperty('mode')
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${body.sessionId}`)
    if (res.status() !== 200) return undefined
    return ((await res.json()) as { session?: { mode?: string } }).session?.mode
  }, { timeout: 30_000, message: 'the started session never reported its mode' }).toBe('bypass')
})

test('6. the Ask Walnut tab keeps the pill, and its launch carries the mode', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraft(page)
  await askWalnutCard(page).click()
  await expect(askWalnutCard(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(modePill(panel)).toBeVisible()
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'plan')
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/6-ask-walnut-plan.png` })
  await draftComposer(page).fill(`ask in plan mode ${Date.now()}`)
  await draftSend(panel).click()
  const body = await nthRequest(log, 'quickStart') as { mode?: string; walnutAgent?: boolean }
  expect(body.walnutAgent).toBe(true)
  expect(body.mode).toBe('plan')
})

test('7. a fork draft draws no mode pill: the sibling inherits the source session’s mode', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  // A stopped fixture session WITH a cwd: the Fork chip is disabled without one.
  await seedColumns(page, ['pw-vscode-session'])
  await loadHome(page)
  const source = page.locator(`${REAL_PANEL}[data-session-id="pw-vscode-session"]`)
  await expect(source).toBeVisible({ timeout: 25_000 })
  // The running session's own pill is there; the fork draft must not pretend to have one.
  await expect(source.locator('[data-control-id="mode"] .mode-toggle-pill')).toBeVisible({ timeout: 15_000 })
  await source.getByRole('button', { name: 'Fork session into a child task' }).click()
  const fork = draftPanel(page)
  await expect(fork).toBeVisible({ timeout: 10_000 })
  await expect(fork.locator('.draft-bound-task')).toContainText('fork of:')
  await expect(modelPill(fork)).toBeVisible()
  await expect(modePill(fork)).toHaveCount(0)
})

test('7b. an engine whose modes are its own config options (Codex, ACP) draws no pill', async ({ page }) => {
  const cwd = `${fixtureRoot}/projects/wallets`
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)
  await expect(modePill(panel)).toBeVisible()
  // The folder picker's footer switches the engine; the pill follows the engine
  // that will actually spawn, the same rule the model pill reads.
  await pickDraftFolder(page, panel, cwd, { engine: 'Codex' })
  await expect(modePill(panel)).toHaveCount(0)
  await expect(modelPill(panel)).toBeVisible()
})

test('8. the cycle follows the enabled modes from Settings', async ({ page }) => {
  await enableModes(page, ['plan', 'bypass'])
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'bypass')
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'plan')
  // Auto is off the cycle here: Plan goes straight back to Bypass.
  await modePill(panel).click()
  await expect(modePill(panel)).toHaveAttribute('data-mode', 'bypass')
})
