/**
 * The draft column picks the reasoning effort a new task's session starts at.
 *
 * The model pill opens the same two-pane picker a running session's pill does; on a draft
 * its Effort column leads with "Default" (no --effort: Claude Code's own settings decide),
 * ticked until a level is picked. A pick shows on the pill, rides the launch body, and the
 * spawned session runs at it (the mock CLI echoes the --effort it received, and the session
 * record keeps it).
 *
 * Pinned here:
 *   1. a draft offers Default + every level, Default ticked; no effort on the pill
 *   2. each level picked shows on the pill and is ticked on reopen; Default clears it
 *   3. the launch names the level and the running session's pill shows it
 *   4. an untouched draft sends no effort key
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  REAL_PANEL, captureDraftRequests, discoverFixtureRoot, draftComposer, draftPanels, draftQuickChipFor,
  draftSend, loadHome, nthRequest, openDraft,
} from './draft-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-effort-pick'
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

const modelPill = (panel: Locator): Locator => panel.locator('.draft-actions-bar .draft-model-select')
const picker = (page: Page): Locator => page.locator('.model-picker')
const effortCol = (page: Page): Locator => picker(page).locator('.model-picker-col-effort')
const effortRow = (page: Page, id: string): Locator => effortCol(page).locator(`[data-effort="${id}"]`)

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

async function openPicker(page: Page, panel: Locator): Promise<void> {
  await modelPill(panel).click()
  await expect(effortCol(page)).toBeVisible()
}

test('1+2. Default first and ticked; each level shows on the pill; Default clears it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)
  await draftQuickChipFor(panel, `${fixtureRoot}/projects/wallets`).click()

  await openPicker(page, panel)
  await expect(effortCol(page).locator('.model-picker-row')).toHaveCount(1 + LEVELS.length)
  await expect(effortRow(page, 'default')).toHaveAttribute('aria-selected', 'true')
  for (const level of LEVELS) await expect(effortRow(page, level)).toHaveAttribute('aria-selected', 'false')
  await picker(page).screenshot({ path: `${SHOTS}/1-default.png` })
  await page.keyboard.press('Escape')
  await expect(modelPill(panel)).toHaveAttribute('data-effort', '')
  await expect(modelPill(panel).locator('.session-detail-effort-badge')).toHaveCount(0)

  // The fixture has no host catalog, so Auto's levels are unknown (X-High and Max greyed); a real
  // host's catalog names the model Auto starts. Opus takes every level.
  await openPicker(page, panel)
  await picker(page).locator('.model-picker-row', { hasText: /^Opus$/ }).click()
  await expect(modelPill(panel)).toHaveAttribute('data-model', 'opus')

  const labels: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }
  for (const level of LEVELS) {
    await openPicker(page, panel)
    await effortRow(page, level).click()
    await expect(picker(page)).toHaveCount(0)
    await expect(modelPill(panel)).toHaveAttribute('data-effort', level)
    await expect(modelPill(panel).locator('.session-detail-effort-badge')).toContainText(labels[level])
    await openPicker(page, panel)
    await expect(effortRow(page, level)).toHaveAttribute('aria-selected', 'true')
    await expect(effortRow(page, 'default')).toHaveAttribute('aria-selected', 'false')
    await page.keyboard.press('Escape')
  }
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/2-max-on-pill.png` })

  await openPicker(page, panel)
  await effortRow(page, 'default').click()
  await expect(modelPill(panel)).toHaveAttribute('data-effort', '')
  await expect(modelPill(panel).locator('.session-detail-effort-badge')).toHaveCount(0)
})

test('2b. on Auto, the levels are those of the model Auto starts (the host catalog\'s default row)', async ({ page }) => {
  // The fixture has no live catalog: serve one whose Auto row resolves to a model with every level.
  await page.route((url) => url.pathname === '/api/sessions/host-model-catalogs', async (route) => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    await route.fulfill({ json: { catalogs: { __local__: { fetchedAt: new Date().toISOString(), models: [
      { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: levels },
      { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, supportedEffortLevels: levels },
    ] } } } })
  })
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const panel = await openDraft(page)
  await draftQuickChipFor(panel, `${fixtureRoot}/projects/wallets`).click()
  await openPicker(page, panel)
  await expect(effortRow(page, 'xhigh')).toBeEnabled()
  await expect(effortRow(page, 'max')).toBeEnabled()
  await effortRow(page, 'max').click()
  await expect(modelPill(panel)).toHaveAttribute('data-effort', 'max')
})

test('3. the launch names the picked level and the session runs at it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const log = await captureDraftRequests(page)
  const panel = await openDraft(page)
  await draftQuickChipFor(panel, `${fixtureRoot}/projects/wallets`).click()
  await openPicker(page, panel)
  await effortRow(page, 'low').click()
  await expect(modelPill(panel)).toHaveAttribute('data-effort', 'low')

  await draftComposer(page).fill(`start at low effort ${Date.now()}`)
  await draftSend(panel).click()
  const body = await nthRequest(log, 'quickStart') as { effort?: string; sessionId?: string }
  expect(body.effort).toBe('low')
  expect(body.sessionId).toBeTruthy()
  await expect(draftPanels(page)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${body.sessionId}`)
    if (res.status() !== 200) return undefined
    const s = ((await res.json()) as { session?: { effort?: string; effectiveEffort?: string } }).session
    return s?.effectiveEffort ?? s?.effort
  }, { timeout: 30_000, message: 'the started session never reported its effort' }).toBe('low')
  const live = page.locator(`${REAL_PANEL}[data-session-id="${body.sessionId}"]`)
  await expect(live).toBeVisible({ timeout: 30_000 })
  await expect(live.locator('.session-detail-effort-badge').first()).toContainText('Low', { timeout: 30_000 })
  await live.locator('.session-panel-input').screenshot({ path: `${SHOTS}/3-live-session-low.png` })
})

test('4. an untouched draft sends no effort key', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await loadHome(page)
  const log = await captureDraftRequests(page, { blockQuickStart: true })
  const panel = await openDraft(page)
  await draftQuickChipFor(panel, `${fixtureRoot}/projects/wallets`).click()
  await draftComposer(page).fill(`start at the default effort ${Date.now()}`)
  await draftSend(panel).click()
  const body = await nthRequest(log, 'quickStart')
  expect(body).not.toHaveProperty('effort')
})
