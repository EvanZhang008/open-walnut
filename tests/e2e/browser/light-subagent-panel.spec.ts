/**
 * A light subagent (core/subagents: subagent_run on another engine) in its parent
 * session's Background tasks panel: an agent row named by its engine and model, a
 * reader that shows what it was asked and what it says while it runs (no CLI
 * transcript is fetched: it has none), its answer once it ends, and the panel's Stop.
 * A Walnut subagent (the row names its own hidden session) shows that session in the
 * normal chat view instead: its history and a composer that writes to it.
 *
 * The ledger arrives the way it does in the app, a `session:background-tasks` event on
 * the app's own socket; the server half (registry, routes, the stop route reaching the
 * run) is pinned in tests/e2e/light-subagents.test.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'

async function openTaskSession(page: Page, sessionId: string, taskId: string) {
  await page.route('**/api/search/agent?*', route => route.fulfill({
    json: { summary: '', results: [], model: 'fixture', tookMs: 0 },
  }))
  await page.goto('/')
  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(async () => {
    await page.locator('.todo-search-input').fill(taskId)
    await expect(task).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  return page.locator(`.session-panel[data-session-id="${sessionId}"]`)
}

/** Open the parent session and wait until its ledger hook has settled: the panel mounts its
 *  chat more than once while it loads, and each mount starts from the server's (empty)
 *  ledger, so a ledger emitted before the last mount would be wiped by it. */
async function openParentSession(page: Page, sessionId: string, taskId: string) {
  const reads: number[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname === `/api/sessions/${sessionId}/workflow`) reads.push(Date.now()) })
  const panel = await openTaskSession(page, sessionId, taskId)
  await expect(panel).toContainText('Review underway.', { timeout: 30_000 })
  await expect.poll(() => reads.length > 0 && Date.now() - reads[reads.length - 1]! > 1_500, { timeout: 30_000 }).toBe(true)
  return panel
}

/** The app's socket, kept for emitLedger. A `session:send` to a Walnut subagent's fixture
 *  session is recorded and answered here (the fixture has no CLI to run it); every other
 *  frame goes to the server. */
async function captureSocket(page: Page) {
  await page.addInitScript(() => {
    (window as any).__subagentSends = []
    const OriginalWebSocket = window.WebSocket
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname !== '/ws') return
        ;(window as any).__lightSocket = this
        const send = this.send.bind(this)
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          try {
            const frame = JSON.parse(data as string)
            if (frame.type === 'req' && frame.method === 'session:send' && String(frame.payload?.sessionId).startsWith('pw-walnut-subagent-')) {
              ;(window as any).__subagentSends.push(frame.payload)
              setTimeout(() => this.dispatchEvent(new MessageEvent('message', {
                data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { messageId: 'qm-pw-subagent-1', enqueuedAt: new Date().toISOString() } }),
              })), 10)
              return
            }
          } catch { /* not JSON */ }
          send(data)
        }
      }
    } as typeof WebSocket
  })
}

async function emitLedger(page: Page, sessionId: string, tasks: Array<Record<string, unknown>>) {
  await page.waitForFunction(() => (window as any).__lightSocket?.readyState === WebSocket.OPEN)
  await page.evaluate(({ sessionId, tasks }) => {
    const ws = (window as any).__lightSocket as WebSocket
    const status = { taskId: null, process_status: 'running', activity: 'Background agent running', mode: 'bypass', planCompleted: false, archived: false, errorMessage: null, provider: 'cli', engine: 'claude', pendingPermissionTool: null, statusRevision: Date.now(), statusUpdatedAt: new Date().toISOString() }
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'session:status-changed', data: { sessionId, ...status }, seq: Date.now() }),
    }))
    // Light subagents never count in inFlight: they do not hold the turn open.
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'session:background-tasks', data: { sessionId, inFlight: 0, phases: [], agents: [], tasks }, seq: Date.now() }),
    }))
  }, { sessionId, tasks })
}

const PROMPT = 'Review the diff in src/core/subagents for races between a stop and the end of the run.\nList each one with the file and line.'
const ID = 'sa-0a1b2c3d4e'

