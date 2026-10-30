/**
 * Playwright specs for the ACP engine family beyond Codex: Gemini, OpenCode, Goose,
 * pi, DeepSeek Harness.
 *
 * Same shape as codex-engine.spec.ts, one flow per engine: real UI clicks grow a
 * draft column, confirm a path in its folder picker, click THAT engine's button
 * on the catalog-driven provider rail of the composer's model pill, send a
 * message — then the real POST body must carry `engine: '<id>'` and the mock ACP
 * agent's reply must stream into the session panel.
 *
 * Why one file for every engine instead of one codex-shaped file each: every ACP
 * engine rides the SAME transport (acp-worker + the fixture's mock adapter), so
 * the per-engine question is only "does the rail offer it, does the launch carry
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
import {
  REAL_PANEL, basenameOf, closeDraftModelPicker, draftCwdPill, draftEngineButton, openDraft,
} from './draft-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
let fixtureRoot = ''
let walnutHome = ''

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
})

interface EngineCase {
  /** Wire id, as it must appear in the quick-start body. */
  id: string
  /** Registry displayName (the rail button's tooltip, the session pill's fallback label). */
  displayName: string
}

const ENGINE_CASES: readonly EngineCase[] = [
  { id: 'gemini', displayName: 'Gemini' },
  { id: 'opencode', displayName: 'OpenCode' },
  { id: 'goose', displayName: 'Goose' },
  { id: 'pi', displayName: 'Pi' },
  { id: 'dsh', displayName: 'DeepSeek Harness' },
]

/**
 * "+" → draft column pointed at `cwd`, then engine `id` picked on the composer's
 * model pill.
 *
 * Deliberately NOT `openDraftOnCwd(page, cwd, { engine })`: that helper's engine
 * option is typed to the engines that shipped before the catalog existed. The
 * steps are otherwise identical (cwd pill → picker → Local host tab → path →
 * Shift+Enter → model pill → provider rail).
 *
 * The folder comes first so the pick lands on the Local host: every engine here
 * is local-only, and a remote host would lock its rail button. `draftEngineButton`
 * waits for the button itself, which is the catalog-hydration wait: the first
 * paint renders the compiled-in default catalog (claude + codex only), and these
 * engines appear one commit later, when GET /api/engines lands.
 */
async function openDraftWithEngine(page: Page, cwd: string, id: string): Promise<Locator> {
  await page.setContent('<a href="/">Open Walnut</a>')
  await page.getByRole('link', { name: 'Open Walnut' }).evaluate((link, url) => { (link as HTMLAnchorElement).href = url }, `http://localhost:${TEST_PORT}/`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
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

  const input = picker.locator('.sps-search-input')
  await input.fill(cwd)
  await input.press('Shift+Enter')
  await expect(picker).toBeHidden()
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))

  // Exact id (`data-provider`), so a short id ("pi") can never ride inside
  // another engine's name the day one is added.
  const button = await draftEngineButton(page, panel, id)
  // Unlocked = the catalog reports it installed AND the picked host is local; a
  // locked button here would mean the fixture's probe override never applied.
  await expect(button).not.toHaveClass(/provider-rail-item-locked/)
  await expect(button).not.toHaveAttribute('aria-disabled', 'true')
  await button.click()
  await expect(button).toHaveAttribute('aria-selected', 'true')
  await closeDraftModelPicker(page)
  return panel
}

