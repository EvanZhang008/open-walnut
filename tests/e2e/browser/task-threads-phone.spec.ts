/**
 * A leader task's Threads on the phone layout (web/src/components/sessions/PhoneSessionHeaderRows.tsx,
 * the same switch as the desktop menu's Open group: session-threads-model.ts). 2026-11-18, Walnut VP
 * for the user: the phone needs "⋮ › Turn on/off Threads" and the Threads view too.
 *
 *   1. The top bar's ⋮ on a leader's session offers "Turn on Threads"; it turns them on and opens
 *      the Threads view as a phone layer.
 *   2. Back to the chat, his message there is filed as a thread; once the leader keeps it, the ⋮'s
 *      "Threads" row shows its card.
 *   3. "Turn off Threads" stores them off and the row offers to turn them on again.
 *
 * The chromium and webkit projects share ONE fixture board: every task carries the engine and a stamp.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { PHONE, backButton } from './phone-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/task-threads`

let fixtureRoot = ''
const litter: string[] = []

test.use({ viewport: PHONE.viewport, screen: PHONE.screen, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PHONE.userAgent })

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

interface ThreadRow { id: string; title: string; messages: Array<{ text: string }> }
const threadsOf = async (taskId: string): Promise<ThreadRow[]> => (await api<{ threads: ThreadRow[] }>('GET', `/api/v1/tasks/${taskId}/threads`)).threads
const threadsOn = async (taskId: string): Promise<boolean> => (await api<{ task: { threads_on?: boolean } }>('GET', `/api/tasks/${taskId}`)).task.threads_on ?? false

/** The top bar's ⋮ and one of its rows. */
async function phoneRow(page: Page, testId: string) {
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  const row = page.getByTestId(testId)
  await expect(row).toBeVisible({ timeout: 30_000 })
  return row
}

test('the phone ⋮ turns a leader\'s Threads on, shows them, and turns them off', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-phone-garden-${stamp}`
  const title = `${engine}-phone-leader ${stamp}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  // ── A leader with a session (mock CLI) and a worker under it ──
  const { task: leader } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, project, source: 'local' })
  litter.push(leader.id)
  const { task: worker } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `${engine}-phone-worker ${stamp}`, project, source: 'local', parent_task_id: leader.id })
  litter.push(worker.id)
  const { sessionId } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Garden leader ready', taskId: leader.id })

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  // A fresh leader with a session sits in the phone's Needs you section: a thumb taps its row.
  const row = page.getByRole('region', { name: /Needs you/ }).getByRole('button', { name: new RegExp(`^${title}`) }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  const layer = page.locator(`.session-panel.is-phone-layer[data-session-id="${sessionId}"]`)
  await expect(layer.getByText('Garden leader ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })

  // ── 1. Off: the ⋮ offers to turn them on; the row opens the view ──
  const on = await phoneRow(page, 'phone-row-threads')
  await expect(on).toHaveText(/Turn on Threads/)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-phone-1-menu.png` })
  await on.click()
  const pane = page.getByTestId('session-threads-pane')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => threadsOn(leader.id)).toBe(true)
  await expect(pane.getByTestId('org-threads-empty')).toBeVisible()

  // ── 2. Back to the chat; his message is filed; the leader keeps it; the card shows ──
  await backButton(page).click()
  await expect(pane).toHaveCount(0)
  const composer = layer.locator('.session-panel-input:not(.tree-split-input) .chat-input-textarea')
  await composer.fill('snapshot-clean-turn:The seedlings need more light.')
  await layer.locator('.session-panel-input:not(.tree-split-input) .chat-send-btn-icon').click()
  await expect.poll(async () => (await threadsOf(leader.id)).length, { timeout: 20_000 }).toBe(1)
  const [thread] = await threadsOf(leader.id)
  await api('PATCH', `/api/v1/tasks/${leader.id}/threads/${thread.id}`,
    { title: 'Seedling light', reply: 'The seedlings get four hours of light; a grow lamp on a timer would double it.', state: 'answered' },
    { 'x-walnut-caller-sid': sessionId })
  await (await phoneRow(page, 'phone-row-threads')).click()
  await expect(pane).toBeVisible({ timeout: 15_000 })
  const card = pane.locator(`[data-testid="org-thread"][data-thread-id="${thread.id}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByTestId('org-thread-title')).toHaveText('Seedling light')
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-phone-2-card.png` })

  // ── 3. Turn off from the chat's ⋮ (the Threads layer's own bar holds Back, as the Board's does) ──
  await backButton(page).click()
  await expect(pane).toHaveCount(0)
  await (await phoneRow(page, 'phone-row-threads-off')).click()
  await expect.poll(() => threadsOn(leader.id)).toBe(false)
  await expect(pane).toHaveCount(0, { timeout: 15_000 })
  await expect(await phoneRow(page, 'phone-row-threads')).toHaveText(/Turn on Threads/)
  expect(pageErrors).toEqual([])
})
