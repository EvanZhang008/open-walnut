/**
 * Voice > Dictation, the simplified setup (real new-user test, 2026-09-30):
 *  - the picker offers three engines (Qwen3-ASR, Whisper, OpenAI-compatible API),
 *    a legacy engine only when it is the active one;
 *  - with no engine configured the recommended one is PRESELECTED but not saved;
 *  - Qwen3-ASR is installed by the server itself: its row shows the install
 *    (progress, failure, ready) and Install starts it;
 *  - for the hand-set MLX env and Whisper, ONE "Set up dictation" row says what
 *    will happen and has one button;
 *  - the setup keeps running (and keeps its progress) across a pane switch, and
 *    finishing it writes the engine config;
 *  - the unconfigured mic says "Set up dictation" and lands on that row.
 *
 * Detection is REAL: the fixture server runs on this machine (Apple Silicon), so
 * Qwen3-ASR is the recommended engine, with the fixture's throwaway HOME (no
 * venv, no model cache). The fixture is an isolated server, so it never starts
 * the Qwen install on its own. Nothing installs or downloads: config writes are
 * intercepted, and the tests that press Set up or Install answer the setup
 * endpoints themselves. Run both engines: PW_WEBKIT=1 ... --project webkit for the Mac app.
 * Screenshots: /tmp/onboarding-walk/stt/ (never committed).
 */
import { test, expect, type Page, type Request } from '@playwright/test'
import fs from 'node:fs/promises'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const ENGINE = process.env.PW_WEBKIT ? 'webkit' : 'chromium'
const SHOTS = '/tmp/onboarding-walk/stt'

async function shot(page: Page, name: string) {
  await fs.mkdir(SHOTS, { recursive: true })
  await page.locator('.settings-pane').screenshot({ path: `${SHOTS}/${name}-${ENGINE}.png`, scale: 'css' })
}

async function openSettings(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string) {
  const item = page.getByTestId(`settings-nav-${id}`)
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 20_000 })
}

/** Every write is recorded; config writes are answered here so the fixture never changes. */
async function recordWrites(page: Page): Promise<Array<{ method: string; path: string; body: string }>> {
  const writes: Array<{ method: string; path: string; body: string }> = []
  await page.route('**/api/**', async (route) => {
    const req: Request = route.request()
    if (req.method() === 'GET') return route.fallback()
    writes.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() ?? '' })
    if (new URL(req.url()).pathname === '/api/config') return route.fulfill({ status: 200, json: { ok: true } })
    return route.fallback()
  })
  return writes
}

/** The REAL config with `stt` fields laid over it: an install already using some engine. */
async function withStt(page: Page, stt: Record<string, unknown>) {
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const json = await res.json()
    // GET /api/config answers { config, envTokenHint }.
    json.config.stt = { ...json.config.stt, ...stt }
    return route.fulfill({ response: res, json })
  })
}

async function openVoice(page: Page) {
  await clickNav(page, 'stt')
  await expect(page.getByTestId('stt-scan-row').locator('.stt-scan-status')).toHaveAttribute('data-scan', 'done', { timeout: 30_000 })
}

const optionTexts = (page: Page) => page.locator('#stt-engine option').allTextContents()

test('unconfigured Mac: Qwen3-ASR preselected, three engines, its install row, nothing saved', async ({ page }) => {
  const writes = await recordWrites(page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openSettings(page)
  await openVoice(page)

  const select = page.getByTestId('stt-engine-select')
  await expect(select).toHaveValue('qwen')
  expect(await optionTexts(page)).toEqual(['Qwen3-ASR', 'Whisper', 'OpenAI-compatible API'])
  const selectText = (await select.textContent()) ?? ''
  expect(selectText).not.toContain('Whisper CLI')
  expect(selectText).not.toContain('sherpa-onnx')
  expect(selectText).not.toContain('Choose an engine')

  const engineRow = page.locator('.stt-service-dropdown')
  await expect(engineRow).toContainText('Best for Chinese and English. Walnut installs it on this server by itself.')
  await expect(engineRow.locator('.settings-tag', { hasText: 'Recommended' })).toBeVisible()
  await expect(engineRow.locator('.settings-tag', { hasText: 'Local' })).toBeVisible()
  // The select keeps its accessible name with the tags beside the label.
  await expect(page.getByLabel('Engine', { exact: true })).toHaveValue('qwen')
  // The engine's one-line description stays one line (no jump when the scan lands).
  const help = await engineRow.locator('.settings-row-help').evaluate((el) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16
    return Math.round(el.getBoundingClientRect().height / lh)
  })
  expect(help).toBe(1)

  // Settings copy rules for this section (C8/C10/C80): no dashes, decorative
  // symbols or all-caps words in what the Voice section shows.
  const copy = await page.locator('#stt').evaluate((root) => {
    const clone = root.cloneNode(true) as HTMLElement
    clone.querySelectorAll('code, kbd, pre, option').forEach((n) => n.remove())
    return clone.innerText ?? clone.textContent ?? ''
  })
  expect(copy).not.toMatch(/[\u2014\u2013]/)
  expect(copy).not.toMatch(/[\u00b7\u2192\u203a\u25b8\u25be\u2713\u2717\u00d7\u2026\u2197]/)
  const caps = (copy.match(/\b[A-Z][A-Z0-9]{3,}\b/g) ?? []).filter((w) => !['TTS', 'STT', 'API'].includes(w))
  expect(caps).toEqual([])

  // The server installs Qwen itself; on this isolated fixture it has not started.
  const qwen = page.getByTestId('stt-qwen-row')
  await expect(qwen).toHaveCount(1)
  await expect(qwen.locator('.settings-row-help')).toHaveText('Walnut downloads Qwen3-ASR to this server and turns dictation on.')
  await expect(qwen.getByRole('button', { name: 'Install' })).toBeVisible()
  await expect(page.getByTestId('stt-setup-row')).toHaveCount(0)
  // No model catalog, no install banner: one row, one button.
  await expect(page.locator('.stt-install-banner')).toHaveCount(0)
  await expect(page.locator('.stt-model-manager')).toHaveCount(0)
  await shot(page, 'unconfigured')

  // Preselected, not saved: opening the pane wrote nothing.
  await page.waitForTimeout(1000)
  expect(writes.filter((w) => w.path === '/api/config')).toEqual([])
  expect(errors).toEqual([])
})

