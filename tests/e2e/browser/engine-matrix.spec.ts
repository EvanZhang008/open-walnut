/**
 * Playwright specs for the ACP engine family beyond Codex: Gemini, OpenCode, Goose.
 *
 * Same shape as codex-engine.spec.ts, one flow per engine: real UI clicks grow a
 * draft column, open its folder picker, click THAT engine's button in the
 * catalog-driven `.sps-engine-toggle`, confirm a path, send a message — then the
 * real POST body must carry `engine: '<id>'` and the mock ACP agent's reply must
 * stream into the session panel.
 *
 * Why one file for three engines instead of three codex-shaped files: every ACP
 * engine rides the SAME transport (acp-worker + the fixture's mock adapter), so
 * the per-engine question is only "does the toggle offer it, does the launch carry
 * it, does the panel render it as an ACP session". The deep per-scenario suites
 * (lifecycle, recovery, status parity, model picker) stay codex-only on purpose:
 * they exercise the transport, and duplicating them per engine would multiply
 * fixture spawn cost for zero new coverage.
 *
 * Server side: test-server.ts sets WALNUT_ENGINE_PROBE_ALL=1 (so the catalog
 * reports every engine installed on a machine that has none of these CLIs) and
 * wires sessionRunner.setTestAcpArtifacts with the real acp-worker bundle plus
 * tests/providers/mock-acp-agent.mjs, which is engine-agnostic.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'
import { REAL_PANEL, basenameOf, draftCwdPill, openDraft } from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
let fixtureRoot = ''
let walnutHome = ''

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
})

interface EngineCase {
  /** Wire id, as it must appear in the quick-start body. */
  id: string
  /** Registry displayName, which is the toggle button's label. */
  displayName: string
}

const ENGINE_CASES: readonly EngineCase[] = [
  { id: 'gemini', displayName: 'Gemini' },
  { id: 'opencode', displayName: 'OpenCode' },
  { id: 'goose', displayName: 'Goose' },
]

/**
 * "+" → draft column pointed at `cwd` with `displayName`'s engine button clicked.
 *
 * Deliberately NOT `openDraftOnCwd(page, cwd, { engine })`: that helper's engine
 * option is typed to the labels that shipped before the catalog existed, and it
 * has no wait for catalog hydration. The steps are otherwise identical (cwd pill →
 * picker → Local host tab → engine → path → Shift+Enter).
 *
 * The hydration wait is the load-bearing difference: the first paint renders the
 * compiled-in default catalog (claude + codex only), and these engines appear one
 * commit later, when GET /api/engines lands.
 */
async function openDraftWithEngine(page: Page, cwd: string, displayName: string): Promise<Locator> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()

  // PAGE-scoped: the picker portals to <body>, anchored to the pill.
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })
  // Gate on a listed row first so the host tabs have rendered (same reason as
  // openDraftOnCwd: a bare isVisible() races the working-dirs fetch under load).
  await expect(picker.locator('.sps-path-item').first()).toBeVisible({ timeout: 20_000 })
  const localTab = picker.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  const button = picker.locator('.sps-engine-toggle .sps-engine-btn', { hasText: displayName })
  await expect(button).toBeVisible({ timeout: 15_000 })
  // Enabled = the catalog reports it installed AND the picked host is local; a
  // disabled button here would mean the fixture's probe override never applied.
  await expect(button).toBeEnabled()
  await button.click()
  await expect(button).toHaveClass(/active/)

  const input = picker.locator('.sps-search-input')
  await input.fill(cwd)
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))
  return panel
}

for (const { id, displayName } of ENGINE_CASES) {
  test(`${displayName} quick-start sends engine:${id} and streams the mock-acp reply`, async ({ page }) => {
    test.setTimeout(90_000)
    const audit = await installBrowserAudit(page, walnutHome)
    const draft = await openDraftWithEngine(page, `${fixtureRoot}/projects/walnut`, displayName)

    // No route mock: the real POST goes SessionRunner → AcpSession → MockDaemon
    // (real createAcpDaemon) → acp-worker → mock-acp-agent.
    let capturedBody: Record<string, unknown> | null = null
    page.on('request', (request) => {
      if (request.method() === 'POST'
        && new URL(request.url()).pathname === '/api/sessions/quick-start') {
        capturedBody = request.postDataJSON() as Record<string, unknown>
      }
    })
    const quickStartResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/sessions/quick-start')

    const prompt = `live ${id} stream test`
    const chatInput = draft.locator('.chat-input-textarea')
    await chatInput.fill(prompt)
    await chatInput.press('Enter')

    expect((await quickStartResponse).status()).toBe(200)
    await expect.poll(() => capturedBody, { timeout: 5000 }).not.toBeNull()
    // The engine choice survived the confirm, and picking a non-default engine
    // clears the model (its catalog belongs to the provider).
    expect(capturedBody!.engine).toBe(id)
    expect(capturedBody!.model).toBeUndefined()

    const panel = page.locator(REAL_PANEL)
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(
      panel.getByText(`hello from mock-acp (you said: ${prompt})`, { exact: true }),
    ).toHaveCount(1, { timeout: 30_000 })

    // The panel's engine label. The pill takes the ACP branch for this record and
    // shows either the discovered model (the mock advertises "Mock GPT Best") or,
    // before discovery lands, the engine's displayName — both prove the panel read
    // the record as THIS engine, where a native record would show "Auto".
    // .first(): ChatInput renders its controls row in more than one mode bar, so
    // the pill can resolve twice (same text) — a bare locator would trip strict mode.
    await expect(panel.locator('.session-detail-model-pill').first())
      .toHaveText(new RegExp(`GPT Best|${displayName}`), { timeout: 15_000 })
    await audit.assertClean()
  })
}

