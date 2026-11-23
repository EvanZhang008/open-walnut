/**
 * The question card above a chat folds to one line, and never takes half the window
 * (web/src/components/actions/SessionActionStrip.tsx; 2026-11-23, the user, on a question card that
 * covered half of his small screen in a task with Threads off: asking why it kept appearing, for a
 * way to collapse it, and why Threads off still showed it).
 *
 *   1. A task with Threads off asks him (its turn-end report): above its chat the question card shows,
 *      within a third of the panel's body plus its buttons, never half of it.
 *   2. Hide folds it to one line that names the question; kept over a reload.
 *   3. A new question while folded: the line names the new one, still one line.
 *   4. Show brings the card back.
 * Real: the fixture server, a mock CLI session, the report route, the status sync.
 * STRIP_DATA=<json> plays the user's own question (its words, choices, his flags and window size);
 * PROOF_VIDEO_DIR=<dir> records it (proof-video.ts).
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

interface PlayData { title: string; ask: string; ask_more?: string; options?: Array<{ label: string; recommended?: boolean }>; next_ask?: string; flags?: Record<string, boolean>; viewport?: { width: number; height: number } }
const DATA: PlayData | null = process.env.STRIP_DATA ? JSON.parse(fs.readFileSync(process.env.STRIP_DATA, 'utf8')) as PlayData : null
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/strip-fold`
const ASK = DATA?.ask ?? `Stop this problem here, or fix the code and run it again for a review ${STAMP}?`
const MORE = DATA?.ask_more ?? Array.from({ length: 6 }, (_, i) => `Point ${i + 1}: the model is right, but the code does not run yet and misses a check.`).join(' ')
const NEXT = DATA?.next_ask ?? `Start the next problem with its data model or its API ${STAMP}?`
const OPTIONS = DATA?.options ?? [{ label: 'Stop here, next problem', recommended: true }, { label: 'Fix it, then review' }]
const made: string[] = []
let flagsBefore: Record<string, boolean> | null = null
let taskId = ''
let sid = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ video: process.env.PROOF_VIDEO_DIR ? 'off' : 'on', viewport: DATA?.viewport ?? { width: 1280, height: 800 } })

async function call<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data: unknown): Promise<T> {
  const res = await request[method](url, { data })
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

const askOf = async (request: APIRequestContext): Promise<string> =>
  ((((await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status?.actions ?? []) as Array<{ kind: string; summary: string }>).find((a) => a.kind === 'ask')?.summary ?? '')

async function report(request: APIRequestContext, ask: string): Promise<void> {
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await call(request, 'put', `/api/v1/tasks/${taskId}/report`, { state: 'needs', ask, ask_more: MORE, ask_kind: 'single', ask_options: OPTIONS })
  await expect.poll(() => askOf(request), { timeout: 60_000 }).toBe(ask)
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(420_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await setFlags(request, { ...(DATA?.flags ?? {}), action_needed_everywhere: true })
  const { task } = await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: DATA?.title ?? `Practice round ${STAMP}`, project: `Study ${STAMP}`, source: 'local' })
  taskId = task.id
  made.push(taskId)
  ;({ sessionId: sid } = await call<{ sessionId: string }>(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Round ready ${STAMP}`, taskId }))
  await expect.poll(async () => ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? '', { timeout: 90_000 }).toContain(`Round ready ${STAMP}`)
  // Threads off for this task, as the user had it.
  await call(request, 'patch', `/api/tasks/${taskId}`, { threads_on: false })
  await report(request, ASK)
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

test('the question card above the chat stays within a third of it, folds to one line that names the question, and comes back', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateUiPrefs(page)
  await seedColumns(page, [sid])
  const video = await startProofVideo(page)
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const strip = panel.getByTestId('session-action-needed')
  const card = strip.locator('[data-testid="action-item"][data-kind="ask"]')
  const line = panel.getByTestId('action-strip-line')

  // ── 1. The card, within the top's room: never half of the panel ──
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId('action-summary')).toContainText(ASK.slice(0, 20))
  const body = (await panel.boundingBox())!
  const top = (await panel.getByTestId('session-top').boundingBox())!
  expect(top.height, 'the question takes at most about a third of the panel').toBeLessThanOrEqual(body.height * 0.4)
  await video.caption(DATA ? '问题卡最多占聊天区的三分之一' : 'The question card takes at most a third of the chat')
  await card.hover()
  await video.hold(1500)
  await shot(page, '1-card')

  // ── 2. Hide: one line naming the question; kept over a reload ──
  await video.caption(DATA ? '点 Hide，收成一行' : 'Hide folds it to one line')
  await strip.getByTestId('action-strip-hide').hover()
  await video.hold(600)
  await strip.getByTestId('action-strip-hide').click()
  await expect(line).toBeVisible()
  await expect(line.getByTestId('action-strip-line-title')).toHaveText(ASK)
  await expect(strip).toHaveCount(0)
  const folded = (await panel.getByTestId('session-top').boundingBox())!
  expect(folded.height, 'one line').toBeLessThanOrEqual(60)
  await video.hold(1500)
  await shot(page, '2-folded')
  await page.reload()
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(line).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveCount(0)

  // ── 3. A new question while folded: the line names it ──
  await report(request, NEXT)
  await expect(line.getByTestId('action-strip-line-title')).toHaveText(NEXT, { timeout: 30_000 })
  await expect(card).toHaveCount(0)
  await video.caption(DATA ? '收起后来了新问题：那一行换成新问题，不再弹出整张卡' : 'A new question while folded: the line names it')
  await video.hold(2000)
  await shot(page, '3-new-folded')

  // ── 4. Show brings the card back ──
  await video.caption(DATA ? '点 Show 展开' : 'Show brings it back')
  await panel.getByTestId('action-strip-show').hover()
  await video.hold(600)
  await panel.getByTestId('action-strip-show').click()
  await expect(card).toBeVisible()
  await expect(card.getByTestId('action-summary')).toContainText(NEXT.slice(0, 12))
  await expect(line).toHaveCount(0)
  await video.hold(1500)
  await shot(page, '4-shown')
  await video.stop('strip-fold')
  expect(errors).toEqual([])
})
