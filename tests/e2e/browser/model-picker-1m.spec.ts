/**
 * Playwright browser test: ModelPicker catalog-driven rendering.
 *
 * The picker's rows come from GET /api/sessions/:id/models — the session's TRUE
 * selectable catalog (CLI initialize response), falling back to the static
 * SESSION_MODELS registry when the CLI can't answer.
 *
 * Two regimes are covered:
 *  1. FALLBACK (real test server, mock CLI can't answer initialize):
 *     the 7 legacy alias rows render, Switch sends the alias id.
 *  2. CLI catalog (route intercepted with a fixed catalog): rows render from
 *     displayName, disabled rows are greyed with no Switch, the active row is
 *     matched via resolvedModel, an out-of-catalog live model yields a
 *     synthetic non-clickable "Active" row, and Switch POSTs the row's VALUE
 *     (full provider ID) — the load-bearing contract of the whole feature.
 *
 * Requires seed data in test-server.ts:
 *  - Task: pw-task-model-switch (in_progress, with session)
 *  - Session: pw-model-switch-session (seeded as running, reconciled to stopped)
 */
import { test, expect } from '@playwright/test'
import path from 'node:path'

const SCREENSHOT_DIR = '/tmp/test-and-verify'
const SESSION_ID = 'pw-model-switch-session'

/** A CLI-shaped catalog (2.1.199 initialize response, trimmed) used by the
 *  interception tests: one default row, one enabled row, one disabled row. */
const CLI_CATALOG = {
  source: 'cli',
  live: true,
  fetchedAt: new Date(0).toISOString(),
  models: [
    { value: 'default', resolvedModel: 'global.anthropic.claude-fable-5', displayName: 'Default' },
    {
      value: 'global.anthropic.claude-fable-5',
      resolvedModel: 'global.anthropic.claude-fable-5',
      displayName: 'Fable', description: 'Fast & capable',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'global.anthropic.claude-opus-4-8[1m]',
      resolvedModel: 'global.anthropic.claude-opus-4-8[1m]',
      displayName: 'Opus (1M context)', description: 'Restricted example',
      disabled: true,
    },
  ],
}

async function openSessionPanel(page: import('@playwright/test').Page) {
  // Category tabs moved into the View dropdown; the persisted tab defaults to ★
  // (starred), which hides the seeded task. Preset it to '' (All) up front.
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut-todo-active-tab', '') } catch { /* ignore */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Plain click on a task row with a session opens the SessionPanel inline.
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Model switch test task' }).first()
  await expect(taskItem).toBeVisible({ timeout: 5000 })
  await taskItem.click()
  await page.waitForTimeout(500)

  const sessionPanelInput = page.locator('.session-panel .chat-input-textarea')
  await expect(sessionPanelInput).toBeVisible({ timeout: 5000 })

  return sessionPanelInput
}

async function openModelPicker(page: import('@playwright/test').Page, input: import('@playwright/test').Locator) {
  await input.focus()
  await input.fill('/m')
  await page.waitForTimeout(300)

  const palette = page.locator('.session-panel .command-palette')
  await expect(palette).toBeVisible({ timeout: 3000 })

  const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
  await expect(modelItem).toBeVisible({ timeout: 3000 })
  await modelItem.dispatchEvent('mousedown')
  await page.waitForTimeout(300)

  const modelPicker = page.locator('.session-panel .model-picker')
  await expect(modelPicker).toBeVisible({ timeout: 3000 })

  return modelPicker
}