test('Whisper picked on this Mac: its Set up row downloads Large v3 Turbo only', async ({ page }) => {
  await recordWrites(page)
  await withStt(page, { engine: 'whisper-server' })
  await openSettings(page)
  await openVoice(page)
  await expect(page.getByTestId('stt-engine-select')).toHaveValue('whisper-server')
  await expect(page.locator('.stt-service-dropdown')).toContainText('Runs on this Mac; works on any Mac.')
  // Qwen3-ASR is the recommended one here, so Whisper carries no Recommended tag.
  await expect(page.locator('.stt-service-dropdown .settings-tag', { hasText: 'Recommended' })).toHaveCount(0)
  const setup = page.getByTestId('stt-setup-row')
  // whisper-server and ffmpeg come from this machine's Homebrew; only the model is missing.
  await expect(setup.locator('.settings-row-help')).toHaveText('Downloads Large v3 Turbo (1.6 GB).')
  await shot(page, 'whisper-picked')
})

test('a legacy engine that is active stays listed, labelled legacy, with its rows', async ({ page }) => {
  await recordWrites(page)
  await withStt(page, { engine: 'sherpa-onnx' })
  await openSettings(page)
  await openVoice(page)
  await expect(page.getByTestId('stt-engine-select')).toHaveValue('sherpa-onnx')
  expect(await optionTexts(page)).toEqual(['Qwen3-ASR', 'Whisper', 'sherpa-onnx (legacy)', 'OpenAI-compatible API'])
  await expect(page.locator('.stt-model-manager')).toContainText('sherpa-onnx model')
  await expect(page.getByTestId('stt-setup-row')).toHaveCount(0)
})

test('own MLX env: Set up runs its steps, keeps them across a pane switch, then writes the config', async ({ page }) => {
  const writes = await recordWrites(page)
  await withStt(page, { engine: 'mlx' })
  const calls: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  // The only stubbed endpoint: nothing may install or download in a test.
  await page.route('**/api/stt/setup', async (route) => {
    const { action } = JSON.parse(route.request().postData() ?? '{}') as { action: string }
    calls.push(action)
    if (action === 'setup_mlx_env') await gate
    const events = [
      { type: 'progress', percent: 40, message: 'Installing mlx-audio...' },
      { type: 'done', message: action === 'setup_mlx_env' ? 'Python environment ready' : 'Qwen3-ASR downloaded' },
    ]
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') })
  })
  await openSettings(page)
  await openVoice(page)
  const setupRow = page.getByTestId('stt-setup-row')
  // This machine has ffmpeg and uv; the fixture HOME has no venv and no model cache.
  await expect(setupRow.locator('.settings-row-help')).toHaveText('Creates a Python environment with mlx-audio (about 400 MB), downloads Qwen3-ASR (2.3 GB).')
  await page.getByTestId('stt-setup-button').click()

  const progress = page.getByTestId('stt-setup-progress')
  await expect(progress).toBeVisible()
  await expect(progress.locator('.stt-run-step')).toHaveCount(2)
  await expect(progress.locator('.stt-run-step').first()).toContainText('Create the Python environment')
  await expect(progress.locator('[data-step-status="running"]')).toHaveCount(1)
  // The engine cannot change under a running setup.
  await expect(page.getByTestId('stt-engine-select')).toBeDisabled()
  await shot(page, 'setup-running')

  // Another pane and back: the step is still running, not restarted.
  await clickNav(page, 'general')
  await openVoice(page)
  await expect(page.getByTestId('stt-setup-progress').locator('[data-step-status="running"]')).toHaveCount(1)
  expect(calls).toEqual(['setup_mlx_env'])

  release()
  await expect.poll(() => writes.filter((w) => w.path === '/api/config').length, { timeout: 20_000 }).toBeGreaterThan(0)
  expect(calls).toEqual(['setup_mlx_env', 'download_mlx_model'])
  const put = JSON.parse(writes.find((w) => w.path === '/api/config')!.body)
  expect(put.stt.engine).toBe('mlx')
  expect(put.stt.mlx_model).toBe('mlx-community/Qwen3-ASR-1.7B-8bit')
  expect(put.stt.mlx_python_path).toMatch(/\/\.local\/share\/open-walnut\/stt-mlx\/bin\/python$/)
  await expect(page.getByTestId('stt-setup-progress')).toHaveCount(0)
})

