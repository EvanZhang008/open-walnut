/**
 * Compacting a Claude Code session from its panel (web/src/components/sessions/CompactContext.tsx),
 * through the real pipeline: the mock CLI reports a 400K-token request with a 1-hour cache split,
 * and answers `/compact` with Claude Code's own compacting status and boundary.
 *
 *  · The "+" menu's "Compact context" row sends `/compact`; the timeline shows the compaction.
 *  · A big session whose cache went cold (the page's clock moved two hours on) shows nothing and
 *    sends nothing: once the cache expired, compacting is the user's call.
 *  · Settings → Sessions has the idle compaction switch and its threshold.
 *  · The idle compaction's row says why it ran and edits its setting in place.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import fs from 'node:fs/promises'

const SHOTS = process.env.COMPACT_SHOTS ?? '/tmp/compact-context'
const TWO_HOURS = 2 * 60 * 60 * 1000

async function sendViaRpc(page: Page, method: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ method, payload }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    const id = `pw-compact-${Math.random().toString(36).slice(2)}`
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
    await new Promise<void>((resolve) => {
      ws.onmessage = (ev) => { try { const p = JSON.parse(ev.data as string); if (p.type === 'res' && p.id === id) resolve() } catch { /* ignore */ } }
      setTimeout(resolve, 3000)
    })
    ws.close()
  }, { method, payload })
}

async function waitForSessionId(request: APIRequestContext, taskId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const res = await request.get(`/api/sessions/task/${taskId}`)
    if (res.ok()) {
      const sid = ((await res.json()) as { sessions?: Array<{ claudeSessionId: string }> }).sessions?.[0]?.claudeSessionId
      if (sid) return sid
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`no session appeared for task ${taskId}`)
}

async function openTask(page: Page, taskId: string, sessionId: string) {
  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(async () => {
    await page.locator('.todo-search-input').fill(taskId)
    await expect(task).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

/** A task whose session ran one 400K-token turn with a 1-hour cache. */
async function bigSession(page: Page, request: APIRequestContext, title: string) {
  const created = await request.post('/api/tasks', { data: { title, project: 'Walnut' } })
  expect(created.ok()).toBe(true)
  const taskId = ((await created.json()) as { task: { id: string } }).task.id
  await sendViaRpc(page, 'session:start', { taskId, project: 'Walnut', message: 'big-context-turn:400000:1h' })
  const sid = await waitForSessionId(request, taskId)
  // The turn ended and its facts are on the record.
  await expect.poll(async () => {
    const res = await request.get(`/api/sessions/${sid}`)
    const body = await res.json() as { session?: { promptCache?: { tokens?: number } }; promptCache?: { tokens?: number } }
    return (body.session ?? body).promptCache?.tokens ?? 0
  }, { timeout: 30_000 }).toBeGreaterThan(300_000)
  return { taskId, sid }
}

type IdleCompactionSetting = { enabled?: boolean; limit_percent?: number | null }
async function idleCompactionConfig(request: APIRequestContext): Promise<IdleCompactionSetting | undefined> {
  const body = await (await request.get('/api/config')).json() as { config?: { session?: { idle_compaction?: IdleCompactionSetting } } }
  return body.config?.session?.idle_compaction
}

/** A compaction shows under a line that names it (SystemGroupRun, fold-steps.ts): open it when it is a fold. */
const COMPACT_FOLD = /^(Context compacted|Compacted by Walnut while idle)( \u00b7 .*)?$/
async function openNotices(panel: Locator) {
  const fold = panel.locator('.session-history').getByText(COMPACT_FOLD).last()
  await expect(fold).toBeVisible({ timeout: 25_000 })
  await fold.click()
}
/** The compaction rows, one per compaction: the live row and the transcript's are the same line. */
const compactRows = (panel: Locator) => panel.locator('.session-history').getByText(/^400K \u2192 18K tokens$/)

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test('the + menu compacts the session without typing /compact', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const { taskId, sid } = await bigSession(page, request, `Compact row ${info.project.name}`)
  const panel = await openTask(page, taskId, sid)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('Turn 1 done', { timeout: 25_000 })
  // Warm cache: no offer.
  await expect(panel.getByTestId('compact-offer')).toHaveCount(0)

  await panel.locator('.session-panel-input .chat-plus-btn').click()
  const row = panel.locator('.session-panel-input .chat-plus-menu [data-action-id="compact-context"]')
  await expect(row).toBeVisible()
  await expect(row).toHaveText('Compact context')
  await expect(row).not.toHaveAttribute('aria-disabled', 'true')
  await expect(row).toHaveAttribute('title', /400K tokens in context/)
  await panel.locator('.session-panel-input .chat-plus-menu').screenshot({ path: `${SHOTS}/${info.project.name}-plus-menu.png` })
  await row.click()
  await expect(panel.locator('.session-panel-input .chat-plus-menu')).toHaveCount(0)
  // While it runs the working line says what it does, not "is working".
  await expect(panel.locator('.session-working-label')).toHaveText(/is compacting the context/, { timeout: 10_000 })
  await openNotices(panel)
  await expect(compactRows(panel).first()).toBeVisible({ timeout: 25_000 })
  // One row for one compaction: the live row and the transcript's are the same line.
  await page.waitForTimeout(1500)
  await expect(compactRows(panel)).toHaveCount(1)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-compacted.png` })
  expect(errors).toEqual([])
})

// The rule (2026-11-04, Evan: "compact is user's own decision, only time we can do it auto or warn is the
// cache almost expired"): once the cache has expired, Walnut neither compacts nor shows anything.
test('a cold cache: no line above the composer, and no /compact sent', async ({ page, request }, info) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const cold = await bigSession(page, request, `Cold ${info.project.name}`)
  // Two hours later, as far as the page can tell.
  await page.clock.setFixedTime(Date.now() + TWO_HOURS)
  await page.reload()
  const panel = await openTask(page, cold.taskId, cold.sid)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('Turn 1 done', { timeout: 25_000 })
  await page.waitForTimeout(2000)
  await expect(panel.getByTestId('compact-offer')).toHaveCount(0)
  await expect(panel.getByText(/Prompt cache (just )?expired/)).toHaveCount(0)
  await expect(history).not.toContainText('/compact')
  // The user's own call stays one click away.
  await panel.locator('.session-panel-input .chat-plus-btn').click()
  await expect(panel.locator('.session-panel-input .chat-plus-menu [data-action-id="compact-context"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-cold.png` })
  expect(errors).toEqual([])
})