/** Intercept the catalog route with a fixed CLI-shaped catalog. */
async function interceptCatalog(page: import('@playwright/test').Page, body: unknown) {
  await page.route(`**/api/sessions/${SESSION_ID}/models*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }))
}

/** Intercept the live-settings pull so the "live" model is deterministic. */
async function interceptLiveSettings(
  page: import('@playwright/test').Page,
  appliedModel: string | null,
  appliedEffort: string | null = null,
  configuredEffort: string | null = null,
) {
  await page.route(`**/api/sessions/${SESSION_ID}/settings*`, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        live: appliedModel !== null,
        requested: { model: appliedModel ?? undefined },
        applied: appliedModel !== null ? { model: appliedModel, effort: appliedEffort, mode: null } : null,
        effective: configuredEffort !== null ? { effortLevel: configuredEffort } : null,
      }),
    }))
}

// ── Regime 1: FALLBACK (no interception — real server, CLI can't answer) ──

test.describe('ModelPicker fallback registry', () => {
  test('renders all 7 legacy rows including 1M variants', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const options = picker.locator('.model-picker-option')
    await expect(options).toHaveCount(7)

    const names = picker.locator('.model-picker-option-name')
    await expect(names.nth(0)).toHaveText('Opus')
    await expect(names.nth(1)).toHaveText('Opus 1M')
    await expect(names.nth(2)).toHaveText('Sonnet')
    await expect(names.nth(3)).toHaveText('Sonnet 1M')
    await expect(names.nth(4)).toHaveText('Haiku')
    await expect(names.nth(5)).toHaveText('Fable')
    await expect(names.nth(6)).toHaveText('Fable 1M')

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-fallback-7-options.png') })
  })

  test('Switch in fallback mode sends the legacy alias id', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/sessions/${SESSION_ID}/model`) && r.method() === 'POST'),
      picker.locator('.model-picker-option').filter({ hasText: 'Fastest' })
        .locator('.model-picker-btn').click(),
    ])
    expect(req.postDataJSON()).toEqual({ model: 'haiku' })

    await expect(picker).toBeHidden({ timeout: 3000 })
  })

  test('Escape key closes the ModelPicker', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden({ timeout: 3000 })
  })
})

// ── Regime 2: CLI catalog (route intercepted) ──

