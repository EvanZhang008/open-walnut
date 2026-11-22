/**
 * Settings > Sessions "Default model" and "Default effort" (Walnut's own defaults of Claude Code
 * sessions, src/core/sessions/claude-launch-defaults.ts), walked as a person does:
 *
 *   1. both read "Not set" (Claude Code decides) on a fresh install
 *   2. picking High and Sonnet saves them to config
 *   3. a new task's draft shows them: the model pill reads "Default (Sonnet …)" and the effort
 *      picker's Default row reads "Default · High"
 *   4. launching it sends no effort of its own; the session runs at High and its pill says so
 *   5. Not set again clears both
 *
 * PROOF_VIDEO_DIR=<dir> records a sharp walk-through (proof-video.ts: screencast, pointer, captions).
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  REAL_PANEL, captureDraftRequests, discoverFixtureRoot, draftComposer, draftPanels, draftQuickChipFor,
  draftSend, loadHome, nthRequest, openDraft,
} from './draft-helpers'
import { startProofVideo, type ProofVideo } from './proof-video'

const SHOTS = process.env.LAUNCH_DEFAULTS_SHOT_DIR ?? '/tmp/launch-defaults-settings'

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: process.env.PROOF_VIDEO_DIR ? 2 : 1 })

let video: ProofVideo
const pause = () => video.hold()
const modelPill = (panel: Locator): Locator => panel.locator('.draft-actions-bar .draft-model-select')
const effortCol = (page: Page): Locator => page.locator('.model-picker .model-picker-col-effort')

async function configDefaults(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/config')
  return ((await res.json())?.config?.launch_defaults ?? {}) as Record<string, unknown>
}

async function openSessionsSettings(page: Page): Promise<void> {
  await page.locator('.sidebar a[href^="/settings"]').first().click()
  await page.getByTestId('settings-nav-sessions').click()
  await expect(page.locator('#sessions.settings-section')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('default-claude-effort-row').scrollIntoViewIfNeeded()
}

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

test('the default model and effort are set in Settings, shown on a new task and run by it', async ({ page }) => {
  video = await startProofVideo(page)
  await loadHome(page)
  await video.caption('Settings > Sessions: Default model and Default effort')
  await openSessionsSettings(page)

  // 1. A fresh install: nothing set, Claude Code decides.
  const effort = page.getByTestId('default-claude-effort')
  const model = page.getByTestId('default-claude-model')
  await expect(effort).toHaveValue('')
  await expect(effort.locator('option:checked')).toHaveText('Not set (Claude Code decides)')
  await expect(model).toHaveValue('')
  await expect(model.locator('option:checked')).toHaveText(/^Not set \(Claude Code decides/)
  await video.caption('Both start Not set: Walnut passes nothing, Claude Code decides')
  await pause()
  await page.screenshot({ path: `${SHOTS}/1-not-set.png` })

  // 2. Pick High and Sonnet: both land in config.
  await video.caption('Pick Default effort: High')
  await effort.click()
  await effort.selectOption('high')
  await expect.poll(async () => (await configDefaults(page)).effort, { timeout: 30_000 }).toBe('high')
  await pause()
  await video.caption('Pick Default model: Sonnet')
  await model.click()
  await model.selectOption('sonnet')
  await expect.poll(async () => (await configDefaults(page)).model, { timeout: 30_000 }).toBe('sonnet')
  // The second pick keeps the first one in config, not only in the row.
  expect((await configDefaults(page)).effort).toBe('high')
  await expect(effort).toHaveValue('high')
  await video.caption('Both saved to config')
  await pause()
  await page.screenshot({ path: `${SHOTS}/2-high-sonnet.png` })

  // 3. A new task's draft shows them.
  await video.caption('A new task: its draft shows the defaults')
  await page.locator('.sidebar a[href="/"]').first().click()
  const log = await captureDraftRequests(page)
  const panel = await openDraft(page)
  await draftQuickChipFor(panel, `${fixtureRoot}/projects/wallets`).click()
  await expect(modelPill(panel)).toContainText(/Default \(Sonnet/)
  await pause()
  await video.caption('The picker: no pick = Default (Sonnet), effort Default · High')
  await modelPill(panel).click()
  await expect(effortCol(page)).toBeVisible()
  const defaultRow = effortCol(page).locator('[data-effort="default"]')
  await expect(defaultRow).toHaveAttribute('aria-selected', 'true')
  await expect(defaultRow.getByTestId('effort-default-level')).toHaveText('· High')
  // The model column's no-pick row names the default model too, as the pill does.
  const noPick = page.locator('.model-picker').getByTestId('picker-auto-row')
  await expect(noPick).toHaveText(/^Default \(Sonnet/)
  await expect(noPick).toHaveAttribute('aria-selected', 'true')
  await pause()
  await page.locator('.model-picker').screenshot({ path: `${SHOTS}/3-draft-default-high.png` })
  await page.keyboard.press('Escape')

  // 4. The launch names no effort of its own; the session runs at High.
  await video.caption('Send it without picking an effort')
  await draftComposer(page).click()
  await draftComposer(page).pressSequentially(`starts at the default effort ${Date.now()}`, { delay: 15 })
  await pause()
  await draftSend(panel).click()
  const body = await nthRequest(log, 'quickStart') as { effort?: string; model?: string; sessionId?: string }
  expect(body).not.toHaveProperty('effort')
  expect(body.sessionId).toBeTruthy()
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${body.sessionId}`)
    if (res.status() !== 200) return undefined
    return ((await res.json()) as { session?: { effort?: string } }).session?.effort
  }, { timeout: 30_000, message: 'the started session never recorded its effort' }).toBe('high')
  const live = page.locator(`${REAL_PANEL}[data-session-id="${body.sessionId}"]`)
  await expect(live).toBeVisible({ timeout: 30_000 })
  await expect(live.locator('.session-detail-effort-badge').first()).toContainText('High', { timeout: 30_000 })
  // The caption sits above the composer here, so the model pill's "· High" stays in sight.
  await page.evaluate(() => { const c = document.getElementById('proof-caption'); if (c) c.style.bottom = '180px' })
  await video.caption('The session runs at High, the same effort the settings page shows')
  await live.locator('.session-panel-input .session-detail-effort-badge').first().hover()
  await pause()
  await live.locator('.session-panel-input').screenshot({ path: `${SHOTS}/4-live-session-high.png` })

  // 5. Not set again clears both: Claude Code decides once more.
  await page.evaluate(() => { const c = document.getElementById('proof-caption'); if (c) c.style.bottom = '' })
  await video.caption('Not set again: Claude Code decides once more')
  await openSessionsSettings(page)
  await page.getByTestId('default-claude-effort').click()
  await page.getByTestId('default-claude-effort').selectOption('')
  await expect.poll(async () => (await configDefaults(page)).effort ?? null, { timeout: 30_000 }).toBeNull()
  await page.getByTestId('default-claude-model').click()
  await page.getByTestId('default-claude-model').selectOption('')
  await expect.poll(async () => (await configDefaults(page)).model ?? null, { timeout: 30_000 }).toBeNull()
  await expect(page.getByTestId('default-claude-effort')).toHaveValue('')
  await pause()
  await video.stop('launch-defaults-settings')
})
