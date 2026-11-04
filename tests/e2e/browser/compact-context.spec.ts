/**
 * Compacting a Claude Code session from its panel (web/src/components/sessions/CompactContext.tsx),
 * through the real pipeline: the mock CLI reports a 400K-token request with a 1-hour cache split,
 * and answers `/compact` with Claude Code's own compacting status and boundary.
 *
 *  · The "+" menu's "Compact context" row sends `/compact`; the timeline shows the compaction.
 *  · A big session whose cache went cold (the page's clock moved two hours on) offers
 *    "Compact first" above the composer; "Keep full context" hides it across a reload; "Compact
 *    first" compacts and the line does not come back.
 *  · Settings → Sessions has the idle compaction switch and its threshold.
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

async function idleCompactionConfig(request: APIRequestContext): Promise<{ enabled?: boolean; min_tokens?: number } | undefined> {
  const body = await (await request.get('/api/config')).json() as { config?: { session?: { idle_compaction?: { enabled?: boolean; min_tokens?: number } } } }
  return body.config?.session?.idle_compaction
}

/** The runtime's lines after an answer fold into "N notices" (fold-steps.ts): open the fold to read them. */
async function openNotices(panel: Locator) {
  const fold = panel.locator('.session-history').getByText(/^\d+ notices?$/).last()
  await expect(fold).toBeVisible({ timeout: 25_000 })
  await fold.click()
}

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
  await openNotices(panel)
  await expect(history).toContainText('Context compacted', { timeout: 25_000 })
  // One row for one compaction: the live row and the transcript's are the same line.
  await page.waitForTimeout(1500)
  await expect(history.getByText('Context compacted', { exact: true })).toHaveCount(1)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-compacted.png` })
  expect(errors).toEqual([])
})

test('a cold cache offers Compact first; Keep full context holds across a reload', async ({ page, request }, info) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const kept = await bigSession(page, request, `Cold keep ${info.project.name}`)
  const compacted = await bigSession(page, request, `Cold compact ${info.project.name}`)

  // Two hours later, as far as the page can tell.
  await page.clock.setFixedTime(Date.now() + TWO_HOURS)
  await page.reload()
  let panel = await openTask(page, kept.taskId, kept.sid)
  const offer = panel.getByTestId('compact-offer')
  await expect(offer).toBeVisible({ timeout: 20_000 })
  await expect(offer).toContainText('Prompt cache expired 1 hour ago.')
  await expect(offer).toContainText('re-reads all 400K tokens')
  await offer.screenshot({ path: `${SHOTS}/${info.project.name}-offer.png` })
  await panel.getByTestId('compact-offer-dismiss').click()
  await expect(offer).toHaveCount(0)
  await page.reload()
  panel = await openTask(page, kept.taskId, kept.sid)
  await expect(panel.locator('.session-history')).toContainText('Turn 1 done', { timeout: 25_000 })
  await expect(panel.getByTestId('compact-offer')).toHaveCount(0)

  panel = await openTask(page, compacted.taskId, compacted.sid)
  const offer2 = panel.getByTestId('compact-offer')
  await expect(offer2).toBeVisible({ timeout: 20_000 })
  await panel.getByTestId('compact-offer-compact').click()
  await expect(offer2).toHaveCount(0)
  await openNotices(panel)
  await expect(panel.locator('.session-history')).toContainText('Context compacted', { timeout: 25_000 })
  await page.reload()
  panel = await openTask(page, compacted.taskId, compacted.sid)
  await openNotices(panel)
  await expect(panel.locator('.session-history')).toContainText('Context compacted', { timeout: 25_000 })
  await expect(panel.locator('.session-history').getByText('Context compacted', { exact: true })).toHaveCount(1)
  await expect(panel.getByTestId('compact-offer')).toHaveCount(0)
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
  const min = page.locator('#idle-compaction-min')
  await min.fill('300')
  await min.press('Enter')
  await expect.poll(async () => (await idleCompactionConfig(request))?.min_tokens ?? null, { timeout: 10_000 }).toBe(300_000)
  await page.locator('#idle-compaction').click()
  await expect.poll(async () => (await idleCompactionConfig(request))?.enabled ?? null, { timeout: 10_000 }).toBe(false)
  await expect(page.locator('#idle-compaction-min')).toBeDisabled()
  await row.locator('xpath=ancestor::*[contains(@class,"settings-group")][1]').screenshot({ path: `${SHOTS}/${info.project.name}-settings.png` }).catch(() => {})
  // Back to the defaults for the specs after this one.
  await page.locator('#idle-compaction').click()
  await page.locator('#idle-compaction-min').fill('')
  await page.locator('#idle-compaction-min').press('Enter')
})