for (const { id, displayName } of ENGINE_CASES) {
  test(`${displayName} quick-start sends engine:${id} and streams the mock-acp reply`, async ({ page }) => {
    test.setTimeout(90_000)
    const audit = await installBrowserAudit(page, walnutHome)
    const draft = await openDraftWithEngine(page, `${fixtureRoot}/projects/walnut`, id)

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
    // The engine choice rode the launch, and picking a non-default engine clears
    // the model (its catalog belongs to the provider).
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
  const draft = await openDraftWithEngine(page, `${fixtureRoot}/projects/walnut`, 'opencode')

  // The draft model pill opens the ACP pane, which must list the PROBED
  // catalog (GET /api/engines/opencode/models — the fixture answers the mock
  // models) instead of the old "discovered at session start" placeholder.
  await draft.locator('.draft-model-select').click()
  const picker = page.locator('.model-picker')
  await expect(picker).toBeVisible()
  const defaultRow = picker.getByTestId('acp-default-row')
  await expect(defaultRow).toHaveAttribute('aria-selected', 'true')
  // The default row names the engine's RESOLVED default (the probe's
  // currentModelId), not just "default".
  await expect(defaultRow).toHaveText(/OpenCode default \(GPT Best\)/, { timeout: 10_000 })

  // The fixture catalog carries a second provider group ('Mock Provider') so
  // the grouped layout is exercised here too: the Provider column exists,
  // clicking a group swaps the family list without changing the selection.
  const providerCol = picker.locator('.model-picker-col-groups')
  await expect(providerCol).toBeVisible()
  await providerCol.locator('.model-picker-row', { hasText: 'Mock Provider' }).click()
  await expect(picker.locator('.model-picker-row', { hasText: 'Deep Thinker' })).toBeVisible()
  await expect(defaultRow).toHaveAttribute('aria-selected', 'true') // navigation ≠ selection

  // Type-ahead filter. Multi-token AND across the axes ("deep thinker" is
  // label tokens); a match from a NAMED group carries its provider tag.
  const filter = picker.getByTestId('acp-model-filter')
  await filter.fill('deep thinker')
  const thinkerRow = picker.locator('.model-picker-row', { hasText: 'Deep Thinker' })
  await expect(thinkerRow).toBeVisible({ timeout: 10_000 })
  await expect(thinkerRow.locator('.model-picker-row-group')).toHaveText(/Mock Provider/)
  // Cross-group reach: the anonymous group's model matches too, tagless.
  await filter.fill('best')
  const bestRow = picker.locator('.model-picker-row', { hasText: 'Mock GPT Best' })
  await expect(bestRow).toBeVisible({ timeout: 10_000 })
  await expect(bestRow.locator('.model-picker-row-group')).toHaveCount(0)
  // Picking straight from the filtered list works — and the pick clears the
  // query + follows the picked family's group, so the ✓ is visible.
  await bestRow.click()
  await expect(filter).toHaveValue('')
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

test('status updates during native input preserve the draft and the real send payload', async ({ page }) => {
  test.setTimeout(90_000)
  const sends: Array<{ sessionId: string; message: string }> = []
  await page.addInitScript(() => {
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') {
          (window as unknown as { inputTestSocket: WebSocket }).inputTestSocket = this
        }
      }
    }
  })
  page.on('websocket', socket => socket.on('framesent', frame => {
    if (typeof frame.payload !== 'string') return
    const data = JSON.parse(frame.payload)
    if (data.type === 'req' && data.method === 'session:send') sends.push(data.payload)
  }))
  const audit = await installBrowserAudit(page, walnutHome)
  const draft = await openDraftWithEngine(page, `${fixtureRoot}/projects/walnut`, 'dsh')
  const launch = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/sessions/quick-start')
  await draft.locator('.chat-input-textarea').fill('Start an input regression session')
  await draft.locator('.chat-input-textarea').press('Enter')
  expect((await launch).status()).toBe(200)
  const panel = page.locator(REAL_PANEL)
  await expect(panel).toContainText('hello from mock-acp', { timeout: 30_000 })
  const sessionId = (await panel.getAttribute('data-session-id'))!
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  expect(response.status()).toBe(200)
  const { session } = await response.json()
  const configured = await page.request.patch(`/api/sessions/${sessionId}`, { data: { output_mode: 'markdown' } })
  expect(configured.status()).toBe(200)
  await page.reload()
  await expect(panel.locator('button[title^="Output mode:"]')).toHaveText('MD')
  await page.evaluate(({ sessionId, revision, taskId }) => {
    const socket = (window as unknown as { inputTestSocket: WebSocket }).inputTestSocket
    let current = revision
    document.addEventListener('input', event => {
      if (!(event.target instanceof HTMLTextAreaElement)
        || event.target.closest('.session-panel')?.getAttribute('data-session-id') !== sessionId) return
      current++
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'event', name: 'session:status-changed', seq: current,
        data: { status: { sessionId, taskId, process_status: 'idle', activity: null,
          mode: 'default', planCompleted: false, archived: false, errorMessage: null,
          provider: 'cli', engine: 'dsh', statusRevision: current, statusUpdatedAt: new Date().toISOString() } },
      }) }))
    }, true)
  }, { sessionId, revision: session.statusRevision ?? 0, taskId: session.taskId })
  const input = panel.locator('.chat-input-textarea')
  for (let i = 0; i < 4; i++) {
    const text = `Keep native input ${i}`
    if (i % 2) { await input.click(); await input.pressSequentially(text) }
    else await input.fill(text)
    await input.press('ArrowRight')
    await expect(input).toHaveValue(text)
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), `draft:session:${sessionId}`)).toBe(text)
    await input.press('Enter')
    await expect.poll(() => sends.filter(send => send.sessionId === sessionId && send.message === text).length).toBe(1)
    await expect(panel.locator('.session-msg-assistant').filter({ hasText: `hello from mock-acp (you said: ${text}` })).toHaveCount(1, { timeout: 20_000 })
    await expect(input).toHaveValue('')
  }
  await page.reload()
  await expect(panel).toContainText('Keep native input 3', { timeout: 20_000 })
  await expect(input).toHaveValue('')
  await audit.assertClean()
})