test('OpenCode draft lists probed models and the pick rides the launch payload', async ({ page }) => {
  test.setTimeout(90_000)
  const audit = await installBrowserAudit(page, walnutHome)
  const draft = await openDraftWithEngine(page, `${fixtureRoot}/projects/walnut`, 'OpenCode')

  // The draft model pill opens the ACP pane, which must list the PROBED
  // catalog (GET /api/engines/opencode/models — the fixture answers the mock
  // models) instead of the old "discovered at session start" placeholder.
  await draft.locator('.draft-model-select').click()
  const picker = page.locator('.model-picker')
  await expect(picker).toBeVisible()
  const defaultRow = picker.getByTestId('acp-default-row')
  await expect(defaultRow).toHaveAttribute('aria-selected', 'true')
  const bestRow = picker.locator('.model-picker-row', { hasText: 'Mock GPT Best' })
  await expect(bestRow).toBeVisible({ timeout: 10_000 })
  await bestRow.click()
  // The pick replaces the engine-default choice and lands on the pill.
  await expect(defaultRow).toHaveAttribute('aria-selected', 'false')
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
  await expect(draft.locator('.draft-model-select')).toHaveText(/GPT Best/)

  let capturedBody: Record<string, unknown> | null = null
  page.on('request', (request) => {
    if (request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/sessions/quick-start') {
      capturedBody = request.postDataJSON() as Record<string, unknown>
    }
  })
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')

  const prompt = 'draft model pick test'
  const chatInput = draft.locator('.chat-input-textarea')
  await chatInput.fill(prompt)
  await chatInput.press('Enter')

  expect((await quickStartResponse).status()).toBe(200)
  await expect.poll(() => capturedBody, { timeout: 5000 }).not.toBeNull()
  expect(capturedBody!.engine).toBe('opencode')
  expect(capturedBody!.model).toBe('mock-gpt-best')

  // The session still launches and streams — the model choice must never
  // break the spawn (it rides acpConfig, applied post-establish).
  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(
    panel.getByText(`hello from mock-acp (you said: ${prompt})`, { exact: true }),
  ).toHaveCount(1, { timeout: 30_000 })
  await audit.assertClean()
})

test('an engine the server cannot run renders disabled with its reason', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  // The fixture forces every engine "installed" (WALNUT_ENGINE_PROBE_ALL=1), which
  // is what makes the launch specs above deterministic — so the unavailable case
  // is driven by stubbing the catalog endpoint instead. Real UI either way: the
  // toggle renders from whatever GET /api/engines answers.
  const reason = 'configure engines.custom.adapter_cmd (the ACP adapter argv) to use Custom (ACP)'
  const acpCapabilities = {
    rewind: false,
    fork: false,
    modelCatalog: 'provider-advertised',
    modeControl: 'config-options',
    idProvisioning: 'provider-issued',
  }
  await page.route('**/api/engines', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        engines: [
          {
            id: 'claude',
            displayName: 'Claude',
            runtimeKind: 'native',
            isDefault: true,
            localOnly: false,
            capabilities: {
              rewind: true,
              fork: true,
              modelCatalog: 'static',
              modeControl: 'claude-modes',
              idProvisioning: 'preassigned',
            },
            availability: { installed: true, version: null, reason: null },
          },
          {
            id: 'gemini',
            displayName: 'Gemini',
            runtimeKind: 'acp',
            isDefault: false,
            localOnly: true,
            capabilities: acpCapabilities,
            availability: { installed: true, version: '0.26.0', reason: null },
          },
          {
            id: 'custom',
            displayName: 'Custom (ACP)',
            runtimeKind: 'acp',
            isDefault: false,
            localOnly: true,
            capabilities: acpCapabilities,
            availability: { installed: false, version: null, reason },
          },
        ],
      }),
    })
  })

  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible({ timeout: 10_000 })

  const toggle = picker.locator('.sps-engine-toggle')
  const unconfigured = toggle.locator('.sps-engine-btn', { hasText: 'Custom (ACP)' })
  await expect(unconfigured).toBeVisible({ timeout: 15_000 })
  await expect(unconfigured).toBeDisabled()
  // The tooltip is the server's actionable reason, not a generic "unavailable".
  await expect(unconfigured).toHaveAttribute('title', reason)

  // Same catalog, installed engine: still clickable. Proves the lock is per-row
  // data, not a blanket "everything new is off".
  await expect(toggle.locator('.sps-engine-btn', { hasText: 'Gemini' })).toBeEnabled()
  await audit.assertClean()
})