test('Settings has the idle compaction switch and its threshold', async ({ page, request }, info) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-sessions').click()
  const row = page.locator('#idle-compaction-row')
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText('Compact idle sessions before the cache expires')
  // No cold-cache line, so no setting for one.
  await expect(page.locator('#cold-offer')).toHaveCount(0)
  await expect(page.locator('#idle-compaction-min')).toHaveCount(0)
  // On by default, at 85% of where a session compacts by itself; the share is pulled into 50..99.
  await expect(page.locator('#idle-compaction')).toBeChecked()
  const pct = page.locator('#idle-compaction-percent')
  await expect(pct).toHaveAttribute('placeholder', '85')
  await pct.fill('90')
  await pct.press('Enter')
  await expect.poll(async () => (await idleCompactionConfig(request))?.limit_percent ?? null, { timeout: 10_000 }).toBe(90)
  await pct.fill('30')
  await pct.press('Enter')
  await expect(pct).toHaveValue('50')
  await expect.poll(async () => (await idleCompactionConfig(request))?.limit_percent ?? null, { timeout: 10_000 }).toBe(50)
  await pct.fill('')
  await pct.press('Enter')
  await expect.poll(async () => (await idleCompactionConfig(request))?.limit_percent ?? null, { timeout: 10_000 }).toBe(null)
  await page.locator('#idle-compaction').click()
  await expect.poll(async () => (await idleCompactionConfig(request))?.enabled ?? null, { timeout: 10_000 }).toBe(false)
  await row.locator('xpath=ancestor::*[contains(@class,"settings-group")][1]').screenshot({ path: `${SHOTS}/${info.project.name}-settings.png` }).catch(() => {})
  // Back to the defaults for the specs after this one.
  await page.locator('#idle-compaction').click()
  await expect.poll(async () => (await idleCompactionConfig(request))?.enabled ?? null, { timeout: 10_000 }).toBe(true)
})

// Needs a server whose idle compaction fires right after a turn (WALNUT_IDLE_COMPACT_LEAD_MS=3580000) and a
// mock that reports a 450K model window (MOCK_CONTEXT_WINDOW=450000): 400K is then past 85% of it.
// 2026-11-04, Evan: the row says why it ran, and its setting can be changed "when they see this message".
test('the idle compaction row says why it ran and changes its setting in place', async ({ page, request }, info) => {
  test.skip(!process.env.WALNUT_IDLE_COMPACT_LEAD_MS || !process.env.MOCK_CONTEXT_WINDOW,
    'needs WALNUT_IDLE_COMPACT_LEAD_MS and MOCK_CONTEXT_WINDOW on the test server')
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const { taskId, sid } = await bigSession(page, request, `Idle row ${info.project.name}`)
  const panel = await openTask(page, taskId, sid)
  const history = panel.locator('.session-history')
  const fold = history.getByText(/^Compacted by Walnut while idle/).last()
  await expect(fold).toBeVisible({ timeout: 60_000 })
  await fold.click()
  const line = history.getByTestId('idle-compact-line').first()
  await expect(line).toBeVisible()
  // Open already: the reason and the setting show as soon as the fold does.
  await expect(line.locator('.idle-compact-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(line.getByTestId('idle-compact-why')).toHaveText(
    "Why: 400K tokens, past 85% (383K) of the model's 450K context window (no auto-compaction window is set).", { timeout: 15_000 })
  const pct = line.getByTestId('idle-compact-percent')
  await expect(pct).toHaveValue('85')
  // Out of range: said so, nothing saved.
  await pct.fill('120')
  await pct.press('Enter')
  await expect(line.locator('.idle-compact-error')).toContainText('50% to 99%')
  expect((await idleCompactionConfig(request))?.limit_percent ?? null).toBe(null)
  await pct.fill('90')
  await pct.press('Enter')
  await expect.poll(async () => (await idleCompactionConfig(request))?.limit_percent ?? null, { timeout: 10_000 }).toBe(90)
  await line.screenshot({ path: `${SHOTS}/${info.project.name}-idle-row.png` }).catch(() => {})
  // The same value Settings shows.
  await page.goto('/settings')
  await page.getByTestId('settings-nav-sessions').click()
  await expect(page.locator('#idle-compaction-percent')).toHaveValue('90', { timeout: 20_000 })
  // Back to the default for the specs after this one.
  await page.locator('#idle-compaction-percent').fill('')
  await page.locator('#idle-compaction-percent').press('Enter')
  await expect.poll(async () => (await idleCompactionConfig(request))?.limit_percent ?? null, { timeout: 10_000 }).toBe(null)
  expect(errors).toEqual([])
})
