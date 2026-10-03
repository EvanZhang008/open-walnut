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
import { presetPanelView } from './todo-panel-helpers'
import { REAL_PANEL } from './draft-helpers'

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

const STRENGTH_CATALOG = {
  source: 'cli',
  live: true,
  fetchedAt: new Date(0).toISOString(),
  models: [
    {
      value: 'global.anthropic.claude-opus-5[1m]',
      resolvedModel: 'global.anthropic.claude-opus-5[1m]',
      displayName: 'Opus',
    },
    {
      value: 'default',
      resolvedModel: 'global.anthropic.claude-opus-5[1m]',
      displayName: 'Default',
    },
    {
      value: 'global.anthropic.claude-fable-5[1m]',
      resolvedModel: 'global.anthropic.claude-fable-5[1m]',
      displayName: 'Fable',
    },
    {
      value: 'global.anthropic.claude-sonnet-5',
      resolvedModel: 'global.anthropic.claude-sonnet-5',
      displayName: 'Sonnet',
    },
    {
      value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      resolvedModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      displayName: 'Haiku',
    },
    {
      value: 'openai.gpt-5.6-sol',
      resolvedModel: 'openai.gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    },
  ],
}

async function openSessionPanel(page: import('@playwright/test').Page) {
  // The SECTION tab defaults to Focus, which doesn't mount the main task list.
  // Preset both axes to "All" before the first render.
  await presetPanelView(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Plain click on a task row with a session opens the SessionPanel inline.
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Model switch test task' }).first()
  await expect(taskItem).toBeVisible({ timeout: 5000 })
  await taskItem.click()
  await page.waitForTimeout(500)

  // Scoped to the session COLUMN (`REAL_PANEL`): the home page's chat spot is the
  // Ask Walnut slot, which mounts a real `SessionPanel` of its own for the selected
  // ask, so a bare `.session-panel .chat-input-textarea` resolves to TWO elements
  // and every expect() below it dies of a strict-mode violation.
  const sessionPanelInput = page.locator(`${REAL_PANEL} .chat-input-textarea`)
  await expect(sessionPanelInput).toBeVisible({ timeout: 5000 })

  return sessionPanelInput
}

/**
 * The picker `/model` opens, where the user sees it. It anchors to the column's
 * composer model pill and is PORTALLED to <body> (`.model-picker-popout`, see
 * ModelPicker.tsx), so it is not inside `REAL_PANEL`. Only one picker is open at a
 * time; `openModelPicker` checks that none was open before and exactly one after.
 */
function modelPickerPopout(page: import('@playwright/test').Page) {
  return page.locator('body > .model-picker.model-picker-popout')
}

async function openModelPicker(page: import('@playwright/test').Page, input: import('@playwright/test').Locator) {
  await input.focus()
  await input.fill('/m')
  await page.waitForTimeout(300)

  const palette = page.locator(`${REAL_PANEL} .command-palette`)
  await expect(palette).toBeVisible({ timeout: 3000 })

  const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
  await expect(modelItem).toBeVisible({ timeout: 3000 })
  const modelPicker = modelPickerPopout(page)
  await expect(modelPicker).toHaveCount(0)
  await modelItem.dispatchEvent('mousedown')

  await expect(modelPicker).toBeVisible({ timeout: 3000 })
  await expect(modelPicker).toHaveCount(1)

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

    const options = picker.locator('.model-picker-col-models .model-picker-row')
    await expect(options).toHaveCount(7)

    const names = picker.locator('.model-picker-col-models .model-picker-row-name')
    await expect(names.nth(0)).toHaveText('Haiku')
    await expect(names.nth(1)).toHaveText('Sonnet')
    await expect(names.nth(2)).toHaveText('Sonnet 1M')
    await expect(names.nth(3)).toHaveText('Fable')
    await expect(names.nth(4)).toHaveText('Fable 1M')
    await expect(names.nth(5)).toHaveText('Opus')
    await expect(names.nth(6)).toHaveText('Opus 1M')

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-fallback-7-options.png') })
  })

  test('Switch in fallback mode sends the legacy alias id', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/sessions/${SESSION_ID}/model`) && r.method() === 'POST'),
      picker.locator('.model-picker-col-models .model-picker-row', { hasText: 'Haiku' }).click(),
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
  test('sorts mixed provider models and effort from low to high', async ({ page }) => {
    await interceptCatalog(page, STRENGTH_CATALOG)
    // The live session reports a short canonical ID that does not match the
    // catalog's provider-prefixed Fable row. Its synthetic current row must
    // still sort at the Fable tier instead of being pinned above Haiku.
    await interceptLiveSettings(page, 'claude-fable-5[1m]', 'high')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const modelNames = await picker.locator('.model-picker-col-models .model-picker-row-name').allTextContents()
    expect(modelNames).toEqual([
      'Haiku 4.5',
      'Sonnet 5',
      'claude-fable-5 1M',
      'Fable 5 1M',
      'GPT-5.6 Sol',
      'Default (Opus 5 1M)',
      'Opus 5 1M',
    ])

    const effortNames = await picker.locator('.model-picker-col-effort .model-picker-row-name').allTextContents()
    expect(effortNames).toEqual(['Low', 'Medium', 'High', 'X-High', 'Max'])

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-strength-order.png') })
  })

  test('renders catalog rows; disabled row greyed with no Switch; active via resolvedModel', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    // Live model = fable full ID → matches the SPECIFIC Fable row (not 'default',
    // which shares the same resolvedModel — tier-2 beats tier-3).
    await interceptLiveSettings(page, 'global.anthropic.claude-fable-5')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    const options = picker.locator('.model-picker-col-models .model-picker-row')
    await expect(options).toHaveCount(3)

    // Rows carry the version derived from the full provider ID (caa9e214); the
    // Default row says what it resolves to.
    const names = picker.locator('.model-picker-col-models .model-picker-row-name')
    await expect(names.nth(0)).toHaveText('Default (Fable 5)')
    await expect(names.nth(1)).toHaveText('Fable 5')
    await expect(names.nth(2)).toHaveText('Opus 4.8 1M')

    // Active row = Fable (resolvedModel match on the non-default row), ✓-marked.
    // Scoped to the Model column: the Effort column marks its own active row.
    const active = picker.locator('.model-picker-col-models .model-picker-row-active')
    await expect(active).toHaveCount(1)
    await expect(active.locator('.model-picker-row-name')).toHaveText('Fable 5')
    await expect(active.locator('.model-picker-row-check')).toHaveText('✓')

    // Disabled row: greyed and not clickable.
    const disabled = picker.locator('.model-picker-row-disabled')
    await expect(disabled).toHaveCount(1)
    await expect(disabled.locator('.model-picker-row-name')).toHaveText('Opus 4.8 1M')
    await expect(disabled).toBeDisabled()

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-picker-cli-catalog.png') })
  })

  test('Switch sends the catalog row VALUE (full provider ID) verbatim', async ({ page }) => {
    await interceptCatalog(page, CLI_CATALOG)
    // Live = opus[1m] (the disabled row) so Fable is switchable.
    await interceptLiveSettings(page, 'global.anthropic.claude-opus-4-8[1m]')

    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Exact name: the Default row reads "Default (Fable 5)" and also contains "Fable".
    const fableRow = picker.locator('.model-picker-col-models .model-picker-row')
      .filter({ has: page.locator('.model-picker-row-name', { hasText: /^Fable 5$/ }) })
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().includes(`/api/sessions/${SESSION_ID}/model`) && r.method() === 'POST'),
      fableRow.click(),
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
    await expect(synthetic).toHaveAttribute('title', /not in this session's selectable catalog/)

    // No CATALOG row is active — the synthetic row is the only active-styled one
    // in the Model column (the Effort column marks its own active row).
    const actives = picker.locator('.model-picker-col-models .model-picker-row-active')
    await expect(actives).toHaveCount(1)
    await expect(actives).toHaveAttribute('data-testid', 'picker-out-of-catalog')

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

    const segs = picker.locator('.model-picker-col-effort .model-picker-row')
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
    const segs = picker.locator('.model-picker-col-effort .model-picker-row')
    await expect(segs).toHaveCount(5)
    for (const seg of await segs.all()) await expect(seg).toBeEnabled()
    await expect(segs.nth(3)).toHaveClass(/model-picker-row-active/)

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

// ── `/model` before the session record loads ──
//
// The composer takes `/model` while the header still says "Loading...", but the
// model pill (which owns the picker) mounts only once the record arrives. The pill
// used to count the request it mounted with as already served and dropped it: the
// input cleared and no picker ever opened (a cold run, 2026-10-03: the first test
// on each of 4 workers). Unit level: tests/web/composer-model-pill-open-request.test.ts.

test.describe('ModelPicker requested before the session loads', () => {
  test('/model picked while the record loads opens the picker once the pill mounts', async ({ page }) => {
    // Hold the panel's record request so the pill cannot mount yet.
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
      await gate
      await route.continue()
    })

    await presetPanelView(page)
    await page.goto('/')
    const taskItem = page.locator('.todo-panel-item', { hasText: 'Model switch test task' }).first()
    await expect(taskItem).toBeVisible({ timeout: 15_000 })
    await taskItem.click()
    const input = page.locator(`${REAL_PANEL} .chat-input-textarea`)
    await expect(input).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(`${REAL_PANEL} .session-panel-badge`, { hasText: 'Loading' })).toBeVisible()
    const pill = page.locator(`${REAL_PANEL} [data-control-id="model"]`)
    await expect(pill).toHaveCount(0)

    await input.focus()
    await input.fill('/m')
    const palette = page.locator(`${REAL_PANEL} .command-palette`)
    await expect(palette).toBeVisible({ timeout: 3000 })
    const modelItem = palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' })
    await expect(modelItem).toBeVisible({ timeout: 3000 })
    await modelItem.dispatchEvent('mousedown')
    await expect(input).toHaveValue('')
    const picker = modelPickerPopout(page)
    await expect(picker).toHaveCount(0)

    release()
    await expect(pill).toHaveCount(1, { timeout: 10_000 })
    await expect(picker).toBeVisible({ timeout: 5000 })
    await expect(picker).toHaveCount(1)
    await expect(picker.locator('.model-picker-col-models .model-picker-row')).toHaveCount(7)

    // Served once: closed, it stays closed.
    await page.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
  })
})