function row(over: Record<string, unknown> = {}) {
  const now = Date.now()
  return [{
    taskId: ID, taskType: 'walnut_subagent', subagentType: 'Codex · gpt-6.1-sol', status: 'running',
    description: 'Review the stop path', prompt: PROMPT, toolUses: 3, lastTool: 'Read', tokens: 12_400,
    summary: 'Reading registry.ts: the stop sets **stoppedBy** before it aborts', startedAt: now - 42_000, ...over,
  }]
}

test.describe('A light subagent in the Background tasks panel', () => {
  test.setTimeout(120_000)

  test('its row, its live reader, its answer, and Stop', async ({ page }) => {
    const project = test.info().project.name
    const sessionId = `pw-background-bar-${project}`
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const stops: string[] = []
    const transcripts: string[] = []
    page.on('request', (r) => { if (r.url().includes(ID) && !r.url().includes('/stop')) transcripts.push(r.url()) })
    await page.route('**/api/v1/sessions/*/background-tasks/*/stop', async (route) => {
      stops.push(new URL(route.request().url()).pathname)
      await route.fulfill({ json: { sessionId, taskId: ID, stopped: true, status: 'stopped' } })
    })
    await captureSocket(page)
    const panel = await openParentSession(page, sessionId, `pw-bgbar-task-${project}`)
    await emitLedger(page, sessionId, row())

    const note = panel.locator('[data-testid="session-background-note"]')
    await expect(note).toBeVisible({ timeout: 30_000 })
    await note.click()
    const reader = page.locator('.wf-modal--tasks')
    const list = reader.locator('.bg-tasks-list')
    const item = list.locator('.bg-task-row', { hasText: 'Review the stop path' })
    await expect(item).toBeVisible()
    await expect(item).toContainText('Codex')
    await item.click()
    const head = reader.locator('.bg-tasks-detail-head')
    await expect(head.locator('.bg-tasks-detail-title')).toHaveText('Review the stop path')

    // The reader: the prompt (folded), what it says now.
    const detail = reader.locator('[data-testid="light-subagent-detail"]')
    await expect(detail.locator('.bg-tasks-light-label')).toHaveText('Saying')
    await expect(detail).toContainText('Reading registry.ts: the stop sets')
    await expect(detail.locator('strong', { hasText: 'stoppedBy' })).toBeVisible()
    await detail.locator('.bg-tasks-light-prompt summary').click()
    await expect(detail.locator('.bg-tasks-light-prompt pre')).toHaveText(PROMPT)
    const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/light-subagent-panel/${project}`
    await fs.mkdir(dir, { recursive: true })
    await reader.screenshot({ path: `${dir}/1-running.png` })

    // It streams: a newer ledger replaces what it says.
    await emitLedger(page, sessionId, row({ summary: 'Found two: a stop after the answer, a timeout during start', toolUses: 5 }))
    await expect(detail).toContainText('Found two: a stop after the answer')

    // Stop: arm, then send, for exactly this run of exactly this session.
    const stop = head.locator('[data-testid="bg-task-stop"]')
    await expect(stop).toHaveText('Stop')
    await stop.click()
    await stop.click()
    await expect.poll(() => stops).toEqual([`/api/v1/sessions/${sessionId}/background-tasks/${ID}/stop`])
    await emitLedger(page, sessionId, row({ status: 'stopped', summary: 'Stopped by the user', endedAt: Date.now() }))
    await expect(stop).toHaveCount(0)
    await expect(detail.locator('.bg-tasks-light-label')).toHaveText('Why it ended')
    await expect(item).toHaveClass(/bg-task-row-stopped/)

    // A finished run shows its answer.
    await emitLedger(page, sessionId, row({ status: 'completed', summary: 'Two races:\n\n1. `stop` after the answer\n2. a timeout during start', endedAt: Date.now() }))
    await expect(detail.locator('.bg-tasks-light-label')).toHaveText('Answer')
    await expect(detail.locator('li')).toHaveCount(2)
    await reader.screenshot({ path: `${dir}/2-answered.png` })

    // It has no CLI transcript, so the reader never asked for one.
    expect(transcripts).toEqual([])
    expect(errors).toEqual([])
  })

  test('a Walnut subagent shows its own session: history, composer, its chips; closed, its answer', async ({ page }) => {
    const project = test.info().project.name
    const sessionId = `pw-background-bar-${project}`
    const subagentSession = `pw-walnut-subagent-${project}`
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await captureSocket(page)
    const panel = await openParentSession(page, sessionId, `pw-bgbar-task-${project}`)
    const walnut = (over: Record<string, unknown> = {}) => row({
      subagentType: 'Codex · gpt-6.1-sol · on clouddev', engine: 'codex', host: 'clouddev', walnutSessionId: subagentSession, ...over,
    })
    await emitLedger(page, sessionId, walnut())

    const note = panel.locator('[data-testid="session-background-note"]')
    await expect(note).toBeVisible({ timeout: 30_000 })
    await note.click()
    const reader = page.locator('.wf-modal--tasks')
    const item = reader.locator('.bg-tasks-list .bg-task-row', { hasText: 'Review the stop path' })
    await expect(item).toBeVisible()
    // The row and the head say what it is: a Walnut subagent, its engine, its host (once).
    for (const where of [item, reader.locator('.bg-tasks-detail-head')]) {
      await expect(where.locator('.bg-task-kind--walnut')).toHaveText('Walnut subagent')
      await expect(where.locator('.task-group-agent-type')).toHaveText('Codex · gpt-6.1-sol')
      await expect(where.locator('.bg-task-kind--host')).toHaveText('on clouddev')
    }
    await item.click()

    // Its own session in the chat view: the history, then a composer.
    const chat = reader.locator('[data-testid="walnut-subagent-chat"]')
    const sub = chat.locator(`.session-panel[data-session-id="${subagentSession}"]`)
    await expect(sub).toContainText('Subagent finding: the stop path races the final answer in registry.ts.', { timeout: 30_000 })
    await expect(reader.locator('[data-testid="light-subagent-detail"]')).toHaveCount(0)
    const composer = sub.locator('.chat-input-textarea')
    await expect(composer).toBeVisible()
    await expect(composer).toBeEditable()
    // The pane fits the dialog: the composer is inside the reader's box.
    const box = await reader.boundingBox()
    const input = await composer.boundingBox()
    expect(box && input && input.y + input.height <= box.y + box.height + 1).toBe(true)
    const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/light-subagent-panel/${project}`
    await fs.mkdir(dir, { recursive: true })
    await reader.screenshot({ path: `${dir}/3-walnut-subagent-chat.png` })

    // Writing to it sends to ITS session, the normal way, and the dialog stays open.
    await composer.click()
    await composer.fill('Also check the timeout path')
    await composer.press('Enter')
    await expect.poll(() => page.evaluate(() => (window as any).__subagentSends as Array<{ sessionId: string; message: string }>))
      .toEqual([expect.objectContaining({ sessionId: subagentSession, message: expect.stringContaining('Also check the timeout path') })])
    await expect(reader).toBeVisible()
    await expect(sub).toContainText('Also check the timeout path')
    await reader.screenshot({ path: `${dir}/4-walnut-subagent-sent.png` })

    // Closed: its session is gone, its answer is what remains.
    await emitLedger(page, sessionId, walnut({ status: 'completed', closed: true, summary: 'Two races, both in registry.ts', endedAt: Date.now() }))
    const detail = reader.locator('[data-testid="light-subagent-detail"]')
    await expect(detail.locator('.bg-tasks-light-label')).toHaveText('Answer')
    await expect(detail).toContainText('Two races, both in registry.ts')
    await expect(chat).toHaveCount(0)
    await expect(reader.locator('.bg-tasks-detail-head .bg-task-kind--walnut')).toHaveText('Walnut subagent')
    await reader.screenshot({ path: `${dir}/5-walnut-subagent-closed.png` })
    expect(errors).toEqual([])
  })
})
