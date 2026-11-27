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
 *   2. The top hidden to its line: the line names the question, and the strip does not draw it
 *      (2026-11-23, the user, on a hidden top under the same question in the strip, in his words
 *      "merge these two into one"); shown again, the thread holds it: still one.
 *   2b. The task's Threads view open beside the chat: the ask is in it once, and the top draws no
 *      thread then.
 *   3. With the top thread off (top_thread), the strip draws the ask alone: nothing is lost.
 *   4. Every line of the top card stacks, none drawn over another (2026-11-23, the user's screenshot
 *      at 1512 x 900: the held ask's summary line sat on the "Conversation · 1 message" toggle), on
 *      every kind of card the top holds (the held ask with its choices, a needs thread with options,
 *      a thread whose words he has not read, a decision letter, an answered one), folded and
 *      unfolded, through a sweep of window heights at 1512 wide (each room level and the steps
 *      between them) and on a phone. The check finds the lines on the live page
 *      (text-overlap-check.ts), so a line added to a card later is held to it too.
 * Real: the fixture server, a mock CLI session, the threads routes, the report route, the status sync.
 * TOP_ASK_DATA=<json> plays a real thread (its title, summary, his words, the ask, the flags and the
 * window size of the user's own); PROOF_VIDEO_DIR=<dir> records it (proof-video.ts).
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'
import { PHONE } from './phone-helpers'
import { expectNoTextOverlap } from './text-overlap-check'
import { serverFlags } from './server-flags'

interface PlayOption { label: string; recommended?: boolean }
/** A real thread to play: what the user's own Interview task showed (TOP_ASK_DATA). */
interface PlayData { title: string; reply: string; words: string; ask: string; ask_more?: string; options?: PlayOption[]; second?: { title: string; words: string; reply: string }; flags?: Record<string, boolean>; viewport?: { width: number; height: number }; captions?: Partial<Record<CaptionKey, string>> }
/** The video's captions; the data may give them in the user's language. */
const CAPTIONS = {
  once: 'The question the thread holds shows once above the chat',
  other: 'On another thread, the bar says where the question is; the arrows stay put',
  back: 'One click steps back to the question',
  hide: 'The × folds the top to one line',
  hidden: 'Hidden: one line names the question; the strip does not draw it again',
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
// Two choices, as the user's own card had: the card reaches the height where its lines crowded.
const OPTIONS: PlayOption[] = DATA?.options ?? [{ label: 'A token bucket per client', recommended: true }, { label: 'A fixed window per route' }]
const made: string[] = []
// Every flag it sets is put back exactly as it was, unset included (server-flags.ts).
const flagLedger = serverFlags()
let taskId = ''
let sid = ''
let threadId = ''
let askId = ''
let letterId = ''
/** The other kinds of card the top holds, made by `otherKinds` (test 4). */
const kinds = { needs: '', unread: '', letter: '' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ video: process.env.PROOF_VIDEO_DIR ? 'off' : 'on', viewport: DATA?.viewport ?? { width: 1280, height: 860 } })

async function call<T>(request: APIRequestContext, method: 'post' | 'patch' | 'put', url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request[method](url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function setFlags(request: APIRequestContext, flags: Record<string, boolean>): Promise<void> {
  await flagLedger.set(request, flags)
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
  await call(request, 'put', `/api/v1/tasks/${taskId}/report`, { state: 'needs', ask: ASK, ask_more: DATA?.ask_more ?? 'One sentence is enough.', ask_kind: 'single', ask_options: OPTIONS })
  await expect.poll(() => askIdOf(request), { timeout: 60_000 }).toMatch(/^ask-/)
  askId = await askIdOf(request)
  await expect.poll(() => heldOf(request), { timeout: 60_000 }).toBe(askId)
})

test.afterAll(async ({ request }) => {
  await flagLedger.restore(request)
  if (letterId) await request.post(`/api/v1/human-inbox/${letterId}/archive`, { data: { archived: true } }).catch(() => {})
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

  // ── 2. The top hidden to its line: the line names the ask, the strip does not draw it; shown again, the thread holds it ──
  await video.caption(caption('hide'))
  await top.getByTestId('top-thread-hide').hover()
  await video.hold(800)
  await top.getByTestId('top-thread-hide').click()
  await expect(panel.getByTestId('top-thread-show')).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByTestId('top-thread-hidden-title')).toHaveText(DATA?.title ?? `System design quiz ${STAMP}`, { timeout: 15_000 })
  await expect(ofAsk).toHaveCount(0)
  await expect(strip.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(0)
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
  // The task's Threads view open beside the chat holds the ask: once, there, and not above the chat.
  await panel.getByTestId('session-threads-chip').click()
  const pane = panel.getByTestId('session-threads-pane')
  await expect(pane.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(1, { timeout: 15_000 })
  await expect(panel.getByTestId('session-top').locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toHaveCount(0)
  await expect(ofAsk).toHaveCount(1)
  await panel.getByTestId('session-threads-chip').click()
  await expect(top.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible({ timeout: 15_000 })

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

/** The other kinds of card the top holds, beside the held ask and the answered one of test 1: a
 *  needs thread with options, a thread the node opened that he has not read yet, a decision letter. */
async function otherKinds(request: APIRequestContext): Promise<void> {
  if (kinds.letter) return
  const why = { user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes.', separate_reason: 'Each card here is a decision of its own.' }
  const caller = { 'x-walnut-caller-sid': sid }
  kinds.needs = (await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads/open`, {
    title: `Mock round day ${STAMP}`, text: 'When do you want the mock round?', state: 'needs', from: 'node', ...why,
    options: [{ id: 'tue', label: 'Tuesday evening', recommended: true }, { id: 'sat', label: 'Saturday morning' }],
  }, caller)).thread.id
  await call(request, 'patch', `/api/v1/tasks/${taskId}/threads/${kinds.needs}`, { reply: 'Pick the day for the mock round; Tuesday leaves two days to review it.', state: 'needs', ...why }, caller)
  // No summary yet: its opener is words he has not read, under their own fold.
  kinds.unread = (await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${taskId}/threads/open`, {
    title: `Graded answer ${STAMP}`, text: 'The rate limiter answer scored 8 of 10: the burst case was missing, the rest was clear and well paced.', state: 'answered', from: 'node',
  }, caller)).thread.id
  await setFlags(request, { letters_as_threads: true })
  letterId = (await call<{ id: string }>(request, 'post', '/api/v1/human-inbox', {
    subject: `Book the onsite travel ${STAMP}?`, type: 'action_required', markdown: 'The loop is on the 4th; flights are cheapest booked this week.',
    actions: [{ id: 'book', label: 'Book it' }, { id: 'wait', label: 'Wait a week' }], user_kind: 'user_own', user_kind_why: 'He spends his own money on travel',
  }, caller)).id
  await expect.poll(async () => {
    const file = await (await request.get(`/api/v1/tasks/${taskId}/threads`)).json() as { threads: Array<{ id: string; letter?: { id: string } }> }
    return (kinds.letter = file.threads.find((t) => t.letter?.id === letterId)?.id ?? '')
  }, { timeout: 30_000 }).not.toBe('')
}

/** Steps the top from its first card to its last, running `each` on every one; the ids it showed. */
async function eachCard(top: Locator, each: (id: string) => Promise<void>): Promise<string[]> {
  const prev = top.getByTestId('top-thread-prev')
  while (await prev.isEnabled()) await prev.click()
  const seen: string[] = []
  for (;;) {
    const id = (await top.getAttribute('data-thread-id')) ?? ''
    seen.push(id)
    await each(id)
    const next = top.getByTestId('top-thread-next')
    if (!(await next.isEnabled())) return seen
    await next.click()
    await expect(top).not.toHaveAttribute('data-thread-id', id)
  }
}

/** Steps the top to the card of thread `id`. */
async function stepTo(top: Locator, id: string): Promise<void> {
  const prev = top.getByTestId('top-thread-prev')
  while (await prev.isEnabled()) await prev.click()
  while ((await top.getAttribute('data-thread-id')) !== id && await top.getByTestId('top-thread-next').isEnabled()) await top.getByTestId('top-thread-next').click()
  await expect(top).toHaveAttribute('data-thread-id', id)
}

/** The card on show, folded and then unfolded (its unread words, its conversation), at each size:
 *  no line of the whole top (the strip and the card) is drawn over another. */
async function stacksAtEverySize(page: Page, panel: Locator, sizes: ReadonlyArray<{ width: number; height: number }>, id: string): Promise<void> {
  const room = panel.getByTestId('session-top')
  const top = panel.getByTestId('top-thread')
  for (const folded of [true, false]) {
    if (!folded) {
      // Unfolded where everything shows (the tallest size), then held through the sweep.
      await page.setViewportSize(sizes[0]!)
      for (const toggle of [top.getByTestId('org-thread-unread-toggle'), top.getByTestId('org-thread-history')]) {
        if (await toggle.isVisible() && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      }
    }
    for (const size of sizes) {
      await page.setViewportSize(size)
      await expectNoTextOverlap(room, `${folded ? 'folded' : 'unfolded'} card ${id} at ${size.width} x ${size.height}`)
    }
  }
  // Back to the tallest size: the shortest folds the stepper away (data-room min), and the next card is a step away.
  await page.setViewportSize(sizes[0]!)
}

const heights = (from: number, to: number, step: number) => Array.from({ length: Math.floor((from - to) / step) + 1 }, (_, i) => from - i * step)

test('every line of the top card stacks, on every kind of card, in every room at 1512 wide', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await setFlags(request, { top_thread: true })
  await otherKinds(request)
  await page.setViewportSize({ width: 1512, height: 900 })
  await isolateUiPrefs(page)
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const top = panel.getByTestId('top-thread')
  await expect(top.getByTestId('top-thread-pos')).toHaveText(/\/ [4-9]$/, { timeout: 30_000 })
  // His window: the card that holds the ask, as he saw it.
  await stepTo(top, threadId)
  await expect(top.locator(`[data-testid="action-item"][data-item-id="${askId}"]`)).toBeVisible()
  await expectNoTextOverlap(panel.getByTestId('session-top'), 'the held ask at 1512 x 900')
  fs.mkdirSync(SHOTS, { recursive: true })
  await top.screenshot({ path: `${SHOTS}/5-stacks-1512x900.png` })
  const sizes = heights(1000, 600, 25).map((height) => ({ width: 1512, height }))
  const seen = await eachCard(top, (id) => stacksAtEverySize(page, panel, sizes, id))
  expect(seen).toEqual(expect.arrayContaining([threadId, kinds.needs, kinds.unread, kinds.letter]))
  expect(errors).toEqual([])
})

test.describe('on a phone', () => {
  test.use({ viewport: PHONE.viewport, screen: PHONE.screen, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PHONE.userAgent })

  test('every line of the top card stacks, on every kind of card, at a phone width', async ({ page, request }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await setFlags(request, { top_thread: true })
    await otherKinds(request)
    await isolateUiPrefs(page)
    await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
    await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
    const title = DATA ? 'Interview' : `Interview ${STAMP}`
    await page.getByRole('region', { name: /Needs you/ }).getByRole('button', { name: new RegExp(`^${title}`) }).first().click()
    const panel = page.locator(`.session-panel.is-phone-layer[data-session-id="${sid}"]`)
    const top = panel.getByTestId('top-thread')
    await expect(top.getByTestId('top-thread-pos')).toHaveText(/\/ [4-9]$/, { timeout: 60_000 })
    // A 390-wide phone, its full height down to a short one (the room folds level by level).
    const sizes = heights(844, 564, 40).map((height) => ({ width: 390, height }))
    const seen = await eachCard(top, (id) => stacksAtEverySize(page, panel, sizes, id))
    expect(seen).toEqual(expect.arrayContaining([threadId, kinds.needs, kinds.unread, kinds.letter]))
    // The card that holds the ask, as he reads it on the phone.
    await stepTo(top, threadId)
    await top.screenshot({ path: `${SHOTS}/6-stacks-phone.png` })
    expect(errors).toEqual([])
  })
})
