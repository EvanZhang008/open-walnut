/**
 * REAL-PIPELINE spec for the context badge on a model whose usage arrives only at
 * the end of each request (a Converse model through the local proxy, 2026-10-10).
 *
 * The mock CLI streams each turn the way Claude Code 2.1.284 does for such a
 * model: message_start and the consolidated assistant line both carry ZERO input
 * usage, and only message_delta carries this request's real input/cache counts.
 * The transcript files the real counts, which is what a reload reads.
 *
 * Pinned: the badge shows each request's real context (27% → 27% → 9%) across a
 * cold-cache write, a failed turn with no final usage, and a post-compaction read;
 * it never drops to 0% while a turn starts; a reload shows the same number.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs/promises'

const SHOTS = '/tmp/context-badge-final-usage'

async function sendViaRpc(page: Page, method: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(async ({ method, payload }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    const id = `pw-usage-${Math.random().toString(36).slice(2)}`
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

test('the context badge follows each request\'s final usage, through a failure and a reload', async ({ page, request }, info) => {
  test.setTimeout(150_000)
  await fs.mkdir(SHOTS, { recursive: true })
  const engine = info.project.name
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  const created = await request.post('/api/tasks', { data: { title: `Final usage badge ${engine}`, project: 'Walnut' } })
  expect(created.ok()).toBe(true)
  const taskId = ((await created.json()) as { task: { id: string } }).task.id

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await sendViaRpc(page, 'session:start', {
    taskId, project: 'Walnut', model: 'claude-opus-5-5[1m]', message: 'final-usage-turn:436,488,265328',
  })
  const sid = await waitForSessionId(request, taskId)
  let panel = await openTask(page, taskId, sid)
  const pct = panel.locator('.session-detail-context-pct')
  await expect(pct).toHaveText('27%', { timeout: 25_000 })

  const history = panel.locator('.session-history')
  for (const [n, spec, expected] of [
    [2, '436,266262,0', '27%'],
    [3, 'fail', '27%'],
    [4, '2,0,90560', '9%'],
  ] as const) {
    const input = panel.locator('.chat-input-textarea')
    await input.fill(`final-usage-turn:${spec}`)
    await input.press('Enter')
    // Sample while the turn starts: a zero start must never paint 0%.
    const seen = new Set<string>()
    for (let i = 0; i < 12; i++) {
      seen.add(((await pct.textContent().catch(() => '')) ?? '').trim())
      await page.waitForTimeout(100)
    }
    expect([...seen].filter((t) => t === '0%')).toEqual([])
    if (spec !== 'fail') await expect(history).toContainText(`Final usage turn ${n}.`, { timeout: 25_000 })
    await expect(pct).toHaveText(expected, { timeout: 25_000 })
    await pct.screenshot({ path: `${SHOTS}/${engine}-turn${n}.png` }).catch(() => {})
  }
  await panel.screenshot({ path: `${SHOTS}/${engine}-live.png` })

  await page.reload()
  panel = await openTask(page, taskId, sid)
  await expect(panel.locator('.session-detail-context-pct')).toHaveText('9%', { timeout: 25_000 })
  await panel.screenshot({ path: `${SHOTS}/${engine}-after-reload.png` })
  expect(errors).toEqual([])
})
