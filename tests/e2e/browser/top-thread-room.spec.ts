/**
 * The top of a chat keeps to a third of its panel (experiment top_thread, web/src/styles/top-thread.css;
 * 2026-11-20, the user, on a chat whose top thread card, its long summary unfolded, and two strips
 * above it pushed the whole chat away, only the box left: "one thing takes up all of my space ...
 * at most it should take maybe a third or a half").
 *
 * A task with Threads on in a Home column of a narrow, tall window (his was about 930 x 1550): two
 * letters with long words in the strip, then three threads, the first waiting on him with a long
 * summary and two choices.
 *   1. The top block (.session-top: the strip and the card) is at most a third of the panel's body;
 *      the chat history keeps the rest, in sight. The stepper, the card's choices, its box and its
 *      Snooze are inside the window and inside the top block (never pushed out or covered).
 *   2. The long summary scrolls inside the card (its own scroll, not the page's).
 *   3. A shorter window: still a third of the new height (a share of the body, never a fixed size).
 *   4. Hide makes the top one line; Show brings the card back, held to the same third.
 * Real: the fixture server, a mock CLI session, the threads and inbox routes, the status sync.
 * PROOF_VIDEO_DIR=<dir> records it (proof-video.ts).
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const made: string[] = []
const ids = { task: '', sid: '', thread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/top-thread-room`
let flagsBefore: Record<string, boolean> | null = null
const WHY = { user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes.' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 1550 } })

async function call<T>(request: APIRequestContext, method: 'post' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function setFlags(request: APIRequestContext, flags: Record<string, boolean>): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const now = { ...(cfg.config?.experimental ?? {}) }
  if (flagsBefore === null) flagsBefore = { ...now }
  const res = await request.put('/api/config', { data: { experimental: { ...now, ...flags } } })
  expect(res.ok(), await res.text()).toBe(true)
}

const LONG = Array.from({ length: 14 }, (_, i) => `Step ${i + 1}: the release notes list the memory fix, the signed build and the rollback plan for the ${STAMP} build, with the checks that ran.`).join('\n\n')

const box = async (l: Locator) => (await l.boundingBox())!

/** The top block's height against its panel body's, and what must stay in sight. */
async function measure(page: Page, panel: Locator): Promise<void> {
  const top = panel.getByTestId('session-top')
  const body = panel.locator('.session-panel-body')
  await expect(top).toBeVisible()
  await page.waitForTimeout(300)
  const [t, b] = [await box(top), await box(body)]
  expect(t.height, `top ${t.height} of body ${b.height}`).toBeLessThanOrEqual(b.height / 3 + 1)
  // The chat keeps the rest of the body, in sight.
  const history = panel.locator('.session-history').first()
  await expect(history).toBeVisible()
  expect((await box(history)).height).toBeGreaterThan(b.height / 3)
  // The stepper, the choices, the box and Snooze: in the window and inside the top block.
  const vp = page.viewportSize()!
  const card = panel.getByTestId('top-thread')
  for (const part of [card.getByTestId('top-thread-next'), card.getByTestId('org-answer-option').first(), card.getByTestId('org-thread-follow-input'), card.getByTestId('org-thread-snooze'), card.getByTestId('org-thread-history')]) {
    await expect(part).toBeVisible()
    const p = await box(part)
    expect(p.y).toBeGreaterThanOrEqual(t.y - 1)
    expect(p.y + p.height).toBeLessThanOrEqual(Math.min(t.y + t.height, vp.height) + 1)
  }
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks, threads and settings: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  await setFlags(request, { top_thread: true, action_needed_everywhere: true, letters_as_threads: false })
  ids.task = (await call<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Release room ${STAMP}`, project: `Room ${STAMP}`, source: 'local' })).task.id
  made.push(ids.task)
  await call(request, 'patch', `/api/tasks/${ids.task}`, { threads_on: true })
  await call(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Room ready ${STAMP}`, taskId: ids.task })
  await expect.poll(async () => (ids.sid = (await (await request.get(`/api/tasks/${ids.task}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  // Two letters in the strip, long words each.
  for (const subject of [`Approve the new staging budget for the spring release ${STAMP}?`, `Pick the date for the store listing refresh ${STAMP}?`]) {
    const sent = await request.post('/api/v1/human-inbox', {
      headers: { 'x-walnut-caller-sid': ids.sid },
      data: { subject, type: 'action_required', ...WHY, markdown: LONG.slice(0, 900), actions: [{ id: 'yes', label: 'Yes, go ahead' }, { id: 'no', label: 'Not now' }] },
    })
    expect(sent.status(), await sent.text()).toBe(201)
  }
  // Three threads: the first waits on him, a long summary and two choices.
  for (const title of ['Soil test', 'Seed order']) {
    const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.task}/threads`, { text: `${title} ${STAMP}, how does it stand?` })
    await call(request, 'patch', `/api/v1/tasks/${ids.task}/threads/${thread.id}`, { title: `${title} ${STAMP}`, reply: `${title}: done, the notes are in.`, state: 'answered' })
  }
  const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.task}/threads`, { text: `Release the Mac app ${STAMP}?` })
  ids.thread = thread.id
  await call(request, 'patch', `/api/v1/tasks/${ids.task}/threads/${thread.id}`, {
    title: `Release the Mac app ${STAMP}`, reply: `Release the new Mac app now? I recommend it.\n\n${LONG}`, state: 'needs', ...WHY,
    options: [{ id: 'release', label: 'Release it', recommended: true }, { id: 'hold', label: 'Not yet' }],
  }, ids.sid)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${ids.task}`)).json()).task?.user_status?.actions ?? []).filter((a: { kind: string }) => a.kind === 'letter').length, { timeout: 60_000 }).toBe(2)
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

