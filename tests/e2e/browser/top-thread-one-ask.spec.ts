/**
 * One decision is drawn once above the chat (web/src/components/org/top-thread-model.ts
 * actionsNotThreads, HELD_BY_THREAD; 2026-11-21, the user, on the Interview task: the top card and
 * "1 thread (1 needs you) · Show"; Show drew the same question twice, once in the task's own
 * Action needed strip and once in the thread above the chat that holds it).
 *
 *   1. A task with Threads on asks him (its turn-end report), and Walnut puts the ask on its thread:
 *      above the chat the thread card holds the ask, and the strip does not draw it again. One card
 *      of the decision in the whole panel.
 *   1b. A second thread for him: on it, the bar names the decision on the other thread and steps
 *      to it; the strip never redraws it, so the arrows stay where they were (review 2026-11-22).
 *   2. The top hidden to its line: the strip draws the ask (hiding never hides a question); shown
 *      again, the thread holds it: still one.
 *   3. With the top thread off (top_thread), the strip draws the ask alone: nothing is lost.
 * Real: the fixture server, a mock CLI session, the threads routes, the report route, the status sync.
 * TOP_ASK_DATA=<json> plays a real thread (its title, summary, his words, the ask, the flags and the
 * window size of the user's own); PROOF_VIDEO_DIR=<dir> records it (proof-video.ts).
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

/** A real thread to play: what the user's own Interview task showed (TOP_ASK_DATA). */
interface PlayData { title: string; reply: string; words: string; ask: string; ask_more?: string; second?: { title: string; words: string; reply: string }; flags?: Record<string, boolean>; viewport?: { width: number; height: number }; captions?: Partial<Record<CaptionKey, string>> }
/** The video's captions; the data may give them in the user's language. */
const CAPTIONS = {
  once: 'The question the thread holds shows once above the chat',
  other: 'On another thread, the bar says where the question is; the arrows stay put',
  back: 'One click steps back to the question',
  hide: 'Hide the top: it folds to one line',
  hidden: 'Hidden: the question still shows, once, in the strip',
  show: 'Show brings the thread back: still one question',
  off: 'With the top thread switched off, the strip shows it alone',
}
type CaptionKey = keyof typeof CAPTIONS
const DATA: PlayData | null = process.env.TOP_ASK_DATA ? JSON.parse(fs.readFileSync(process.env.TOP_ASK_DATA, 'utf8')) as PlayData : null
const caption = (k: CaptionKey): string => DATA?.captions?.[k] ?? CAPTIONS[k]
/** The flags of his that this view reads; the rest of his config stays the fixture's. */
const HIS_FLAGS = ['task_threads', 'threads_sqlite', 'threads_pop_up', 'letters_as_threads', 'reply_thread_line', 'quiet_rail', 'ack_means_known', 'brief_off', 'change_status', 'org_leaders']

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/top-thread-one-ask`
const ASK = DATA?.ask ?? `Which rate limiter do you put in front of the API ${STAMP}?`
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
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: DATA ? 'Interview' : `Interview ${STAMP}`, project: `Study ${STAMP}`, source: 'local' })
  taskId = task.id
  made.push(taskId)
  ;({ sessionId: sid } = await call<{ sessionId: string }>(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Practice ready ${STAMP}`, taskId }))
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? '', { timeout: 90_000 }).toContain(`Practice ready ${STAMP}`)
  await call(request, 'patch', `/api/tasks/${taskId}`, { threads_on: true })
  const filed = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads`, { text: DATA?.words ?? 'Quiz me on system design' })
  threadId = filed.thread.id
  await call(request, 'patch', `/api/v1/tasks/${taskId}/threads/${threadId}`,
    { title: DATA?.title ?? `System design quiz ${STAMP}`, reply: DATA?.reply ?? 'Next question: the rate limiter.', state: 'answered' },
    { 'x-walnut-caller-sid': sid })
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await call(request, 'put', `/api/v1/tasks/${taskId}/report`, { state: 'needs', ask: ASK, ask_more: DATA?.ask_more ?? 'One sentence is enough.' })
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

test('the decision a thread holds is drawn once above the chat; with the top off the strip still draws it', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateUiPrefs(page)
  await seedColumns(page, [sid])
  const video = await startProofVideo(page)
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const top = panel.getByTestId('top-thread')
  const ofAsk = panel.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)
  const strip = panel.getByTestId('session-action-needed')

  // ── 1. The thread above the chat holds the ask; the strip does not draw it again ──
  await expect(top).toHaveAttribute('data-thread-id', threadId, { timeout: 30_000 })
  await expect(top.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(ofAsk).toHaveCount(1)
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(0)
  await expect(panel.getByText(ASK, { exact: true })).toHaveCount(1)
  await video.caption(caption('once'))
  await top.locator(`[data-testid="action-item"][data-item-id="${askId}"]`).hover()
  await video.hold(1500)
  await shot(page, '1-once')

  // ── 1b. A second thread: on it the bar names the decision and steps to it; the strip never redraws it ──
  const second = DATA?.second ?? { title: 'Potting soil', words: 'And the potting soil?', reply: 'Ordered two 50 L bags, here on Tuesday.' }
  const other = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads`, { text: second.words })
  await call(request, 'patch', `/api/v1/tasks/${taskId}/threads/${other.thread.id}`, { title: second.title, reply: second.reply, state: 'answered' }, { 'x-walnut-caller-sid': sid })
  await expect(top.getByTestId('top-thread-pos')).toHaveText(/\/ 2$/, { timeout: 30_000 })
  if ((await top.getAttribute('data-thread-id')) === threadId) {
    const before = await top.getByTestId('top-thread-next').boundingBox()
    await top.getByTestId('top-thread-next').hover()
    await top.getByTestId('top-thread-next').click()
    await expect(top).toHaveAttribute('data-thread-id', other.thread.id, { timeout: 15_000 })
    // The arrows stay where they were: nothing above the top grew or shrank.
    expect((await top.getByTestId('top-thread-next').boundingBox())?.y).toBe(before?.y)
  } else {
    await expect(top).toHaveAttribute('data-thread-id', other.thread.id)
  }
  await expect(ofAsk).toHaveCount(0)
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(0)
  const pointer = top.getByTestId('top-thread-elsewhere')
  await expect(pointer).toBeVisible({ timeout: 15_000 })
  await expect(pointer).toHaveText(/Decision on [12] \/ 2/)
  await video.caption(caption('other'))
  await pointer.hover()
  await video.hold(1500)
  await shot(page, '1b-other')
  await video.caption(caption('back'))
  const atPointer = await top.getByTestId('top-thread-prev').boundingBox()
  await pointer.click()
  await expect(top).toHaveAttribute('data-thread-id', threadId, { timeout: 15_000 })
  expect((await top.getByTestId('top-thread-prev').boundingBox())?.y).toBe(atPointer?.y)
  await expect(ofAsk).toHaveCount(1)
  await expect(pointer).toHaveCount(0)
  await video.hold(1200)

  // ── 2. The top hidden to its line: the strip draws the ask, once; shown again, the thread holds it ──
  await video.caption(caption('hide'))
  await top.getByTestId('top-thread-hide').hover()
  await video.hold(800)
  await top.getByTestId('top-thread-hide').click()
  await expect(panel.getByTestId('top-thread-show')).toBeVisible({ timeout: 15_000 })
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(ofAsk).toHaveCount(1)
  await video.caption(caption('hidden'))
  await video.hold(1500)
  await shot(page, '2-hidden')
  await video.caption(caption('show'))
  await panel.getByTestId('top-thread-show').hover()
  await video.hold(800)
  await panel.getByTestId('top-thread-show').click()
  await expect(top.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(ofAsk).toHaveCount(1)
  await video.hold(1500)
  await shot(page, '3-shown')

  // ── 3. The top thread off: the strip draws the ask, once ──
  await setFlags(request, { top_thread: false })
  await expect(top).toHaveCount(0, { timeout: 30_000 })
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 30_000 })
  await expect(ofAsk).toHaveCount(1)
  await video.caption(caption('off'))
  await video.hold(1500)
  await shot(page, '4-top-off')
  await video.stop(DATA ? 'top-thread-one-ask-his-data' : 'top-thread-one-ask')
  expect(errors).toEqual([])
})
