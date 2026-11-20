/**
 * A task's own ask lives on its thread: one card (src/core/org/thread-report-ask.ts; 2026-11-20,
 * the user, on a task with Threads on: its one thread read "Done" in the Threads pane while the chat
 * above held the task's ask card waiting for him, "the same thing shows twice, one says Done and
 * the other waits for him").
 *
 *   1. Threads pane open beside the chat: the thread card reads Needs you and IS the ask (its
 *      question, its words box, the thread's own summary under it), one card of it in the pane;
 *      nothing reads Done.
 *   2. The ask answered in the thread card: the words reach the task's session, filed under that
 *      thread, and the card is no ask any more.
 * (The strip above the chat is redesigned on its own: this spec does not judge it.)
 * Real: the fixture server, a mock CLI session, the threads routes, the report route, the status sync.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const SHOT_DIR = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/thread-holds-ask`
const ASK = `Design the donation tables and their API ${STAMP}?`
const made: string[] = []
let taskId = ''
let sid = ''
let threadId = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 }, video: process.env.PW_VIDEO ? 'on' : 'off' })

async function call<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request[method](url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

type Thread = { id: string; state: string; heldAsk?: { id: string }; messages: Array<{ text: string }> }
const threadsOf = async (request: APIRequestContext): Promise<Thread[]> =>
  ((await (await request.get(`/api/v1/tasks/${taskId}/threads`)).json()) as { threads: Thread[] }).threads
const askIdOf = async (request: APIRequestContext): Promise<string> =>
  ((((await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status?.actions ?? []) as Array<{ kind: string; id: string }>).find((a) => a.kind === 'ask')?.id ?? '')

const panelOf = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
const cardOf = (pane: Locator) => pane.locator(`[data-testid="org-thread"][data-thread-id="${threadId}"]`)

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Interview practice ${STAMP}`, project: `Study ${STAMP}`, source: 'local' })
  taskId = task.id
  made.push(taskId)
  ;({ sessionId: sid } = await call<{ sessionId: string }>(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Practice ready ${STAMP}`, taskId }))
  // Its turn ends first, so its own turn-end report cannot overwrite the ask below.
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? '', { timeout: 90_000 }).toContain(`Practice ready ${STAMP}`)
  await call(request, 'patch', `/api/tasks/${taskId}`, { threads_on: true })
  // His request, filed as a thread, which the task answered (the case: it read "Done").
  const filed = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads`, { text: 'Let us do system design practice 2' })
  threadId = filed.thread.id
  await call(request, 'patch', `/api/v1/tasks/${taskId}/threads/${threadId}`,
    { title: `System design practice 2 ${STAMP}`, reply: 'Walked through the donation flow; next step: you design the tables and API.', state: 'answered' },
    { 'x-walnut-caller-sid': sid })
  // Then the task asks him (a report set from outside its turn): Walnut puts it on that thread.
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await call(request, 'put', `/api/v1/tasks/${taskId}/report`, { state: 'needs', ask: ASK, ask_more: 'Two tables at least, and the endpoints that write them.' })
  await expect.poll(() => askIdOf(request), { timeout: 60_000 }).toMatch(/^ask-/)
  const askId = await askIdOf(request)
  await expect.poll(async () => (await threadsOf(request)).find((t) => t.id === threadId)?.heldAsk?.id ?? '', { timeout: 60_000 }).toBe(askId)
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('one card: the thread holds the ask beside the chat, and an answer there reaches the session', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = panelOf(page)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const askId = await askIdOf(request)

  // ── 1. Pane open: the thread card is the ask ──
  const chip = panel.getByTestId('session-threads-chip')
  await chip.click()
  const pane = page.getByTestId('session-threads-pane')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  const card = cardOf(pane)
  await expect(card).toHaveAttribute('data-state', 'needs', { timeout: 15_000 })
  await expect(card).toHaveAttribute('data-held-ask', askId)
  await expect(card.getByTestId('org-thread-state')).toHaveText('Needs you')
  const ask = card.locator(`[data-testid="action-item"][data-kind="ask"][data-item-id="${askId}"]`)
  await expect(ask.getByTestId('action-summary')).toHaveText(ASK)
  await expect(ask.getByTestId('org-answer-input')).toBeVisible()
  // The thread's own summary stays under the question; no box or Snooze of the thread's own beside the ask's.
  await expect(card.getByTestId('org-thread-reply')).toContainText('next step: you design the tables and API')
  await expect(card.getByTestId('org-thread-follow-open')).toHaveCount(0)
  // One card of this decision in the pane, and nothing reads Done.
  await expect(pane.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(1)
  await expect(pane.getByTestId('org-thread-state').filter({ hasText: /^Done$/ })).toHaveCount(0)
  await page.screenshot({ path: `${SHOT_DIR}/1-pane-open.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })

  // ── 2. Answered in the thread card: the session gets it, filed under the thread ──
  const words = `snapshot-clean-turn:Tables donation and donor, POST /donations ${STAMP}`
  await cardOf(pane).locator('[data-testid="action-item"][data-kind="ask"]').getByTestId('org-answer-input').fill(words)
  await cardOf(pane).locator('[data-testid="action-item"][data-kind="ask"]').getByTestId('org-answer-send').click()
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? '', { timeout: 60_000 }).toContain(`POST /donations ${STAMP}`)
  await expect.poll(async () => (await threadsOf(request)).find((t) => t.id === threadId)?.messages.some((m) => m.text.includes(`POST /donations ${STAMP}`)) ?? false, { timeout: 30_000 }).toBe(true)
  // His answer took the ask off: the card is no ask any more, and no second card came back.
  await expect.poll(async () => (await threadsOf(request)).find((t) => t.id === threadId)?.heldAsk?.id ?? '', { timeout: 60_000 }).toBe('')
  await expect(cardOf(pane).locator('[data-testid="action-item"]')).toHaveCount(0, { timeout: 30_000 })
  await page.screenshot({ path: `${SHOT_DIR}/2-answered.png` })
  expect(errors).toEqual([])
})
