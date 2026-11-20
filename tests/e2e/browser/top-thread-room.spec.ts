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
 *   6. A 1280 x 800 window (2026-11-20, the proof recording: the stepper, head, box and buttons
 *      filled the third and the summary got 0 px): the summary keeps at least two lines, the top
 *      growing to at most a half for it; "Conversation" opens a list that shows and scrolls inside
 *      the card, the top still within a half.
 *   5. A phone with its keyboard up (2026-11-20 review: the body shrinks to a few lines while the
 *      stepper, the choices and the box kept their size and ran over the chat): the strip and the
 *      card's words fold away, the box he types in stays in sight, and nothing runs over the chat.
 * Real: the fixture server, a mock CLI session, the threads and inbox routes, the status sync.
 * PROOF_VIDEO_DIR=<dir> records it (proof-video.ts).
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'
import { PHONE, setKeyboardInset } from './phone-helpers'
import { restoreOneCard, setOneCard } from './one-card-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const made: string[] = []
// Its cards are the one-card experiment's (threads_one_card): on for this spec, put back after it.
let oneCardWas: boolean | null = null
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
  // Each flag it sets, as it was (unset reads false): config writes merge, so putting back the
  // whole map read before would leave a flag it turned on still on for the next spec.
  flagsBefore ??= {}
  for (const k of Object.keys(flags)) if (!(k in flagsBefore)) flagsBefore[k] = now[k] === true
  const res = await request.put('/api/config', { data: { experimental: { ...now, ...flags } } })
  expect(res.ok(), await res.text()).toBe(true)
}

const LONG = Array.from({ length: 14 }, (_, i) => `Step ${i + 1}: the release notes list the memory fix, the signed build and the rollback plan for the ${STAMP} build, with the checks that ran.`).join('\n\n')

const box = async (l: Locator) => (await l.boundingBox())!

/** How much of a block shows, in lines of its own text, and whether it scrolls inside itself. */
async function linesShown(l: Locator): Promise<{ lines: number; scrolls: boolean; overflow: string }> {
  return l.evaluate((el) => {
    const cs = getComputedStyle(el)
    const line = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.45
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    return { lines: (el.clientHeight - pad) / line, scrolls: el.scrollHeight > el.clientHeight + 1, overflow: cs.overflowY }
  })
}

/** The top block's height against its panel body's (a third, or a half when the summary's floor
 *  needs it), the summary's lines, and what must stay in sight. */
async function measure(page: Page, panel: Locator, share: 3 | 2 = 3): Promise<void> {
  const top = panel.getByTestId('session-top')
  const body = panel.locator('.session-panel-body')
  await expect(top).toBeVisible()
  await page.waitForTimeout(300)
  await expect(top).toHaveAttribute('data-room', 'full')
  const [t, b] = [await box(top), await box(body)]
  expect(t.height, `top ${t.height} of body ${b.height}`).toBeLessThanOrEqual(b.height / share + 1)
  // The words he must read: at least two lines of the summary, inside the top block.
  const summary = panel.getByTestId('top-thread').locator('.org-thread-summary').first()
  await expect(summary).toBeVisible()
  expect((await linesShown(summary)).lines, 'the summary shows at least two lines').toBeGreaterThanOrEqual(2)
  const s = await box(summary)
  expect(s.y + s.height).toBeLessThanOrEqual(t.y + t.height + 1)
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
  oneCardWas = await setOneCard(request, true)
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
  const { thread } = await call<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.task}/threads`, { text: `Release the Mac app ${STAMP}? ${LONG.slice(0, 700)}` })
  ids.thread = thread.id
  await call(request, 'patch', `/api/v1/tasks/${ids.task}/threads/${thread.id}`, {
    title: `Release the Mac app ${STAMP}`, reply: `Release the new Mac app now? I recommend it.\n\n${LONG}`, state: 'needs', ...WHY,
    options: [{ id: 'release', label: 'Release it', recommended: true }, { id: 'hold', label: 'Not yet' }],
  }, ids.sid)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${ids.task}`)).json()).task?.user_status?.actions ?? []).filter((a: { kind: string }) => a.kind === 'letter').length, { timeout: 60_000 }).toBe(2)
})