test('provider reasoning controls live in the model picker, refresh after model switches, and keep the empty default', async ({ page }) => {
  test.setTimeout(60_000)
  const draft = await openDraftWithEngine(page, `${fixtureRoot}/projects/walnut`, 'dsh')
  let reasoning = false
  let effort = ''
  let rejectNext = false
  const writes: Array<{ id: string; value: string }> = []
  const controls = () => reasoning ? [{
    id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: effort,
    options: [{ value: '', name: 'Provider default' }, { value: 'high', name: 'High' }],
  }] : []
  await page.route('**/api/sessions/*/controls', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { id: string; value: string }
      writes.push(body)
      if (rejectNext) {
        rejectNext = false
        await route.fulfill({ status: 409, json: { error: 'Provider declined the setting' } })
        return
      }
      effort = body.value
    }
    await route.fulfill({ json: { engine: 'dsh', controls: controls() } })
  })
  await page.route('**/api/sessions/*/model', async (route) => {
    const body = route.request().postDataJSON() as { model: string }
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    reasoning = body.model === 'mock-gpt-fast'
    await route.fulfill({ response })
  })
  await draft.locator('.chat-input-textarea').fill('reasoning control UI test')
  await draft.locator('.chat-input-textarea').press('Enter')
  const panel = page.locator(REAL_PANEL)
  const pill = panel.locator('.composer-model-pill').first()
  await expect(pill).toContainText('GPT Best', { timeout: 20_000 })
  const picker = page.locator('.model-picker')
  const effortColumn = picker.getByRole('listbox', { name: 'Reasoning effort', exact: true })
  const openPicker = async () => { await pill.click(); await expect(picker).toBeVisible() }
  const checked = () => effortColumn.locator('[aria-selected="true"] .model-picker-row-name')
  await openPicker()
  await expect(effortColumn).toHaveCount(0)
  await picker.getByRole('option', { name: /Mock GPT Fast/ }).click()
  // The effort select is one column of the model picker, never a second pill.
  await expect(panel.locator('button[title="Reasoning effort"]')).toHaveCount(0)
  await page.setViewportSize({ width: 800, height: 600 })
  await openPicker()
  await expect(checked()).toHaveText('Provider default')
  const rect = await picker.boundingBox()
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(0)
  expect(rect!.y).toBeGreaterThanOrEqual(0)
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(801)
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(601)
  await effortColumn.getByRole('option', { name: 'High', exact: true }).click()
  await expect(picker).toBeHidden()
  await openPicker()
  await expect(checked()).toHaveText('High')
  await effortColumn.getByRole('option', { name: 'Provider default', exact: true }).click()
  await openPicker()
  await expect(checked()).toHaveText('Provider default')
  expect(writes).toEqual([{ id: 'reasoning_effort', value: 'high' }, { id: 'reasoning_effort', value: '' }])
  rejectNext = true
  await effortColumn.getByRole('option', { name: 'High', exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(page.getByText('Session setting could not be applied', { exact: true }).first()).toBeVisible()
  await openPicker()
  await expect(checked()).toHaveText('Provider default')
  await effortColumn.getByRole('option', { name: 'High', exact: true }).click()
  await openPicker()
  await expect(checked()).toHaveText('High')
  await page.setViewportSize({ width: 1280, height: 800 })
  await picker.getByRole('option', { name: /Mock GPT Best/ }).click()
  await openPicker()
  await expect(effortColumn).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel.locator('button[title="Reasoning effort"]')).toHaveCount(0)
})

