/**
 * The fallback engine in the browser (src/core/agents/fallback-engine.ts): Settings > Sessions
 * "When it is out of usage" saves and reads back; a new task that started on Codex because Claude
 * Code is out of usage shows the Fallback banner; Switch to Claude Code moves the task back with its
 * conversation and the banner goes; its × takes the note off for good; a new draft says where it
 * will start.
 *
 * Real pipeline for the start: a mock Claude session writes the CLI's own limit line
 * (`rate-limit-event:<json>`, the 5-hour window rejected), so this host's Claude reading says Claude
 * Code is out of usage, then a quick-start that names no engine starts on Codex (the mock ACP
 * agent). The fixture server is shared by parallel specs, and a
 * fallback that is on while Claude Code is limited would move THEIR new tasks to Codex too: the
 * setting is on only for this spec's own start, the Settings case holds the limit-window lock while
 * it turns the setting on and off (so no sibling makes Claude Code limited meanwhile), and the
 * draft's line reads a routed answer (the server's answer is tests/e2e/fallback-engine-e2e.test.ts's).
 */
import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isolateUiPrefs, openListProject } from './todo-panel-helpers'
import { openDraft, openDraftOnCwd } from './draft-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'

// One at a time: the Settings test and the starts on the fallback both write the one fallback
// setting of the shared fixture server, and in parallel one read back the other's write.
test.describe.configure({ mode: 'default' })

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/engine-fallback-spec'
const COLUMNS_KEY = 'open-walnut-home-session-columns'

test.setTimeout(240_000)

const litter: { tasks: string[]; sessions: string[] } = { tasks: [], sessions: [] }

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.sessions = []
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 800 })
})