test('a failed step says why and offers Retry', async ({ page }) => {
  await recordWrites(page)
  await withStt(page, { engine: 'mlx' })
  await page.route('**/api/stt/setup', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ type: 'error', message: 'Installing mlx-audio failed (exit 1): no matching distribution' })}\n\n`,
  }))
  await openSettings(page)
  await openVoice(page)
  await page.getByTestId('stt-setup-button').click()
  const progress = page.getByTestId('stt-setup-progress')
  await expect(progress).toHaveAttribute('data-status', 'failed')
  await expect(progress).toContainText('no matching distribution')
  await expect(progress.getByRole('button', { name: 'Retry' })).toBeVisible()
  await shot(page, 'setup-failed')
  await progress.getByRole('button', { name: 'Close' }).click()
  // Closing rescans the Mac (it may have changed), then the row is back.
  await expect(page.getByTestId('stt-setup-row')).toBeVisible({ timeout: 30_000 })
})

test('the unconfigured mic says Set up dictation and lands on the setup row', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  // The draft column's composer carries a mic.
  await page.getByRole('button', { name: 'New task' }).click()
  const mic = page.locator('.mic-btn').first()
  await expect(mic).toBeVisible({ timeout: 30_000 })
  await expect(mic).toHaveAttribute('title', 'Set up dictation', { timeout: 20_000 })
  await mic.click()
  await expect(page).toHaveURL(/\/settings#stt$/)
  await expect(page.getByTestId('stt-qwen-row')).toBeVisible({ timeout: 30_000 })
})

test('Install saves Qwen, starts the server install, and shows its progress until ready', async ({ page }) => {
  const writes = await recordWrites(page)
  let setup: Record<string, unknown> = { state: 'skipped', message: 'isolated server' }
  let engine: string | null = null
  let available = false
  let retries = 0
  await page.route('**/api/stt/qwen-setup/retry', (route) => {
    retries++
    setup = { state: 'installing', runtime: 'mlx', percent: 40, message: 'Downloading the model' }
    return route.fulfill({ status: 200, json: { setup } })
  })
  await page.route('**/api/stt/status', (route) => route.fulfill({
    status: 200, json: { engine, available, ...(available ? {} : { error: 'The voice model is still being installed' }), setup },
  }))
  await openSettings(page)
  await openVoice(page)
  await page.getByTestId('stt-qwen-row').getByRole('button', { name: 'Install' }).click()

  await expect.poll(() => writes.filter((w) => w.path === '/api/config').length, { timeout: 20_000 }).toBeGreaterThan(0)
  expect(JSON.parse(writes.find((w) => w.path === '/api/config')!.body).stt.engine).toBe('qwen')
  await expect.poll(() => retries, { timeout: 20_000 }).toBe(1)
  const row = page.getByTestId('stt-qwen-row')
  await expect(row).toHaveAttribute('data-state', 'installing', { timeout: 20_000 })
  await expect(row.locator('.settings-progress-pct')).toHaveText('40%')
  await shot(page, 'qwen-installing')

  // The install finishes: the row's own poll picks it up.
  engine = 'qwen'
  available = true
  setup = { state: 'ready', runtime: 'mlx', percent: 100, message: 'Voice model ready' }
  await expect(row).toHaveAttribute('data-state', 'ready', { timeout: 20_000 })
  await expect(row).toContainText('Runs on this server (mlx).')
})

test('a failed Qwen install says why and offers Retry now', async ({ page }) => {
  await recordWrites(page)
  await withStt(page, { engine: 'qwen' })
  await page.route('**/api/stt/status', (route) => route.fulfill({
    status: 200,
    json: {
      engine: 'qwen', available: false, error: 'The voice model is still being installed',
      setup: { state: 'failed', runtime: 'mlx', error: 'Not enough disk space for voice transcription', retryAt: new Date(Date.now() + 60_000).toISOString() },
    },
  }))
  await openSettings(page)
  await openVoice(page)
  const row = page.getByTestId('stt-qwen-row')
  await expect(row).toHaveAttribute('data-state', 'failed', { timeout: 20_000 })
  await expect(row).toContainText('Not enough disk space for voice transcription')
  await expect(row.getByRole('button', { name: 'Retry now' })).toBeVisible()
  await shot(page, 'qwen-failed')
})