test.describe('ModelPicker CLI catalog', () => {
  test('renders catalog rows; disabled row greyed with no Switch; active via resolvedModel', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    // Live model = fable full ID → matches the SPECIFIC Fable row (not 'default',
    // which shares the same resolvedModel — tier-2 beats tier-3).
    await interceptLiveSettings(page, 'global.anthropic.claude-fable-5')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const options = picker.locator('.model-picker-option')
    await expect(options).toHaveCount(3)

    const names = picker.locator('.model-picker-option-name')
    await expect(names.nth(0)).toHaveText('Default')
    await expect(names.nth(1)).toHaveText('Fable')
    await expect(names.nth(2)).toHaveText('Opus (1M context)')

    // Active row = Fable (resolvedModel match on the non-default row).
    const active = picker.locator('.model-picker-option-active')
    await expect(active).toHaveCount(1)
    await expect(active.locator('.model-picker-option-name')).toHaveText('Fable')
    await expect(active.locator('.model-picker-option-badge')).toHaveText('Active')

    // Disabled row: greyed, badge "Restricted", no Switch button.
    const disabled = picker.locator('.model-picker-option-disabled')
    await expect(disabled).toHaveCount(1)
    await expect(disabled.locator('.model-picker-option-name')).toHaveText('Opus (1M context)')
    await expect(disabled.locator('.model-picker-btn')).toHaveCount(0)
    await expect(disabled.locator('.model-picker-option-badge-disabled')).toHaveText('Restricted')

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-cli-catalog.png') })
  })

  test('Switch sends the catalog row VALUE (full provider ID) verbatim', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    // Live = opus[1m] (the disabled row) so Fable is switchable.
    await interceptLiveSettings(page, 'global.anthropic.claude-opus-4-8[1m]')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const fableRow = picker.locator('.model-picker-option').filter({ hasText: 'Fast & capable' })
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/sessions/${SESSION_ID}/model`) && r.method() === 'POST'),
      fableRow.locator('.model-picker-btn').click(),
    ])
    // THE load-bearing assertion: the body carries the value, never an alias.
    expect(req.postDataJSON()).toEqual({ model: 'global.anthropic.claude-fable-5' })
  })

  test('out-of-catalog live model renders a synthetic non-clickable Active row', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    // Live model that NO catalog row claims (e.g. org tightened the allowlist
    // mid-session): the picker must show it truthfully with no row selected.
    await interceptLiveSettings(page, 'us.anthropic.claude-sonnet-4-6[1m]')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const synthetic = picker.locator('[data-testid="picker-out-of-catalog"]')
    await expect(synthetic).toBeVisible()
    await expect(synthetic.locator('.model-picker-option-desc'))
      .toContainText('not in this session\'s selectable catalog')
    await expect(synthetic.locator('.model-picker-btn')).toHaveCount(0)

    // No CATALOG row is active — the synthetic row is the only active-styled one.
    const actives = picker.locator('.model-picker-option-active')
    await expect(actives).toHaveCount(1)

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-out-of-catalog.png') })
  })

  test('effort buttons follow the active row supportedEffortLevels', async ({ page }) => {
    // Catalog whose active row lacks xhigh/max — those two segments must disable.
    const catalog = JSON.parse(JSON.stringify(CLI_CATALOG)) as typeof CLI_CATALOG
    catalog.models[1] = {
      ...catalog.models[1],
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
    }
    await interceptCatalog(page, catalog)
    await interceptLiveSettings(page, 'global.anthropic.claude-fable-5')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const segs = picker.locator('.model-picker-effort-seg')
    await expect(segs).toHaveCount(5)
    await expect(segs.nth(0)).toBeEnabled()   // low
    await expect(segs.nth(1)).toBeEnabled()   // medium
    await expect(segs.nth(2)).toBeEnabled()   // high
    await expect(segs.nth(3)).toBeDisabled()  // xhigh — not in supportedEffortLevels
    await expect(segs.nth(4)).toBeDisabled()  // max   — not in supportedEffortLevels
  })

  test('GPT live capabilities enable all effort levels and use configured xhigh', async ({ page }) => {
    const gptCatalog = {
      source: 'cli',
      live: true,
      fetchedAt: new Date(0).toISOString(),
      models: [{
        value: 'gpt-5.6-sol',
        resolvedModel: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        description: 'OpenAI GPT-5.6 Sol via Bedrock Mantle',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      }],
    }
    await interceptCatalog(page, gptCatalog)
    await interceptLiveSettings(page, 'gpt-5.6-sol', null, 'xhigh')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    await expect(picker.locator('.model-picker-current')).toContainText('Current: GPT-5.6 Sol')
    await expect(picker.locator('[data-testid="picker-live-strip"]')).toContainText('effort default (xhigh)')
    const segs = picker.locator('.model-picker-effort-seg')
    await expect(segs).toHaveCount(5)
    for (const seg of await segs.all()) await expect(seg).toBeEnabled()
    await expect(segs.nth(3)).toHaveClass(/model-picker-effort-seg-active/)

    await page.screenshot({ path: '/tmp/walnut-effort/gpt-live-xhigh.png', fullPage: true })

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/sessions/${SESSION_ID}/effort`) && r.method() === 'POST'),
      segs.nth(0).click(),
    ])
    expect(req.postDataJSON()).toEqual({ effort: 'low' })
  })

  test('custom model input sends an out-of-catalog ID verbatim (terminal /model parity)', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    await interceptLiveSettings(page, 'global.anthropic.claude-fable-5')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const custom = picker.locator('[data-testid="picker-custom-model"]')
    await expect(custom).toBeVisible()
    const customInput = custom.locator('.model-picker-custom-input')
    const customBtn = custom.locator('.model-picker-btn')

    // Garbage (quotes/space) → shape check fails → button disabled.
    await customInput.fill('bad "model"')
    await expect(customBtn).toBeDisabled()

    // A valid provider-ID-shaped string NOT in the catalog (the fable-1m
    // Bedrock registry gap) → enabled → POSTs verbatim.
    await customInput.fill('global.anthropic.claude-fable-5[1m]')
    await expect(customBtn).toBeEnabled()
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/sessions/${SESSION_ID}/model`) && r.method() === 'POST'),
      customBtn.click(),
    ])
    expect(req.postDataJSON()).toEqual({ model: 'global.anthropic.claude-fable-5[1m]' })

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-custom-input.png') })
  })

  test('header Current label uses the active row displayName', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    await interceptLiveSettings(page, 'global.anthropic.claude-fable-5')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const currentLabel = picker.locator('.model-picker-current')
    await expect(currentLabel).toContainText('Current: Fable')

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-header-current.png') })
  })
})
