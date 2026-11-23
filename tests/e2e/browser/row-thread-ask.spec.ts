/**
 * A task row draws a decision its thread holds once, as one line that opens the thread
 * (web/src/components/actions/RowThreadAsks.tsx; 2026-11-23, the user, on one question drawn as a
 * thread card and again as a question card, then his pick "两处都改").
 *
 *   1. A task with Threads on asks him (its turn-end report) and Walnut puts the ask on its thread.
 *      Its row in Needs you shows one line, "Needs you" and the thread's title, and no question card.
 *   2. A click on the line opens the task's chat with its Threads beside it, on that thread, marked;
 *      the question is drawn there once, and the top above the chat draws nothing again.
 *   3. With threads_one_card off the row shows the full card as before: nothing is lost.
 * Real: the fixture server, a mock CLI session, the threads routes, the report route, the status sync.
 * TOP_ASK_DATA=<json> plays a real thread (its title, summary, his words, the ask, its options, his
 * flags and window size; the same file top-thread-one-ask.spec.ts reads); PROOF_VIDEO_DIR=<dir> records it.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { asksOf, presetPanelDesign, showSectionCard } from './status-section-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/row-thread-ask`
interface PlayData { title: string; reply: string; words: string; ask: string; ask_more?: string; options?: Array<{ label: string; recommended?: boolean }>; flags?: Record<string, boolean>; viewport?: { width: number; height: number } }
const DATA: PlayData | null = process.env.TOP_ASK_DATA ? JSON.parse(fs.readFileSync(process.env.TOP_ASK_DATA, 'utf8')) as PlayData : null
/** The flags of his that this view reads; the rest of his config stays the fixture's. */
const HIS_FLAGS = ['task_threads', 'threads_sqlite', 'threads_pop_up', 'letters_as_threads', 'reply_thread_line', 'quiet_rail', 'ack_means_known', 'brief_off', 'change_status', 'org_leaders']
const ASK = DATA?.ask ?? `Which cache goes in front of the parts lookup ${STAMP}?`
const TITLE = DATA?.title ?? `Parts lookup cache ${STAMP}`
const made: string[] = []
let flagsBefore: Record<string, boolean> | null = null
let taskId = ''
let sid = ''
let threadId = ''
let askId = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ video: process.env.PROOF_VIDEO_DIR ? 'off' : 'on', viewport: DATA?.viewport ?? { width: 1280, height: 860 } })

async function call<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request[method](url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function setFlags(request: APIRequestContext, flags: Record<string, boolean>): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const now = { ...(cfg.config?.experimental ?? {}) }
  flagsBefore ??= {}
  for (const k of Object.keys(flags)) if (!(k in flagsBefore)) flagsBefore[k] = now[k] === true
  const res = await request.put('/api/config', { data: { experimental: { ...now, ...flags } } })
  expect(res.ok(), await res.text()).toBe(true)
}

