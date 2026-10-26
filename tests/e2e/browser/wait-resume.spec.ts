/**
 * A Waiting task that a leader's message interrupts is Waiting again when the
 * turn ends (src/core/task-wait-resume.ts), as the user sees it on the Homepage:
 * the row leaves the default list again, the session's composer says "Waiting
 * until" with the same time, and no red dot asks for the user. A person's
 * message still ends the wait: that turn ends as Need Action (the existing
 * task-status-and-wait spec covers it; it is checked again here on the same task).
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { composerTextarea, openPanels } from './engine-settings-popover-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/wait-resume/shots'

test.setTimeout(150_000)
test.describe.configure({ mode: 'serial' })

const litterTasks: string[] = []
const litterRoutines: string[] = []

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all' })
  await page.setViewportSize({ width: 1280, height: 860 })
})

test.afterEach(async () => {
  for (const id of litterRoutines.splice(0)) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const id of litterTasks.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

async function shot(target: Page | Locator, name: string, browserName: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${browserName}-${name}.png` })
}

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const taskOf = async (id: string): Promise<any> => (await api('GET', `/api/tasks/${id}`)).task

async function startSession(title: string): Promise<{ sid: string; taskId: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-wait-resume-'))
  const started = await api('POST', '/api/sessions/quick-start', { cwd, message: '' })
  litterTasks.push(started.taskId)
  await api('PATCH', `/api/tasks/${started.taskId}`, { title })
  return { sid: started.sessionId, taskId: started.taskId }
}

test('a leader\'s message into a Waiting worker: In Progress for the turn, then Waiting again with the same time and no red dot', async ({ page, browserName }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const worker = await startSession(`Resumewait ${stamp} worker`)
  const lead = await startSession(`Resumewait ${stamp} lead`)
  // The worker arms its trigger (a session's own call), then the leader parks it.
  const trig = await api('POST', '/api/v1/routines/trigger', {
    name: `run-watch-${stamp}`, run: 'bash ~/.open-walnut/triggers/run-watch/check.sh', every: '5m',
    prompt: 'Check the run and do the next step.', description: 'Watches the test run; fires once when it finishes.',
    session: 'this', wait: false,
  }, { 'x-walnut-caller-sid': worker.sid })
  litterRoutines.push(trig.job.id)
  const until = new Date(Date.now() + 2 * 3_600_000).toISOString()
  await api('PATCH', `/api/v1/tasks/${worker.taskId}`, { phase: 'WAITING', wait_until: until }, { 'x-walnut-caller-sid': lead.sid })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const row = page.locator(`[data-task-id="${worker.taskId}"]`)
  const leadRow = page.locator(`[data-task-id="${lead.taskId}"]`).first()
  await expect(leadRow).toBeVisible({ timeout: 15_000 })
  await expect(row).toHaveCount(0)

  const [panel] = await openPanels(page, [worker.sid])
  const line = panel.getByTestId('session-waiting-line')
  await expect(line).toBeVisible({ timeout: 15_000 })
  const before = (await line.textContent()) ?? ''
  expect(before).toContain('Waiting until ')

  // The leader writes (task_send, a peer's message): the turn runs, then the wait is back.
  await api('POST', '/api/v1/messages', { to: worker.taskId, title: 'Status?', text: 'how far is the run?', expect_reply: false }, { 'x-walnut-caller-sid': lead.sid })
  await expect(panel.getByText(/I processed your message: .*how far is the run\?/).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await taskOf(worker.taskId)).phase, { timeout: 30_000 }).toBe('WAITING')
  const after = await taskOf(worker.taskId)
  expect(after.wait_until).toBe(until)
  expect(after.unread).toBeFalsy()
  await expect(line).toBeVisible({ timeout: 15_000 })
  await expect(line).toHaveText(before)
  await expect(row).toHaveCount(0)
  await shot(panel, 'waiting-again-after-leader-message', browserName)

  // A person's message still ends the wait: Need Action with a red dot.
  const box = composerTextarea(panel)
  await box.fill('how is it going?')
  await box.press('Enter')
  await expect(panel.getByText(/I processed your message: how is it going\?/).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await taskOf(worker.taskId)).phase, { timeout: 30_000 }).toBe('NEED_ACTION')
  expect((await taskOf(worker.taskId)).unread).toBe(true)
  await expect(line).toHaveCount(0, { timeout: 15_000 })
  await expect(row.first()).toBeVisible({ timeout: 15_000 })
  await shot(page.locator('.todo-panel'), 'need-action-after-person-message', browserName)
})
