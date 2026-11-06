/**
 * Walnut's own `/compact` is Walnut's notice in the chat, never a message of the user's.
 *
 * Reported (2026-11-05): after Walnut rescued a session stuck on "Prompt is too long", the chat
 * showed a "/compact" bubble as if the user had typed it (the quiet command the recovery sends).
 * Through the real pipeline: the mock CLI refuses every line once its context is full, the user's
 * message gets the error, Walnut compacts and resends it, and the history shows one Walnut notice
 * where the command ran, under the compaction's line (src/core/sessions/walnut-commands.ts).
 *
 * Needs a test server whose mock CLI fills up (MOCK_CONTEXT_FULL_AT=177000, MOCK_CONTEXT_WINDOW=200000).
 */
import fs from 'node:fs/promises'
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'

const SHOTS = process.env.WALNUT_COMMAND_SHOTS ?? '/tmp/walnut-command-notice'
const NOTICE = 'Claude Code answered "Prompt is too long", so Walnut asked it to compact this conversation.'
const RECORDING = !!process.env.WALNUT_COMMAND_VIDEO
/** A recording stays on a screen long enough to read it. */
const hold = (page: Page) => (RECORDING ? page.waitForTimeout(2_000) : Promise.resolve())

test.use({ viewport: { width: 1280, height: 860 }, video: process.env.WALNUT_COMMAND_VIDEO ? { mode: 'on', size: { width: 1280, height: 860 } } : 'off' })
test.describe.configure({ timeout: 120_000 })
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })
// The mock CLI echoes what it read, and the resend quotes the person's line with the hints it
// carried: off for this spec, so the recording shows the chat as a real reply would leave it.
test.beforeEach(async ({ request }) => { await request.put('/api/v1/hints/rich-output', { data: { enabled: false } }) })
test.afterEach(async ({ request }) => { await request.delete('/api/v1/hints/rich-output') })

async function sendViaRpc(page: Page, method: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ method, payload }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    const id = `pw-notice-${Math.random().toString(36).slice(2)}`
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
    await new Promise<void>((resolve) => {
      ws.onmessage = (ev) => { try { const p = JSON.parse(ev.data as string); if (p.type === 'res' && p.id === id) resolve() } catch { /* ignore */ } }
      setTimeout(resolve, 3000)
    })
    ws.close()
  }, { method, payload })
}

async function sessionOf(request: APIRequestContext, taskId: string): Promise<string> {
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

async function record(request: APIRequestContext, sid: string): Promise<Record<string, any>> {
  const body = await (await request.get(`/api/sessions/${sid}`)).json() as { session?: Record<string, any> }
  return body.session ?? body
}

test('the recovery\'s /compact shows as Walnut\'s notice, never as the user\'s message', async ({ page, request }, info) => {
  test.skip(!process.env.MOCK_CONTEXT_FULL_AT, 'needs MOCK_CONTEXT_FULL_AT on the test server')
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })

  // A session whose context is full: its next line gets "Prompt is too long".
  const created = await request.post('/api/tasks', { data: { title: `Full context ${info.project.name}`, project: 'Walnut' } })
  expect(created.ok()).toBe(true)
  const taskId = ((await created.json()) as { task: { id: string } }).task.id
  await sendViaRpc(page, 'session:start', { taskId, project: 'Walnut', message: 'big-context-turn:178000:1h' })
  const sid = await sessionOf(request, taskId)
  await expect.poll(async () => (await record(request, sid)).promptCache?.tokens ?? 0, { timeout: 30_000 }).toBeGreaterThan(170_000)

  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(async () => {
    await page.locator('.todo-search-input').fill(taskId)
    await expect(task).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const history = panel.locator('.session-history')
  await expect(history).toContainText('Turn 1 done', { timeout: 25_000 })

  // The user writes; the line is refused, Walnut compacts and resends it.
  const composer = panel.locator('.session-panel-input textarea')
  await composer.fill('hi, where does the review stand?')
  await composer.press('Enter')
  await expect(panel.getByText('Walnut is compacting this conversation so it fits again')).toBeVisible({ timeout: 20_000 })
  // The working line says which compaction runs, and no second row says it again.
  await expect(history.getByText('Compacting context...', { exact: true })).toHaveCount(0)
  await hold(page)
  await expect.poll(async () => (await record(request, sid)).contextRecovery?.state, { timeout: 45_000 }).toBe('done')
  await expect.poll(async () => (await record(request, sid)).process_status, { timeout: 30_000 }).not.toBe('running')

  // Live, while it ran: the working line said which compaction, and no /compact bubble came.
  await expect(history.locator('.session-msg-user', { hasText: '/compact' })).toHaveCount(0)
  // Claude Code's refusal is its error line, never an answer bubble (2026-11-06).
  await expect(history.locator('.session-msg-assistant', { hasText: /^\s*Prompt is too long\s*$/ })).toHaveCount(0)
  await expect(history.locator('.session-msg-user', { hasText: 'hi, where does the review stand?' })).toHaveCount(1)
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-live.png` })
  await hold(page)

  // Read back as a fresh page would: the transcript, not the live stream.
  await page.reload()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
  await expect(panel).toBeVisible({ timeout: 20_000 })
  // The compaction stands on its own row, never inside the fold of the rest, and says who made it
  // and why with the size it took off; Walnut's notice is inside it, one fold deep.
  const compacted = history.getByText(/^Compacted by Walnut to fit the context window · 178K → 18K tokens$/)
  await expect(compacted).toHaveCount(1, { timeout: 25_000 })
  await expect(compacted).toBeVisible()
  await expect(history.locator('.session-msg-user', { hasText: '/compact' })).toHaveCount(0)
  await hold(page)
  await compacted.click()
  await expect(history.getByText(NOTICE)).toBeVisible({ timeout: 10_000 })
  // The line said the size: the compaction's own row is not repeated under it.
  await expect(history.getByText(/^Context compacted/)).toHaveCount(0)
  await expect(history.getByText('hi, where does the review stand?').first()).toBeVisible()
  await expect(history.locator('.session-msg-user', { hasText: '/compact' })).toHaveCount(0)
  await expect(history).not.toContainText('Walnut started this compaction')
  // The user's own message stays his bubble, once, after the reload as before it.
  await expect(history.locator('.session-msg-user', { hasText: 'hi, where does the review stand?' })).toHaveCount(1)
  await expect(history).not.toContainText('rich-output')
  // Read back, the refusal is still the CLI's error line: grey, its "!" in the error colour.
  await expect(history.locator('.session-msg-assistant', { hasText: /^\s*Prompt is too long\s*$/ })).toHaveCount(0)
  const refusal = history.locator('.session-system-line--cli-error', { hasText: 'Claude Code: Prompt is too long' })
  await expect(refusal.first()).toBeVisible({ timeout: 10_000 })
  const look = await refusal.first().evaluate((el) => {
    const s = getComputedStyle(el)
    return { size: s.fontSize, color: s.color, icon: getComputedStyle(el.querySelector('.session-system-icon')!).color }
  })
  expect(look.size).toBe('13px')
  expect(look.color).not.toBe(look.icon)
  // Every notice line is 13px in the notice grey (#6E6E73 on the light theme: 5:1 on white).
  const noticeLook = await history.locator('.session-system-line').first().evaluate((el) => getComputedStyle(el).fontSize)
  expect(noticeLook).toBe('13px')
  await panel.screenshot({ path: `${SHOTS}/${info.project.name}-notice.png` })
  await hold(page)
  expect(errors).toEqual([])
})