test.afterEach(async ({ request }) => {
  await setFallback(request, null).catch(() => undefined)
  // Only once the setting is off again: a sibling may make Claude Code limited from here on.
  if (testHoldsLock) { testHoldsLock = false; fs.rmSync(LOCK_DIR, { recursive: true, force: true }) }
  for (const sid of litter.sessions) await request.post(`/api/sessions/${sid}/terminate`).catch(() => undefined)
  for (const id of litter.tasks) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

async function config(request: APIRequestContext): Promise<Record<string, any>> {
  const body = (await (await request.get('/api/config')).json()) as Record<string, any>
  return body.config ?? body
}

async function setFallback(request: APIRequestContext, fb: { engine: string; model?: string } | null): Promise<void> {
  const cfg = await config(request)
  const defaults = { ...cfg.defaults }
  // A section write merges (src/core/config-section-write.ts): null removes the key.
  defaults.fallback_engine = fb ?? null
  const res = await request.put('/api/config', { data: { ...cfg, defaults } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function fixtureCwd(request: APIRequestContext): Promise<string> {
  const dirs = (await (await request.get('/api/sessions/working-dirs')).json()) as { dirs: Array<{ cwd: string }> }
  const cwd = dirs.dirs.find((d) => /\/ps-fixture\/projects\/walnut$/.test(d.cwd))?.cwd
  expect(cwd, 'ps-fixture/projects/walnut seed').toBeTruthy()
  return cwd!
}

/** The CLI's own limit line on this host's Claude reading, through a Claude session of its own. */
async function claudeReading(request: APIRequestContext, cwd: string, status: 'rejected' | 'allowed'): Promise<void> {
  const res = await request.post('/api/tasks', { data: { title: `Claude reading (${test.info().project.name})`, source: 'local', pinned: false } })
  const taskId = ((await res.json()) as { task: { id: string } }).task.id
  litter.tasks.push(taskId)
  const line = `rate-limit-event:${JSON.stringify({ status, rateLimitType: 'five_hour', resetsIn: 3 * 3600 })}`
  const start = await request.post('/api/sessions/quick-start', { data: { cwd, message: line, taskId, engine: 'claude' } })
  expect(start.ok(), await start.text()).toBe(true)
  litter.sessions.push(((await start.json()) as { sessionId: string }).sessionId)
  await expect.poll(async () => {
    const read = (await (await request.get('/api/subscription-limits')).json()) as { hosts: Array<{ host: string; current?: { status?: string } }> }
    return read.hosts.find((h) => h.host === '__local__')?.current?.status
  }, { timeout: 90_000 }).toBe(status)
}

/** The fixture's one local host is shared by every spec that writes its Claude reading
 *  (subscription-limit-window.spec.ts holds the same lock for its whole flow). */
const LOCK_DIR = path.join(os.tmpdir(), `walnut-pw-limit-window-${process.env.PW_TEST_PORT ?? 3457}.lock`)

/** The running test took the lock for its whole flow; afterEach frees it. */
let testHoldsLock = false

async function takeLock(): Promise<void> {
  const deadline = Date.now() + 8 * 60_000
  for (;;) {
    try { fs.mkdirSync(LOCK_DIR); return } catch { /* held */ }
    try { if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 6 * 60_000) fs.rmSync(LOCK_DIR, { recursive: true, force: true }) } catch { /* gone */ }
    if (Date.now() > deadline) throw new Error(`limit-window lock ${LOCK_DIR} never freed`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Claude Code out of usage on this host (its 5-hour window rejected, resets in 3 h) while `fn`
 *  runs, and back to allowed after it. */
async function whileClaudeLimited<T>(request: APIRequestContext, cwd: string, fn: () => Promise<T>): Promise<T> {
  await takeLock()
  try {
    await claudeReading(request, cwd, 'rejected')
    return await fn()
  } finally {
    await claudeReading(request, cwd, 'allowed').catch(() => undefined)
    fs.rmSync(LOCK_DIR, { recursive: true, force: true })
  }
}

/** A new task that names no engine, started while the fallback is on (only for this start). */
async function startOnFallback(request: APIRequestContext, cwd: string, title: string): Promise<{ taskId: string; sid: string }> {
  await setFallback(request, { engine: 'codex' })
  let started: { taskId: string }
  try {
    const res = await request.post('/api/sessions/quick-start', { data: { cwd, message: title } })
    expect(res.ok(), await res.text()).toBe(true)
    started = (await res.json()) as { taskId: string }
  } finally {
    await setFallback(request, null)
  }
  litter.tasks.push(started.taskId)
  await request.patch(`/api/tasks/${started.taskId}`, { data: { title: `${title} (${test.info().project.name})` } })
  let sid = ''
  await expect.poll(async () => {
    const t = ((await (await request.get(`/api/tasks/${started.taskId}`)).json()) as { task: { session_id?: string; engine_fallback?: { to?: string } } }).task
    sid = t.session_id ?? ''
    return `${t.engine_fallback?.to ?? ''}|${sid ? 'session' : ''}`
  }, { timeout: 60_000 }).toBe('codex|session')
  litter.sessions.push(sid)
  return { taskId: started.taskId, sid }
}

async function seedColumns(page: Page, sids: string[]): Promise<void> {
  await page.addInitScript(({ key, ids }) => {
    try { sessionStorage.setItem(key, JSON.stringify(ids.map((id) => ({ id, locked: false })))) } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, ids: sids })
}

const columnFor = (page: Page, sid: string): Locator =>
  page.locator('.main-page-sessions-area > .main-page-session-column').filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })

async function shot(page: Page, loc: Locator, name: string, pad = 16): Promise<void> {
  // A long list (other specs' tasks on the shared fixture) can put it below the fold.
  await loc.scrollIntoViewIfNeeded()
  const box = await loc.boundingBox()
  expect(box, `${name}: element has a box`).not.toBeNull()
  const vp = page.viewportSize()!
  const x = Math.max(0, box!.x - pad)
  const y = Math.max(0, box!.y - pad)
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-${name}.png`), clip: { x, y, width: Math.min(vp.width - x, box!.width + 2 * pad), height: Math.min(vp.height - y, box!.height + 2 * pad) }, animations: 'disabled' })
}

test('Settings: the fallback engine and its model save, read back after a reload, and turn off', async ({ page, request }) => {
  // The setting goes on below, and a fallback that is on while a sibling holds Claude Code limited
  // moves every parallel spec's new task to Codex (a draft spec's native launch then sent no
  // session id): hold the lock until afterEach has turned the setting off.
  await takeLock()
  testHoldsLock = true
  await setFallback(request, null)
  await page.goto('/settings#sessions')
  const row = page.getByTestId('fallback-engine-row')
  await expect(row).toBeVisible({ timeout: 30_000 })
  const select = page.getByTestId('fallback-engine-select')
  await expect(select).toHaveValue('off')
  await expect(page.getByTestId('fallback-model-row')).toHaveCount(0)
  await expect(select.locator('option').first()).toHaveText('Wait for the reset')
  await expect(page.getByTestId('fallback-engine-help')).toHaveText(/^Pick an engine for new tasks while the default engine is out of usage/)
  await expect(select.locator('option[value="claude"]')).toHaveText(/^Claude Code, another model/)

  await select.selectOption('codex')
  await expect.poll(async () => (await config(request)).defaults?.fallback_engine).toEqual({ engine: 'codex' })
  const model = page.getByTestId('fallback-model-select')
  await expect(model).toBeVisible()
  // The engine's own default is named as the model picker names it ("Codex default (GPT Best)").
  await expect(model.locator('option').first()).toHaveText(/^Codex default( \(.+\))?$|Loading models/)
  // The mock adapter lists its models: one of them is saved with the engine.
  await expect.poll(async () => model.locator('option').count(), { timeout: 20_000 }).toBeGreaterThan(1)
  const firstModel = await model.locator('option').nth(1).getAttribute('value')
  await model.selectOption(firstModel!)
  const firstLabel = (await model.locator('option').nth(1).textContent())!.trim()
  await expect.poll(async () => (await config(request)).defaults?.fallback_engine).toEqual({ engine: 'codex', model: firstModel, model_label: firstLabel })
  // The sibling defaults stay (a defaults write replaces the whole key).
  expect((await config(request)).defaults?.priority).toBeTruthy()
  await shot(page, page.locator('.settings-group').filter({ has: row }), '1-settings')

  await page.reload()
  await expect(page.getByTestId('fallback-engine-select')).toHaveValue('codex', { timeout: 30_000 })
  await expect(page.getByTestId('fallback-model-select')).toHaveValue(firstModel!)

  // The same engine on its own default model is no fallback: the row asks for a model.
  await page.getByTestId('fallback-engine-select').selectOption('claude')
  await expect(page.getByTestId('fallback-model-needed')).toBeVisible()
  await expect.poll(async () => (await config(request)).defaults?.fallback_engine).toEqual({ engine: 'claude' })
  // Another Claude model: the row says which limits it helps with, and the listed name is kept.
  await page.getByTestId('fallback-model-select').selectOption('sonnet')
  await expect(page.getByTestId('fallback-model-same-help')).toContainText('Claude models share the 5-hour and weekly limits')
  await expect.poll(async () => (await config(request)).defaults?.fallback_engine).toEqual({ engine: 'claude', model: 'sonnet', model_label: 'Sonnet' })

  await page.getByTestId('fallback-engine-select').selectOption('off')
  await expect.poll(async () => (await config(request)).defaults?.fallback_engine ?? null).toBeNull()
  await expect(page.getByTestId('fallback-model-row')).toHaveCount(0)
})

test('a task that started on Codex: the Fallback banner, Switch to Claude Code, and the ×', async ({ page, request }) => {
  const cwd = await fixtureCwd(request)
  const [a, b, c] = await whileClaudeLimited(request, cwd, async () => [
    await startOnFallback(request, cwd, 'Add a retry to the uploader'),
    await startOnFallback(request, cwd, 'Tidy the importer'),
    await startOnFallback(request, cwd, 'Write the changelog'),
  ])

  await presetPanelDesign(page, 'status')
  await seedColumns(page, [a.sid, b.sid])
  await page.goto('/')
  const colA = columnFor(page, a.sid)
  await expect(colA).toHaveCount(1, { timeout: 30_000 })
  const banner = colA.getByTestId('engine-fallback-banner')
  await expect(banner).toBeVisible({ timeout: 30_000 })
  // The setting names no model: the engine's default runs, named as the model picker names it.
  await expect(banner.getByTestId('engine-fallback-head')).toHaveText(/^Started on Codex \(.+\)$/, { timeout: 30_000 })
  const runsOn = (await banner.getByTestId('engine-fallback-head').textContent())!.replace(/^Started on /, '')
  await expect(banner.getByTestId('engine-fallback-why')).toHaveText(/^Claude 5-hour limit reached · resets\s(\w{3}\s)?\d{1,2}:\d{2}\s[AP]M$/)
  await expect(banner.getByTestId('engine-fallback-detail')).toContainText('Claude Code was out of usage, so this task started on Codex, your fallback engine.')
  await expect(banner.getByTestId('engine-fallback-detail')).toContainText(/it goes on there after the reset at (\w{3}\s)?\d{1,2}:\d{2}\s[AP]M\./)
  // One row: icon, words, ×; the button on the line under the words, all inside the banner.
  const [bb, btn, close] = [await banner.boundingBox(), await banner.getByTestId('engine-fallback-switch').boundingBox(), await banner.getByTestId('engine-fallback-dismiss').boundingBox()]
  const head = await banner.getByTestId('engine-fallback-head').boundingBox()
  expect(btn!.x + btn!.width).toBeLessThanOrEqual(bb!.x + bb!.width)
  expect(btn!.y).toBeGreaterThan(head!.y)
  expect(close!.y).toBeLessThan(head!.y + head!.height)
  await expect(colA.locator('.session-error-banner:not(.engine-fallback-banner)')).toHaveCount(0)
  await shot(page, banner, '2-banner')

  // The task's row on Home (Needs you, its turn ended) says so too, and loses it with the note.
  await setStatusSectionOpen(page, 'needs', true)
  const rowB = await showSectionCard(page, 'needs', b.taskId)
  const rowTag = rowB.getByTestId('task-row-fallback')
  await expect(rowTag).toBeVisible({ timeout: 30_000 })
  await expect(rowTag).toHaveAttribute('title', `Started on ${runsOn} · ${await banner.getByTestId('engine-fallback-why').textContent()}`)

  // ×: the note is taken off and stays off after a reload.
  const colB = columnFor(page, b.sid)
  await colB.getByTestId('engine-fallback-dismiss').click()
  await expect(colB.getByTestId('engine-fallback-banner')).toHaveCount(0)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${b.taskId}`)).json()) as { task: { engine_fallback?: unknown } }).task.engine_fallback ?? null).toBeNull()
  await expect(rowTag).toHaveCount(0)

  // Switch to Claude Code: the task's new session runs on Claude Code with the conversation, and
  // the panel follows it; the note goes with the switch.
  // The panel never reads "Untitled session" while the new session's record loads.
  const titles = new Set<string>()
  const watching = (async () => {
    for (let i = 0; i < 60; i++) {
      for (const t of await page.locator('.session-panel-title').allTextContents().catch(() => [] as string[])) titles.add(t.trim())
      await page.waitForTimeout(50)
    }
  })()
  await banner.getByTestId('engine-fallback-switch').click()
  await expect.poll(async () => {
    const t = ((await (await request.get(`/api/tasks/${a.taskId}`)).json()) as { task: { engine_switch?: { state?: string; session_id?: string }; engine_fallback?: unknown } }).task
    return `${t.engine_switch?.state ?? ''}|${t.engine_fallback ? 'note' : ''}`
  }, { timeout: 60_000 }).toBe('done|')
  const switched = ((await (await request.get(`/api/tasks/${a.taskId}`)).json()) as { task: { engine_switch?: { session_id?: string } } }).task
  const newSid = switched.engine_switch!.session_id!
  litter.sessions.push(newSid)
  const rec = ((await (await request.get(`/api/sessions/${newSid}`)).json()) as { session?: { engine?: string } }).session
  expect(rec?.engine ?? 'claude').toBe('claude')
  await expect(page.locator(`.session-panel[data-session-id="${newSid}"]`)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(`.session-panel[data-session-id="${newSid}"]`).getByTestId('engine-fallback-banner')).toHaveCount(0)
  await watching
  expect([...titles]).not.toContain('Untitled session')

  await page.reload()
  await expect(page.getByTestId('engine-fallback-banner')).toHaveCount(0, { timeout: 15_000 })

  // By project, the default Home view. The Pinned strip first (a new task is pinned): the mark
  // after the title, the title whole.
  await presetPanelDesign(page, 'project')
  await page.reload()
  const pinned = page.locator(`.todo-pinned-card[data-task-id="${c.taskId}"], .todo-focus-card[data-task-id="${c.taskId}"]`).first()
  await expect(pinned).toHaveCount(1, { timeout: 30_000 })
  const mark = pinned.getByTestId('task-row-fallback')
  await expect(mark.getByRole('img', { name: 'Fallback' })).toBeVisible()
  await expect(mark).toHaveAttribute('title', new RegExp(`^Started on ${runsOn.replace(/[()]/g, '\\$&')} · Claude 5-hour limit reached`))
  const order = await pinned.evaluate((el) => {
    const t = el.querySelector('.todo-pinned-title, .status-card-body'), m = el.querySelector('[data-testid="task-row-fallback"]')
    return !!t && !!m && !!(t.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  expect(order, 'the mark comes after the title').toBe(true)
  await shot(page, pinned, '2-row-pinned')

  // Unpinned, the task is a row of its project's list: the tag, and where it runs beside it, as the
  // Limited pill says its reset.
  await request.delete(`/api/focus/tasks/${c.taskId}`)
  await page.reload()
  const projectC = ((await (await request.get(`/api/tasks/${c.taskId}`)).json()) as { task: { project?: string } }).task.project || 'Inbox'
  await openListProject(page, projectC)
  const rowC = page.locator(`.todo-panel .todo-panel-item[data-task-id="${c.taskId}"]`).first()
  await rowC.scrollIntoViewIfNeeded({ timeout: 30_000 })
  const tagC = rowC.getByTestId('task-row-fallback')
  await expect(tagC).toBeVisible({ timeout: 30_000 })
  await expect(tagC).toHaveAttribute('title', new RegExp(`^Started on ${runsOn.replace(/[()]/g, '\\$&')} · Claude 5-hour limit reached`))
  await expect(tagC).toHaveText(/^Fallback\s*on Codex$/)
  await shot(page, rowC, '2-row-by-project')
})

test("a new task's draft says where it starts while the default engine is out of usage", async ({ page }) => {
  // The server's own answer for this host (GET /api/engines/fallback: the vitest e2e reads it for real).
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString()
  await page.route('**/api/engines/fallback*', (route) => route.fulfill({ json: {
    host: '__local__', defaultEngine: 'claude', setting: { engine: 'codex' },
    fallback: { engine: 'codex', note: { from: 'claude', to: 'codex', window: 'five_hour', resets_at: resetsAt, resets_from: 'event', at: new Date().toISOString() } },
  } }))
  await page.goto('/')
  const panel = await openDraft(page)
  const notice = panel.getByTestId('draft-fallback-notice')
  await expect(notice).toHaveText(/^The Claude 5-hour limit is reached here \(resets (\w{3}\s)?\d{1,2}:\d{2}\s[AP]M\): this task starts on Codex \(.+\)\.$/, { timeout: 15_000 })
  // The model pill says so too, instead of "Auto", and so does the picker's Auto row.
  await expect(panel.locator('.draft-model-select')).toHaveText('Codex (fallback)')
  await shot(page, notice, '3-draft-notice', 8)
  // The picker opens on what runs: the fallback's models, its default row ticked.
  await panel.locator('.draft-model-select').click()
  const picker = page.locator('.model-picker')
  await expect(picker.getByTestId('acp-default-row')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await expect(picker.locator('.model-picker-current')).toHaveText(/ · fallback$/)
  // The draft's own tab is only a look: the launch stays on Auto, its row says the fallback.
  await expect(picker.locator('.provider-rail-item[data-provider="codex"]')).toHaveAttribute('aria-selected', 'true')
  await picker.locator('.provider-rail-item[data-provider="claude"]').click()
  await expect(picker.locator('.model-picker-row', { hasText: 'Auto (Codex, fallback)' })).toBeVisible()
  await expect(panel.locator('.draft-model-select')).toHaveText('Codex (fallback)')
  // A Claude model picked by hand waits for the reset: the line says so, with the way back.
  await picker.locator('.model-picker-row', { hasText: /^\s*Sonnet/ }).first().click()
  await expect(notice).toHaveText(/: on Sonnet this task waits for the reset\.\s*Start on Codex \(.+\) instead$/)
  await expect(panel.locator('.draft-model-select')).not.toHaveText(/fallback/)
  await shot(page, notice, '4-draft-named-waits', 8)
  await notice.getByTestId('draft-fallback-use').click()
  await expect(notice).toHaveText(/this task starts on Codex \(.+\)\.$/)
  await expect(panel.locator('.draft-model-select')).toHaveText('Codex (fallback)')
  // The answer changes while the draft is open (Settings saved another fallback, in another tab):
  // the page coming back reads it at once, not at the next minute's read.
  await page.unroute('**/api/engines/fallback*')
  await page.route('**/api/engines/fallback*', (route) => route.fulfill({ json: {
    host: '__local__', defaultEngine: 'claude', setting: { engine: 'claude' }, skip: 'needs_model', fallback: null,
    limit: { window: 'five_hour', resetsAt: resetsAt, resetsFrom: 'event' },
  } }))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(notice).toHaveText(/, and it covers every Claude model: this task waits for the reset/, { timeout: 5_000 })
  await expect(panel.locator('.draft-model-select')).not.toHaveText(/fallback/)
  // A config save (Settings in this same page) reads it at once too: the server's config:changed.
  await page.unroute('**/api/engines/fallback*')
  await page.route('**/api/engines/fallback*', (route) => route.fulfill({ json: {
    host: '__local__', defaultEngine: 'claude', setting: { engine: 'codex' },
    fallback: { engine: 'codex', note: { from: 'claude', to: 'codex', window: 'five_hour', resets_at: resetsAt, resets_from: 'event', at: new Date().toISOString() } },
  } }))
  // An empty write changes nothing (the fixture is shared) and still broadcasts config:changed.
  const write = await page.request.put('/api/config', { data: {} })
  expect(write.ok(), await write.text()).toBe(true)
  await expect(notice).toHaveText(/this task starts on Codex \(.+\)\.$/, { timeout: 5_000 })
  // No fallback for this host now (none set, or nothing limited): no line.
  await page.unroute('**/api/engines/fallback*')
  await page.route('**/api/engines/fallback*', (route) => route.fulfill({ json: { host: '__local__', fallback: null } }))
  await page.reload()
  const again = await openDraft(page)
  await expect(again.locator('.draft-model-select')).toBeVisible()
  await expect(again.locator('.draft-model-select')).not.toHaveText(/fallback/)
  await expect(page.getByTestId('draft-fallback-notice')).toHaveCount(0)
})

test("a folder's remembered model: the picker says what runs, and a remembered engine's model is named as its list names it", async ({ page, request }) => {
  // WebKit, the Mac app's engine: the Chromium project's draft shows its quick-folder row first, so
  // the shared folder pick (draftCwdPill: the row's first chip) clicks a quick folder there.
  test.skip(test.info().project.name !== 'webkit', 'the draft folder pick of this spec is the WebKit layout')
  const cwd = await fixtureCwd(request)
  const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString()
  await page.route('**/api/engines/fallback*', (route) => route.fulfill({ json: {
    host: '__local__', defaultEngine: 'claude', setting: { engine: 'codex' },
    fallback: { engine: 'codex', note: { from: 'claude', to: 'codex', window: 'five_hour', resets_at: resetsAt, resets_from: 'event', at: new Date().toISOString() } },
  } }))
  // The folder's last launch, as the server's frequent dirs carry it.
  let lastLaunch: Record<string, string> = { model: 'sonnet' }
  await page.route('**/api/sessions/working-dirs*', async (route) => {
    const res = await route.fetch()
    const body = (await res.json()) as { dirs: Array<{ cwd: string; lastLaunch?: unknown }> }
    for (const d of body.dirs) if (d.cwd === cwd) d.lastLaunch = lastLaunch
    // A fresh answer, not the fetched one's headers (its length no longer fits the body).
    await route.fulfill({ status: res.status(), json: body })
  })
  await page.goto('/')

  // A remembered Claude model gives way to the fallback: on the Claude tab, Auto is what runs.
  const panel = await openDraftOnCwd(page, cwd)
  const pill = panel.locator('.draft-model-select')
  await expect(pill).toHaveText('Codex (fallback)', { timeout: 15_000 })
  await pill.click()
  const picker = page.locator('.model-picker')
  await expect(picker.locator('.provider-rail-item[data-provider="codex"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 })
  await picker.locator('.provider-rail-item[data-provider="claude"]').click()
  await expect(picker.locator('.model-picker-current')).toHaveText(/^Current: Auto \(Codex, fallback\)$/)
  await expect(picker.locator('.model-picker-row[aria-selected="true"]')).toHaveText([/Auto \(Codex, fallback\)/])
  await page.keyboard.press('Escape')
  await expect(pill).toHaveText('Codex (fallback)')

  // A remembered Codex model: the draft names its engine, so it runs as remembered, named as the
  // engine lists it, with no fallback line.
  lastLaunch = { engine: 'codex', model: 'mock-gpt-fast' }
  await page.reload()
  const panel2 = await openDraftOnCwd(page, cwd)
  await expect(panel2.locator('.draft-model-select')).toHaveText(/Mock GPT Fast/, { timeout: 15_000 })
  await expect(page.getByTestId('draft-fallback-notice')).toHaveCount(0)
})
