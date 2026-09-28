/**
 * The Stop control in the Background tasks reader (BackgroundTaskStopButton.tsx):
 * a running agent, command or workflow can be stopped on its own while the turn
 * and the other tasks keep going.
 *
 * What a human sees and does: Stop appears only for a RUNNING row, the first
 * click arms it ("Stop this agent?"), the second sends, it reads "Stopping…" until
 * the ledger row itself turns stopped, an armed button that is left alone goes
 * back to Stop, and a refusal shows the server's reason with a way to retry.
 *
 * The fixture server has no live CLI, so the stop request is answered here; the
 * server half (the exact `stop_task` request, the ledger check, the relay) is
 * pinned against a real server in tests/web/routes/background-task-stop.test.ts.
 * The ledger itself arrives the way it does in the app: a `session:background-tasks`
 * event on the app's own socket.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'

async function openTaskSession(page: Page, sessionId: string, taskId: string) {
  await page.route('**/api/search/agent?*', route => route.fulfill({
    json: { summary: '', results: [], model: 'fixture', tookMs: 0 },
  }))
  await page.goto('/')
  const task = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  // A fill that lands while the board is still hydrating can be reset; type again until it holds.
  await expect(async () => {
    await page.locator('.todo-search-input').fill(taskId)
    await expect(task).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  return page.locator(`.session-panel[data-session-id="${sessionId}"]`)
}

/** Keep a handle on the app's /ws socket so the test can deliver ledger events. */
async function captureSocket(page: Page) {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket
    window.WebSocket = class extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (new URL(String(url), location.href).pathname === '/ws') (window as any).__stopSocket = this
      }
    } as typeof WebSocket
  })
}

async function emitLedger(page: Page, sessionId: string, tasks: Array<Record<string, unknown>>) {
  await page.waitForFunction(() => (window as any).__stopSocket?.readyState === WebSocket.OPEN)
  await page.evaluate(({ sessionId, tasks }) => {
    const ws = (window as any).__stopSocket as WebSocket
    const inFlight = tasks.filter(t => t.status === 'running').length
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: 'session:background-tasks', data: { sessionId, inFlight, phases: [], agents: [], tasks }, seq: Date.now() }),
    }))
  }, { sessionId, tasks })
}

const LONG = 'Audit every route under src/web/routes for a missing deadline and report each one with the file, the handler and the call that can hang'

function ledger(over: Record<string, string> = {}) {
  const now = Date.now()
  return [
    { taskId: 'agent-run', taskType: 'local_agent', subagentType: 'general-purpose', status: over['agent-run'] ?? 'running', description: LONG, tokens: 41_200, toolUses: 17, startedAt: now - 300_000 },
    { taskId: 'agent-done', taskType: 'local_agent', subagentType: 'Explore', status: 'completed', description: 'Map the session hooks', tokens: 9_100, toolUses: 6, startedAt: now - 200_000, endedAt: now - 150_000 },
    { taskId: 'bash-run', taskType: 'local_bash', status: over['bash-run'] ?? 'running', description: 'npm run test:quick', startedAt: now - 90_000 },
    { taskId: 'bash-done', taskType: 'local_bash', status: 'completed', description: 'git status --short', startedAt: now - 80_000, endedAt: now - 79_000 },
  ]
}

