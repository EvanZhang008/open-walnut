/**
 * Real use, end to end on the fixture server (src/core/usage-watch/): a session's Walnut tool
 * answer that Claude Code cut (the mock CLI replays Claude Code's own note) is counted on that
 * tool, the land it ran makes the task one that shipped, its close is refused until it names a
 * watch, and Settings › Diagnostics › Real Use shows the tool, its cut and the watch.
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs } from './todo-panel-helpers'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${PORT}`
const SHOTS = process.env.REAL_USE_SHOTS ?? ''

test.describe.configure({ mode: 'serial' })

async function call(p: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API}${p}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { parsed = { text } }
  return { status: res.status, body: parsed }
}

type Row = { kind: string; name: string; calls: number; cut: number }
async function rows(): Promise<Row[]> {
  return ((await call('/api/v1/usage-watch?range=24h', 'GET')).body.rows ?? []) as Row[]
}

async function openRealUse(page: Page) {
  // Opening the sidebar is a synced pref: keep it off the shared fixture.
  await isolateUiPrefs(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click()
  await page.locator('.sidebar-nav a[href^="/settings"]').click()
  await page.getByTestId('settings-nav-real-use').click()
  const pane = page.getByTestId('real-use')
  await expect(pane).toBeVisible({ timeout: 10_000 })
  return pane
}

test.beforeAll(async () => {
  const { walnutHome } = await discoverBrowserFixture(PORT)
  if (PORT === 3456 || !/^walnut-pw-\d+$/.test(path.basename(walnutHome))) throw new Error(`not an isolated fixture: ${walnutHome}`)
  expect((await call('/api/config', 'PUT', { experimental: { real_use_watch: true } })).status).toBe(200)
})

test.afterAll(async () => {
  await call('/api/config', 'PUT', { experimental: { real_use_watch: null } })
})

test('a cut answer is counted, a shipped task names a watch before it closes, and Real Use shows both', async ({ page }) => {
  test.setTimeout(360_000)
  const steps = { steps: [
    // The land a task runs in the background: it counts as a ship from its start.
    { command: '~/walnut-dev/bin/walnut-dev land', output: 'Command running in background with ID: b1' },
    // Claude Code's own note for a Walnut MCP answer it saved to a file instead of passing on.
    { name: 'mcp__walnut__thread_update', input: { id: 'th-1', summary: 'x' }, output: 'Error: result (27,446 characters across 178 lines) exceeds maximum allowed tokens. Output has been saved to /tmp/mcp-result.txt' },
  ], text: 'Landed.' }
  const start = await call('/api/sessions/quick-start', 'POST', { cwd: process.cwd(), message: `bash-steps:${JSON.stringify(steps)}` })
  expect(start.status).toBe(200)
  const { sessionId, taskId } = start.body as { sessionId: string; taskId: string }

  // The recorder writes once a minute.
  await expect.poll(async () => (await rows()).find((r) => r.kind === 'op' && r.name === 'thread_update')?.cut ?? 0, { timeout: 120_000, intervals: [5_000] }).toBe(1)

  // The task's own session closing it: refused, naming what is missing.
  const own = { 'x-walnut-caller-sid': sessionId }
  const refused = await call(`/api/v1/tasks/${taskId}/complete`, 'POST', { result: 'Shipped the change.' }, own)
  expect(refused.status).toBe(409)
  const err = refused.body.error as { code: string; message: string }
  expect(err.code).toBe('no_real_use_watch')
  expect(err.message).toContain('usage_watch {"action":"set"')

  // It arms a watch on what it changed; the close then gets past this check.
  const set = await call('/api/v1/usage-watch', 'POST', { action: 'set', targets: ['op:thread_update'], check_after: '24h' }, own)
  expect(set.status).toBe(200)
  expect((set.body.watch as { task: string }).task).toBe(taskId)
  const again = await call(`/api/v1/tasks/${taskId}/complete`, 'POST', { result: 'Shipped the change.' }, own)
  expect((again.body.error as { code?: string } | undefined)?.code).not.toBe('no_real_use_watch')

  // What the page shows: the tool with its confirmed cut, the alarm state, and the watch.
  const pane = await openRealUse(page)
  // The range sits in the section's header, beside Refresh.
  await page.getByTestId('real-use-range-24h').click()
  const row = pane.locator('[data-testid="real-use-table-op"] tr[data-row="thread_update"]')
  await expect(row).toBeVisible({ timeout: 20_000 })
  // Walnut Health's usage.cut alarm rang on it (one confirmed cut in the hour).
  await expect(row).toContainText('Alarm', { timeout: 120_000 })
  await row.locator('.ru-open').click()
  await expect(pane.getByTestId('real-use-detail')).toBeVisible()
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'real-use-tools.png') })
  const watch = pane.locator('[data-testid="real-use-watches"] tr.ru-watch-row[data-state="watching"]').first()
  await expect(watch).toContainText('op:thread_update')
  await watch.scrollIntoViewIfNeeded()
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'real-use-watches.png') })

  // Search narrows the tools; no match says so.
  await pane.getByTestId('real-use-find').fill('zzz-none')
  await expect(pane.getByTestId('real-use-tools')).toContainText('No tool matches')
  await pane.getByTestId('real-use-find').fill('thread update')
  await expect(row).toBeVisible()
})

test('nothing a page or a tool said is kept: the report holds names and numbers only', async () => {
  const body = JSON.stringify((await call('/api/v1/usage-watch?range=7d', 'GET')).body)
  // The tool call's argument and the note's file path never reach the record.
  expect(body).not.toContain('th-1')
  expect(body).not.toContain('mcp-result.txt')
})
