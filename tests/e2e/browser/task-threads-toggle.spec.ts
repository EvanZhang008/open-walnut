/**
 * A leader task's Threads, turned on from its ⋮ menu (web/src/components/sessions/SessionMenuOpen.tsx,
 * SessionThreadsPane.tsx; Task.threads_on, src/core/org/keeps-threads.ts). 2026-11-18, the user,
 * about a leader task whose asks piled up in one chat: "we should be able to enable the thread for a
 * leader, default off", then "I mean click the more and select to open".
 *
 *   1. A task that leads (a worker under it) offers "Turn on Threads" in its ⋮ menu and has no
 *      Threads chip: off by default.
 *   2. The row turns them on and opens the Threads view beside the chat; the chip appears.
 *   3. His message typed into the leader's chat is filed as a thread (in progress, out of his
 *      sight); once the leader keeps it (thread_update, its session's write) the card shows, and a
 *      Follow up typed on the card is filed under that thread.
 *   4. "Turn off Threads" closes the view, the chip goes, the task stores it off; the next message
 *      is filed nowhere.
 *
 * The chromium and webkit projects share ONE fixture board: every task carries the engine and a stamp.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { closeSessionKebab, openSessionKebab } from './session-kebab-helpers'
import { openKebabGroup } from './kebab-group-helpers'
import { mainComposer } from './threads-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/task-threads`

let fixtureRoot = ''
const litter: string[] = []

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOT_DIR, { recursive: true })
})

test.afterEach(async () => {
  for (const id of [...litter].reverse()) await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  litter.length = 0
})

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

interface ThreadRow { id: string; title: string; state: string; messages: Array<{ text: string }> }
const threadsOf = async (taskId: string): Promise<ThreadRow[]> => (await api<{ threads: ThreadRow[] }>('GET', `/api/v1/tasks/${taskId}/threads`)).threads

/** A row of the session menu's Open group (the menu opened and the group expanded). */
async function openRow(panel: Locator, testId: string): Promise<Locator> {
  const rows = await openKebabGroup(await openSessionKebab(panel), 'session-kebab-open')
  const row = rows.getByTestId(testId)
  await expect(row).toBeVisible({ timeout: 30_000 })
  return row
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

async function quickStart(page: Page, composer: Locator, prompt: string): Promise<{ taskId: string; sessionId: string }> {
  const response = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(prompt)
  await composer.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const out = (await res.json()) as { taskId: string; sessionId: string }
  litter.push(out.taskId)
  return out
}

test('a leader turns Threads on from its menu, files his asks there, and turns them off', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  // ── A leader with a live mock-CLI session, and a worker under it ──
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const { taskId: leader, sessionId } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Garden leader ready')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Garden leader ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await api('PATCH', `/api/tasks/${leader}`, { title: `${engine}-threads-leader ${stamp}` })
  const { task: worker } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `${engine}-threads-worker ${stamp}`, source: 'local', parent_task_id: leader })
  litter.push(worker.id)
  await expect(panel.getByTestId('session-board-chip')).toBeVisible({ timeout: 30_000 })

  // ── 1. Off by default: the menu offers to turn them on, no chip ──
  const chip = panel.getByTestId('session-threads-chip')
  await expect(chip).toHaveCount(0)
  const on = await openRow(panel, 'session-menu-threads')
  await expect(on).toHaveText(/Turn on Threads/)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-1-menu-off.png` })

  // ── 2. The row turns them on and opens the view ──
  await on.click()
  const pane = page.getByTestId('session-threads-pane')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  await expect(chip).toBeVisible()
  await expect(chip).toHaveClass(/session-action-chip-active/)
  await expect.poll(async () => (await api<{ task: { threads_on?: boolean } }>('GET', `/api/tasks/${leader}`)).task.threads_on).toBe(true)
  await expect(pane.getByTestId('org-threads-empty')).toBeVisible()

  // ── 3. His message is filed as a thread; the leader keeps it; a Follow up lands under it ──
  const composer = mainComposer(panel)
  await composer.fill('snapshot-clean-turn:The humidity reading climbs after watering.')
  await composer.press('Enter')
  await expect.poll(async () => (await threadsOf(leader)).length, { timeout: 20_000 }).toBe(1)
  const [thread] = await threadsOf(leader)
  // In progress until the leader writes it up: counted, out of his sight.
  await expect(pane.getByTestId('org-threads-hidden')).toBeVisible({ timeout: 15_000 })
  await api('PATCH', `/api/v1/tasks/${leader}/threads/${thread.id}`,
    { title: 'Greenhouse humidity', reply: 'Humidity climbs to 80 percent after the morning watering; the worker is checking the vent timer.', state: 'answered' },
    { 'x-walnut-caller-sid': sessionId })
  const card = pane.locator(`[data-testid="org-thread"][data-thread-id="${thread.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByTestId('org-thread-title')).toHaveText('Greenhouse humidity')
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-2-thread-card.png` })
  const follow = card.getByTestId('org-thread-follow')
  await follow.getByTestId('org-thread-follow-input').fill('snapshot-clean-turn:Noted, checking the vent.')
  await follow.getByTestId('org-thread-follow-send').click()
  await expect.poll(async () => (await threadsOf(leader)).find((t) => t.id === thread.id)?.messages.length, { timeout: 20_000 }).toBe(2)
  expect(await threadsOf(leader)).toHaveLength(1)

  // ── 4. Turn off: the view closes, the chip goes, the next message is filed nowhere ──
  const off = await openRow(panel, 'session-menu-threads-off')
  await off.click()
  await expect(pane).toHaveCount(0, { timeout: 15_000 })
  await expect(chip).toHaveCount(0)
  await expect.poll(async () => (await api<{ task: { threads_on?: boolean } }>('GET', `/api/tasks/${leader}`)).task.threads_on ?? false).toBe(false)
  await expect(await openRow(panel, 'session-menu-threads')).toHaveText(/Turn on Threads/)
  await closeSessionKebab(panel)
  await composer.fill('snapshot-clean-turn:Compost order noted.')
  await composer.press('Enter')
  await expect(panel.getByText('Compost order noted.', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  const res = await fetch(`${API}/api/v1/tasks/${leader}/threads`)
  expect(res.status).toBe(409)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-3-off.png` })
  expect(pageErrors).toEqual([])
})