test.describe('Stop one background task', () => {
  test.setTimeout(120_000)

  test('a running agent: arm, confirm, Stopping… until the ledger says stopped; finished rows have no Stop', async ({ page }) => {
    const project = test.info().project.name
    const sessionId = `pw-background-bar-${project}`
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const stops: string[] = []
    let answer: (route: Route) => Promise<void> = route => route.fulfill({
      json: { sessionId, taskId: 'agent-run', stopped: true, status: 'running' },
    })
    await page.route('**/api/v1/sessions/*/background-tasks/*/stop', async (route) => {
      stops.push(new URL(route.request().url()).pathname)
      await answer(route)
    })
    await captureSocket(page)
    const panel = await openTaskSession(page, sessionId, `pw-bgbar-task-${project}`)
    await expect(panel).toContainText('Review underway.', { timeout: 30_000 })
    await emitLedger(page, sessionId, ledger())
    const bar = panel.locator('.wf-card--bar')
    await expect(bar).toBeVisible({ timeout: 30_000 })
    await bar.click()
    const reader = page.locator('.wf-modal--tasks')
    const head = reader.locator('.bg-tasks-detail-head')
    await expect(head.locator('.bg-tasks-detail-title')).toHaveText(LONG)

    const stop = head.locator('[data-testid="bg-task-stop"]')
    await expect(stop).toHaveText('Stop')
    await expect(stop).toHaveAttribute('aria-label', 'Stop this agent')
    // The header holds a long title AND the control: the title ellipsizes, the
    // control stays whole inside the header.
    const headBox = (await head.boundingBox())!
    const stopBox = (await stop.boundingBox())!
    expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(headBox.x + headBox.width + 0.5)
    expect(stopBox.width).toBeGreaterThan(40)
    expect(await head.locator('.bg-tasks-detail-title').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
    // One row: the timing line gives way beside the control instead of wrapping.
    const oneLine = async () => {
      const meta = head.locator('.wf-modal-meta')
      const lh = await meta.evaluate(el => parseFloat(getComputedStyle(el).lineHeight) || 18)
      expect((await meta.boundingBox())!.height).toBeLessThanOrEqual(lh + 1)
      expect((await head.boundingBox())!.height).toBeLessThanOrEqual(headBox.height + 0.5)
    }
    await oneLine()
    const dir = `/tmp/background-task-stop/${project}`
    await fs.mkdir(dir, { recursive: true })
    await head.screenshot({ path: `${dir}/1-stop-idle.png` })

    // First click only arms it.
    await stop.click()
    await expect(stop).toHaveText('Stop this agent?')
    await expect(stop).toHaveAttribute('data-phase', 'armed')
    expect(stops).toHaveLength(0)
    await oneLine()
    await head.screenshot({ path: `${dir}/2-stop-armed.png` })

    // Second click sends, for exactly this task of exactly this session.
    await stop.click()
    await expect(stop).toHaveText('Stopping…')
    await expect(stop).toBeDisabled()
    expect(stops).toEqual([`/api/v1/sessions/${sessionId}/background-tasks/agent-run/stop`])
    await head.screenshot({ path: `${dir}/3-stopping.png` })
    // A disabled button takes no second send.
    await stop.click({ force: true })
    expect(stops).toHaveLength(1)

    // The CLI's terminal notification reaches the ledger: the row is finished,
    // and a finished row has no Stop.
    await emitLedger(page, sessionId, ledger({ 'agent-run': 'stopped' }))
    await expect(stop).toHaveCount(0)
    const list = reader.locator('.bg-tasks-list')
    await expect(list.locator('.bg-task-row', { hasText: LONG })).toHaveClass(/bg-task-row-stopped/)
    await list.locator('.bg-task-row', { hasText: 'Map the session hooks' }).click()
    await expect(head.locator('.bg-tasks-detail-title')).toHaveText('Map the session hooks')
    await expect(head.locator('[data-testid="bg-task-stop"]')).toHaveCount(0)

    // A command: its own noun; an armed button left alone goes back to Stop.
    // (Commands have their own tab when the reader splits kinds; the row is the same.)
    const commandsTab = reader.locator('.bg-tasks-tab', { hasText: 'Commands' })
    if (await commandsTab.count()) await commandsTab.click()
    await list.locator('.bg-task-row', { hasText: 'npm run test:quick' }).click()
    await expect(head.locator('.bg-tasks-detail-title')).toHaveText('npm run test:quick')
    const cmdStop = head.locator('[data-testid="bg-task-stop"]')
    await expect(cmdStop).toHaveAttribute('aria-label', 'Stop this command')
    await cmdStop.click()
    await expect(cmdStop).toHaveText('Stop this command?')
    await expect(cmdStop).toHaveText('Stop', { timeout: 8_000 })
    expect(stops).toHaveLength(1)

    // A refusal: the server's reason in words, and the button offers a retry.
    answer = route => route.fulfill({
      status: 409,
      json: { error: { code: 'conflict', message: 'The CLI did not stop the task: No task found with ID: bash-run' } },
    })
    await cmdStop.click()
    await cmdStop.click()
    await expect(head.locator('.bg-task-stop-error')).toHaveText('The CLI did not stop the task: No task found with ID: bash-run')
    await expect(cmdStop).toHaveText('Retry stop')
    await expect(cmdStop).toBeEnabled()
    expect(stops).toEqual([
      `/api/v1/sessions/${sessionId}/background-tasks/agent-run/stop`,
      `/api/v1/sessions/${sessionId}/background-tasks/bash-run/stop`,
    ])
    const errBox = (await head.locator('.bg-task-stop-error').boundingBox())!
    expect(errBox.x + errBox.width).toBeLessThanOrEqual(headBox.x + headBox.width + 0.5)
    // The full reason is one hover away.
    await expect(head.locator('.bg-task-stop-error')).toHaveAttribute('title', 'The CLI did not stop the task: No task found with ID: bash-run')
    await head.screenshot({ path: `${dir}/4-refused.png` })

    // Retry works like a first click: arm, then send.
    answer = route => route.fulfill({ json: { sessionId, taskId: 'bash-run', stopped: true, status: 'running' } })
    await cmdStop.click()
    await expect(cmdStop).toHaveText('Stop this command?')
    await cmdStop.click()
    await expect(cmdStop).toHaveText('Stopping…')
    expect(stops).toHaveLength(3)
    await emitLedger(page, sessionId, ledger({ 'agent-run': 'stopped', 'bash-run': 'stopped' }))
    await expect(cmdStop).toHaveCount(0)

    expect(errors).toEqual([])
  })
})