test('a newly typed path never confirms a stale listing parent or remembered engine', async ({ page }) => {
  const oldPath = `${fixtureRoot}/projects/walnut`
  const nextPath = `${fixtureRoot}/projects/another-workspace`
  const draft = await openDraftWithEngine(page, oldPath, 'pi')
  await draftCwdPill(draft).click()
  const picker = page.locator('.session-path-selector')
  const input = picker.locator('.sps-search-input')
  await input.fill(`${oldPath}/`)
  await expect(picker.locator('.sps-status-valid')).toBeVisible()
  let release: () => void = () => {}
  const hold = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/sessions/list-dirs**', async (route) => {
    const prefix = new URL(route.request().url()).searchParams.get('prefix')
    if (prefix?.includes('another-workspace')) await hold
    await route.continue()
  })
  try {
    await input.fill(nextPath)
    await expect(input).toHaveValue(nextPath)
    await input.press('Shift+Enter')
    await expect(picker).toBeHidden()
    // The engine picked before the move is still the launch's, not the new
    // folder's remembered one (a model pill pick owns the engine).
    await expect(await draftEngineButton(page, draft, 'pi')).toHaveAttribute('aria-selected', 'true')
    await closeDraftModelPicker(page)
    await draftCwdPill(draft).click()
    await expect(input).toHaveValue(nextPath)
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
  }
})

test('an engine the server cannot run renders disabled with its reason', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  // The fixture forces every engine "installed" (WALNUT_ENGINE_PROBE_ALL=1), which
  // is what makes the launch specs above deterministic — so the unavailable case
  // is driven by stubbing the catalog endpoint instead. Real UI either way: the
  // model pill's provider rail renders from whatever GET /api/engines answers.
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

  await page.setContent('<a href="/">Open Walnut</a>')
  await page.getByRole('link', { name: 'Open Walnut' }).evaluate((link, url) => { (link as HTMLAnchorElement).href = url }, `http://localhost:${TEST_PORT}/`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  const panel = await openDraft(page)

  // The rail draws a locked engine (greyed, a lock badge) instead of hiding it,
  // and a click on it does nothing.
  const unconfigured = await draftEngineButton(page, panel, 'custom')
  await expect(unconfigured).toHaveClass(/provider-rail-item-locked/)
  await expect(unconfigured).toHaveAttribute('aria-disabled', 'true')
  // The tooltip is the server's actionable reason, not a generic "unavailable".
  await expect(unconfigured).toHaveAttribute('title', reason)
  // force: Playwright's actionability check treats aria-disabled as disabled and
  // would wait forever; the click a user can still make must not switch.
  await unconfigured.click({ force: true })
  await expect(unconfigured).toHaveAttribute('aria-selected', 'false')
  await expect(await draftEngineButton(page, panel, 'claude')).toHaveAttribute('aria-selected', 'true')

  // Same catalog, installed engine: still clickable. Proves the lock is per-row
  // data, not a blanket "everything new is off".
  const gemini = await draftEngineButton(page, panel, 'gemini')
  await expect(gemini).not.toHaveClass(/provider-rail-item-locked/)
  await expect(gemini).not.toHaveAttribute('aria-disabled', 'true')
  await closeDraftModelPicker(page)
  await audit.assertClean()
})