const askIdOf = async (request: APIRequestContext): Promise<string> =>
  ((((await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status?.actions ?? []) as Array<{ kind: string; id: string }>).find((a) => a.kind === 'ask')?.id ?? '')
const heldOf = async (request: APIRequestContext): Promise<string> =>
  (((await (await request.get(`/api/v1/tasks/${taskId}/threads`)).json()) as { threads: Array<{ id: string; heldAsk?: { id: string } }> }).threads.find((t) => t.id === threadId)?.heldAsk?.id ?? '')

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const his = Object.fromEntries(HIS_FLAGS.filter((k) => DATA?.flags && k in DATA.flags).map((k) => [k, DATA!.flags![k]!]))
  await setFlags(request, { ...his, top_thread: true, threads_one_card: true, action_needed_everywhere: true })
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: DATA ? 'Interview' : `Parts catalog ${STAMP}`, project: `Workshop ${STAMP}`, source: 'local' })
  taskId = task.id
  made.push(taskId)
  ;({ sessionId: sid } = await call<{ sessionId: string }>(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Catalog ready ${STAMP}`, taskId }))
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? '', { timeout: 90_000 }).toContain(`Catalog ready ${STAMP}`)
  await call(request, 'patch', `/api/tasks/${taskId}`, { threads_on: true })
  const filed = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads`, { text: DATA?.words ?? 'Make the parts lookup fast' })
  threadId = filed.thread.id
  await call(request, 'patch', `/api/v1/tasks/${taskId}/threads/${threadId}`,
    { title: TITLE, reply: DATA?.reply ?? 'The lookup takes 900 ms; a cache brings it under 50 ms.', state: 'answered' },
    { 'x-walnut-caller-sid': sid })
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await call(request, 'put', `/api/v1/tasks/${taskId}/report`, {
    state: 'needs', ask: ASK, ask_more: DATA?.ask_more ?? 'One word is enough.', ask_kind: 'single',
    ask_options: DATA?.options ?? [{ label: 'An in-memory cache', recommended: true }, { label: 'A shared cache server' }],
  })
  await expect.poll(() => askIdOf(request), { timeout: 60_000 }).toMatch(/^ask-/)
  askId = await askIdOf(request)
  await expect.poll(() => heldOf(request), { timeout: 60_000 }).toBe(askId)
})

test.afterAll(async ({ request }) => {
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
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

test('a row draws the question its thread holds as one line that opens the thread; flag off, the card as before', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  const video = await startProofVideo(page)
  await loadHome(page)

  // ── 1. One line on the row, no question card ──
  const row = await showSectionCard(page, 'needs', taskId)
  const below = asksOf(row)
  const line = below.getByTestId('row-thread-ask')
  await expect(line).toHaveCount(1, { timeout: 30_000 })
  await expect(line).toHaveAttribute('data-thread-id', threadId)
  await expect(line).toContainText('Needs you')
  await expect(line).toContainText(TITLE)
  await expect(below.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(0)
  await expect(below.getByText(ASK, { exact: true })).toHaveCount(0)
  // One line: the title wraps when it must, never under or over the mark.
  const [mark, title] = [(await line.locator('.row-thread-ask-mark').boundingBox())!, (await line.locator('.row-thread-ask-title').boundingBox())!]
  expect(title.x).toBeGreaterThanOrEqual(mark.x + mark.width)
  await video.caption('The question its thread holds is one line on the row')
  await line.hover()
  await video.hold(1500)
  await shot(page, '1-row-line')

  // ── 2. The line opens the thread beside the task's chat, marked; the question is drawn there once ──
  await video.caption('One click opens that thread beside the chat')
  await line.click()
  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`).last()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const pane = panel.getByTestId('session-threads-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  const card = pane.locator(`[data-testid="org-thread"][data-thread-id="${threadId}"]`)
  await expect(card).toHaveAttribute('data-focused', 'true', { timeout: 15_000 })
  await expect(card).toBeInViewport()
  await expect(card.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByTestId('top-thread')).toHaveCount(0)
  await expect(panel.getByText(ASK, { exact: true })).toHaveCount(1)
  await video.hold(2000)
  await shot(page, '2-opened')
  await panel.locator('.session-panel-close').first().click()
  await expect(pane).toHaveCount(0, { timeout: 15_000 })

  // ── 3. threads_one_card off: the row shows the full card again ──
  await setFlags(request, { threads_one_card: false })
  await expect(line).toHaveCount(0, { timeout: 30_000 })
  await expect(below.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 30_000 })
  await video.caption('With the switch off, the row shows the full card as before')
  await below.locator(`[data-testid="action-item"][data-item-id="${askId}"]`).hover()
  await video.hold(1500)
  await shot(page, '3-flag-off')
  await setFlags(request, { threads_one_card: true })
  await expect(line).toHaveCount(1, { timeout: 30_000 })
  await video.stop('row-thread-ask')
  expect(errors).toEqual([])
})
