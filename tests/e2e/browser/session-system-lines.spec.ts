/**
 * REAL-PIPELINE spec: a CLI `system` line Walnut has no handler for never shows as
 * its subtype name plus JSON, and a bookkeeping one never splits the step row.
 *
 * The reported shape (2026-10-26, Main's chat in the Mac app): two
 * `vcs_state_changed {"kind":"push","cwd":...}` rows between folded step rows, the
 * user: "the vcs changes should be combined also". Nothing is route-mocked:
 * session:start → MockDaemon spawns the mock CLI → its `system-lines-turn:<json>`
 * mode writes real stream lines (words, then two Bash steps with system lines
 * between and after, then a hold mid-turn: the words keep the steps out of the
 * turn's fold, so they are rows of their own, as in the report) → ClaudeCodeSession → the WS → the live rows.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const SHOTS = '/tmp/system-lines'
const COLUMNS_KEY = 'open-walnut-home-session-columns'
if (process.env.SYSTEM_LINES_VIDEO) test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } } })

const TURN = {
  words: 'SL_BEFORE Tests fail as expected. Now the change.',
  between: [
    { subtype: 'vcs_state_changed', kind: 'commit', cwd: '/home/sample/.claude' },
    { subtype: 'vcs_state_changed', kind: 'push', cwd: '/home/sample/.claude' },
    { subtype: 'plugin_install', status: 'installed', name: 'sample-plugin' },
    { subtype: 'some_new_2027_subtype', note: 'x', nested: { a: 1 } },
  ],
  after: [
    { subtype: 'model_fallback', content: 'SL_WORDS Switched to a backup model.', level: 'warning', originalModel: 'a', fallbackModel: 'b' },
  ],
  holdMs: 9000,
  text: 'SL_DONE pushed.',
}

let rpcSeq = 0
async function rpc(page: Page, method: string, payload: Record<string, unknown>): Promise<unknown> {
  const reqId = `pw-sl-${method}-${++rpcSeq}`
  return page.evaluate(async ({ method, payload, reqId }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    ws.send(JSON.stringify({ type: 'req', id: reqId, method, payload }))
    const res = await new Promise<unknown>((resolve) => {
      ws.onmessage = (ev) => {
        try { const parsed = JSON.parse(ev.data as string); if (parsed.type === 'res' && parsed.id === reqId) resolve(parsed.payload) } catch { /* ignore */ }
      }
      setTimeout(() => resolve(undefined), 5000)
    })
    ws.close()
    return res
  }, { method, payload, reqId })
}

async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', { data: { title: `${title} (${test.info().project.name})`, source: 'local', project: 'Walnut' } })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

async function waitForSessionId(request: APIRequestContext, taskId: string): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const res = await request.get(`/api/sessions/task/${taskId}`)
    if (res.ok()) {
      const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
      const sid = body.sessions?.[0]?.claudeSessionId
      if (sid) return sid
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no mock session appeared for task ${taskId}`)
}

const columnFor = (page: Page, sid: string): Locator =>
  page.locator('.main-page-sessions-area > .main-page-session-column').filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })

/** Every raw-looking thing a leaked system line would put on screen. */
async function rawLeaks(col: Locator): Promise<string[]> {
  const text = await col.innerText()
  return ['vcs_state_changed', 'plugin_install', 'some_new_2027_subtype', 'model_fallback', '"kind"', '"cwd"', 'sample-plugin']
    .filter((needle) => text.includes(needle))
}

test.setTimeout(180_000)

test('system lines with no handler: none raw, the git echo never splits the step row', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const TASK = await newTask(request, 'System lines')
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await rpc(page, 'session:start', { taskId: TASK, message: `system-lines-turn:${JSON.stringify(TURN)}`, project: 'Walnut' })
  const sid = await waitForSessionId(request, TASK)

  await page.addInitScript(({ key, id }) => {
    try { sessionStorage.setItem(key, JSON.stringify([{ id, locked: false }])) } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, id: sid })
  await page.goto('/')
  const col = columnFor(page, sid)
  await expect(col).toHaveCount(1, { timeout: 30_000 })

  // Mid-turn (the hold): the readable line shows as its words, the steps are one row.
  await expect(col.getByText('SL_WORDS Switched to a backup model.')).toBeVisible({ timeout: 30_000 })
  await expect(col.getByText('SL_BEFORE Tests fail as expected.')).toBeVisible()
  await expect(col.getByText('SL_DONE pushed.')).toHaveCount(0)
  const labels = await col.locator('.tool-run-label').allTextContents()
  expect(labels.filter((t) => /^Ran (2 commands|a command)/.test(t))).toEqual([expect.stringMatching(/^Ran 2 commands/)])
  expect(await rawLeaks(col)).toEqual([])
  // The server's own stream buffer (what every client renders from): the readable
  // line is its only system row, with no name or JSON. A mid-turn history read can
  // hide stream rows in the page, so this is the proof that nothing raw was kept.
  const snap = await rpc(page, 'session:stream-subscribe', { sessionId: sid }) as { blocks?: Array<{ type: string; message?: string; detail?: string }> }
  expect((snap?.blocks ?? []).filter((b) => b.type === 'system').map((b) => ({ message: b.message, detail: b.detail })))
    .toEqual([{ message: 'SL_WORDS Switched to a backup model.', detail: undefined }])
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-mid-turn.png`), clip: (await col.boundingBox())! })
  await page.waitForTimeout(800)

  // The turn ends: still nothing raw.
  await expect(col.getByText('SL_DONE pushed.')).toBeVisible({ timeout: 30_000 })
  expect(await rawLeaks(col)).toEqual([])
  await page.screenshot({ path: path.join(SHOTS, `${test.info().project.name}-after.png`), clip: (await col.boundingBox())! })
  await page.waitForTimeout(800)
})