test.afterAll(async ({ request }) => {
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
  await restoreOneCard(request, oneCardWas)
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

  // 3. A shorter window: a share of the new height (a half at most, for the summary's lines).
  await page.setViewportSize({ width: 1280, height: 1000 })
  await video.caption('A shorter window: a third, or a half so the summary keeps its lines')
  await measure(page, panel, 2)
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

test('a 1280 x 800 window: the summary keeps its lines within a half, and the conversation opens and scrolls inside the card', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1280, height: 800 })
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const card = panel.getByTestId('top-thread')
  await expect(card).toHaveAttribute('data-thread-id', ids.thread, { timeout: 30_000 })
  // 6. The summary keeps at least two lines, the top within a half, the choices and the box in sight.
  await measure(page, panel, 2)
  await page.screenshot({ path: `${SHOTS}/4-800-summary.png` })
  // "Conversation" opens a list that shows and scrolls inside the card, the top still within a half.
  await card.getByTestId('org-thread-history').click()
  const list = card.getByTestId('org-thread-messages')
  await expect(list).toBeVisible()
  await page.waitForTimeout(400)
  const top = panel.getByTestId('session-top')
  const [t, b, l] = [await box(top), await box(panel.locator('.session-panel-body')), await box(list)]
  expect(t.height, `top ${t.height} of body ${b.height}`).toBeLessThanOrEqual(b.height / 2 + 1)
  const shown = await linesShown(list)
  expect(shown.overflow).toBe('auto')
  expect(l.height, 'the conversation shows at least two lines').toBeGreaterThanOrEqual(36)
  expect(l.y + l.height).toBeLessThanOrEqual(t.y + t.height + 1)
  expect(shown.scrolls, 'the long request scrolls inside the list').toBe(true)
  await list.hover()
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 160); await page.waitForTimeout(120) }
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  // The box he answers in is still in sight.
  await expect(card.getByTestId('org-thread-follow-input')).toBeVisible()
  const i = await box(card.getByTestId('org-thread-follow-input'))
  expect(i.y + i.height).toBeLessThanOrEqual(t.y + t.height + 1)
  await page.screenshot({ path: `${SHOTS}/5-800-conversation.png` })
  await card.getByTestId('org-thread-history').click()
  expect(errors).toEqual([])
})

test.describe('a phone with its keyboard up', () => {
  test.use({ viewport: PHONE.viewport, screen: PHONE.screen, deviceScaleFactor: PHONE.deviceScaleFactor, isMobile: true, hasTouch: true, userAgent: PHONE.userAgent })

  test('the box he types in stays in sight, and the top never runs over the chat', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const video = await startProofVideo(page)
    await isolateUiPrefs(page)
    await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
    await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
    await page.getByRole('region', { name: /Needs you/ }).getByRole('button', { name: new RegExp(`^Release room ${STAMP}`) }).first().click()
    const panel = page.locator(`.session-panel.is-phone-layer[data-session-id="${ids.sid}"]`)
    const card = panel.getByTestId('top-thread')
    await expect(card).toHaveAttribute('data-thread-id', ids.thread, { timeout: 60_000 })
    const top = panel.getByTestId('session-top')
    const body = panel.locator('.session-panel-body')
    const history = panel.locator('.session-history').first()
    const input = card.getByTestId('org-thread-follow-input')

    /** The top ends above the chat, and the box is inside the window and the top. */
    const fits = async () => {
      await page.waitForTimeout(400)
      const [t, h, b, i] = [await box(top), await box(history), await box(body), await box(input)]
      expect(t.y + t.height, `top ends ${t.y + t.height}, chat starts ${h.y}`).toBeLessThanOrEqual(h.y + 1)
      expect(i.y).toBeGreaterThanOrEqual(t.y - 1)
      expect(i.y + i.height).toBeLessThanOrEqual(Math.min(t.y + t.height, b.y + b.height) + 1)
      expect(h.height, 'the chat keeps a line or two').toBeGreaterThan(40)
    }
    // No keyboard: the card keeps its choices, in at most half the body.
    await expect(top).toHaveAttribute('data-room', /full|lean/)
    await expect(card.getByTestId('org-answer-option').first()).toBeVisible()
    expect((await box(top)).height).toBeLessThanOrEqual((await box(body)).height / 2 + 1)
    await fits()
    await page.screenshot({ path: `${SHOTS}/phone-no-keyboard.png` })
    await video.caption('A phone: the card keeps its title, its choices and its box')
    await video.hold(1200)
    // The keyboard comes up: the body is a few lines now.
    for (const inset of [336, 380]) {
      await setKeyboardInset(page, inset)
      await expect.poll(async () => (await box(body)).height).toBeLessThan(400)
      await expect(top).toHaveAttribute('data-room', /min|box/)
      await expect(panel.getByTestId('session-action-needed')).toBeHidden()
      await fits()
      await page.screenshot({ path: `${SHOTS}/phone-keyboard-${inset}.png` })
      await video.caption(`Keyboard up (${inset}px): the box stays in sight, the chat keeps the rest`)
      await video.hold(1200)
    }
    // He types: the words are in the box he sees.
    await input.click()
    await page.keyboard.type('Hold it')
    await expect(input).toHaveValue('Hold it')
    await fits()
    // The keyboard goes down: everything again.
    await setKeyboardInset(page, 0)
    await expect(top).toHaveAttribute('data-room', /full|lean/)
    await expect(input).toHaveValue('Hold it')
    await video.caption('Keyboard down: everything again, his words still in the box')
    await video.hold(1200)
    await video.stop('top-thread-room-phone')
    expect(errors).toEqual([])
  })
})