test('the top keeps to a third of the panel: the long summary scrolls in its card, the chat stays in sight', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const video = await startProofVideo(page)
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const card = panel.getByTestId('top-thread')
  await expect(card).toHaveAttribute('data-thread-id', ids.thread, { timeout: 30_000 })
  await expect(card.getByTestId('top-thread-pos')).toHaveText('1 / 3')
  await expect(panel.getByTestId('session-action-needed').locator('[data-testid="action-item"][data-kind="letter"]')).toHaveCount(2)
  await video.caption('Two letters and a thread with a long summary: the top keeps to a third, the chat stays')

  // 1. A third at most; the chat, the stepper, the choices, the box and Snooze in sight.
  await measure(page, panel)
  await page.screenshot({ path: `${SHOTS}/1-third.png` })
  await video.hold(1500)

  // 2. The long summary scrolls inside the card.
  const summary = card.locator('.org-thread-summary').first()
  const scroll = await summary.evaluate((el) => ({ h: el.scrollHeight, c: el.clientHeight, y: getComputedStyle(el).overflowY }))
  expect(scroll.h, 'the summary is longer than its room').toBeGreaterThan(scroll.c)
  expect(scroll.y).toBe('auto')
  await video.caption('The long summary scrolls inside the card')
  await summary.hover()
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 180); await page.waitForTimeout(150) }
  expect(await summary.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await measure(page, panel)
  await video.hold(1000)

  // 3. A shorter window: a third of the new height.
  await page.setViewportSize({ width: 1280, height: 1000 })
  await video.caption('A shorter window: still a third')
  await measure(page, panel)
  await page.screenshot({ path: `${SHOTS}/2-shorter.png` })
  await video.hold(1000)
  await page.setViewportSize({ width: 1280, height: 1550 })

  // 4. Hide: one line. Show: the card again, held to the same third.
  await video.caption('Hide makes it one line; Show brings it back')
  await card.getByTestId('top-thread-hide').click()
  await expect(card).toHaveAttribute('data-hidden', 'true')
  const hiddenTop = await box(panel.getByTestId('session-top'))
  const body = await box(panel.locator('.session-panel-body'))
  expect(hiddenTop.height).toBeLessThan(body.height / 3)
  await page.screenshot({ path: `${SHOTS}/3-hidden.png` })
  await video.hold(1000)
  await card.getByTestId('top-thread-show').click()
  await expect(card.getByTestId('top-thread-pos')).toHaveText('1 / 3')
  await measure(page, panel)
  await video.hold(1200)
  await video.stop('top-thread-room')
  expect(errors).toEqual([])
})
