/**
 * A Home task's ask card opens downward in its own column, never across the window (2026-11-20,
 * the user, on the card that covered the chat beside the list: "when it expand whole button is
 * gone", then "it is better to do hover over text the text will expand, also it can't just use all
 * the screen, the max its like 1.5 time long"). utils/truncation-peek-row.ts `growsDown`:
 *   - the pointer resting on the card's text opens it in place: no wider than its column and its
 *     closed box, at most 1.5 times as tall, no top layer, no placeholder
 *   - in a narrow column what does not fit scrolls inside its text; a wheel there scrolls it, never
 *     the list, and keeps it open
 *   - its reply box and Yes / No / Snooze stay visible; a click and typing in the box keep it open
 *   - the pointer on the card off its text opens nothing; away from the card closes it as it was
 *   - a tap on its text opens it on a touch screen, a tap again closes it
 *   - the task's own one-line title row above it still widens (the 2026-11-15 design)
 * Real: the fixture server, the mock CLI's session, the report route, Home's Needs you section.
 */
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { asksOf, presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'
import { expectRestored, expectWidensInPlace } from './truncation-peek-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Ask peek ${STAMP}`
const TITLE = `Move the nightly ledger export to the new storage bucket and retire the old cron host ${STAMP}`
// A question and a detail past the card's 1.5x room together (one scrolls inside), the detail at the 240 characters
// a row's item keeps (core/action-needed.ts detailOf).
// (An ask is at most 300 characters: core/sessions/report-set.ts.)
const QUESTION = `Both neighbourhood-garden improvements are ready: wheelbarrow-friendly gravel pathways between the raised strawberry beds, rainwater-harvesting barrels feeding the drip irrigation overnight, and both undo with one switch. Do you agree that I start them this weekend ${STAMP}?`
const DETAIL = `The tomato plan has its seed list and spacing drawn up, the rain barrel timer fills the drip line on its own and was tried on the shed tap, and both undo with one switch if the first bed looks too wet after ${STAMP}.`
const made: string[] = []
let sessionId = ''
const historyOf = async (request: APIRequestContext, sid: string) =>
  ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1440, height: 900 } })

const askOf = (row: Locator) => asksOf(row).locator('[data-testid="action-item"][data-kind="ask"]')

async function openNeeds(page: Page): Promise<{ row: Locator; card: Locator }> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
  const row = await showSectionCard(page, 'needs', made[0])
  const card = askOf(row)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId('org-answer-input')).toBeVisible({ timeout: 30_000 })
  // Mid-list, with room below for its 1.5x: a card left at the list's bottom edge opens past the
  // fold whatever its size (how far down depends on what else the shared list holds).
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  return { row, card }
}

/** What the page shows of the card and its texts now. */
const cardState = (card: Locator) => card.evaluate((el) => {
  const detail = el.querySelector<HTMLElement>('.ask-card-detail')!
  const question = el.querySelector<HTMLElement>('.ask-card-question')!
  const scroll = (h: HTMLElement) => ({ top: h.scrollTop, height: h.scrollHeight, client: h.clientHeight })
  let scroller: HTMLElement | null = el.parentElement
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  const column = el.closest<HTMLElement>('.todo-panel')!.getBoundingClientRect()
  const r = el.getBoundingClientRect()
  return {
    box: { left: r.left, right: r.right, top: r.top, height: r.height, width: r.width },
    column: { left: column.left, right: column.right },
    open: detail.hasAttribute('data-peek-down'),
    expanded: el.hasAttribute('data-peek-expanded'),
    topLayer: el.matches(':popover-open'),
    placeholders: document.querySelectorAll('[data-peek-placeholder]').length,
    detailClamp: getComputedStyle(detail).webkitLineClamp,
    questionClamp: getComputedStyle(question).webkitLineClamp,
    scroll: { question: scroll(question), detail: scroll(detail) },
    overflowY: [getComputedStyle(question).overflowY, getComputedStyle(detail).overflowY],
    listTop: scroller?.scrollTop ?? -1,
  }
})

/** Inside the column and the card's own closed width, taller but at most 1.5 times as tall. */
function expectInColumn(s: Awaited<ReturnType<typeof cardState>>, closed: { left: number; right: number; top: number; height: number }, label: string) {
  expect(s.box.left, `${label}: left edge inside its column`).toBeGreaterThanOrEqual(s.column.left - 1)
  expect(s.box.right, `${label}: right edge inside its column`).toBeLessThanOrEqual(s.column.right + 1)
  expect(Math.abs(s.box.left - closed.left), `${label}: same left as closed`).toBeLessThanOrEqual(1)
  expect(Math.abs(s.box.right - closed.right), `${label}: same right as closed (no wider)`).toBeLessThanOrEqual(1)
  expect(Math.abs(s.box.top - closed.top), `${label}: same top: it grows downward`).toBeLessThanOrEqual(1)
  expect(s.box.height, `${label}: taller than closed`).toBeGreaterThan(closed.height + 4)
  expect(s.box.height, `${label}: at most 1.5 times its closed height (${closed.height})`).toBeLessThanOrEqual(closed.height * 1.5 + 1)
  expect(s.topLayer, `${label}: not in the top layer`).toBe(false)
  expect(s.placeholders, `${label}: no placeholder`).toBe(0)
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const res = await request.post('/api/tasks', { data: { title: TITLE, project: PROJECT, source: 'local' } })
  expect(res.ok(), await res.text()).toBe(true)
  made.push(((await res.json()) as { task: { id: string } }).task.id)
  // A session to answer, so the card shows its box; its turn ends first so its own report cannot
  // overwrite the ask below.
  const started = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: `Ledger ready ${STAMP}`, taskId: made[0] } })
  expect(started.ok(), await started.text()).toBe(true)
  sessionId = ((await started.json()) as { sessionId: string }).sessionId
  await expect.poll(() => historyOf(request, sessionId), { timeout: 90_000 }).toContain(`Ledger ready ${STAMP}`)
  // A second task asking too, a card of its own in the same list (no session: a card without a box).
  const second = await request.post('/api/tasks', { data: { title: `Rotate the staging keys ${STAMP}`, project: PROJECT, source: 'local' } })
  expect(second.ok(), await second.text()).toBe(true)
  made.push(((await second.json()) as { task: { id: string } }).task.id)
  const asks = [QUESTION, `The staging keys are 90 days old and the vendor wants them rotated before the audit; rotating means a short outage of the preview builds while the new keys spread. Do you want me to rotate them tonight ${STAMP}?`]
  for (const [i, id] of made.entries()) {
    expect((await request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
    const asked = await request.put(`/api/v1/tasks/${id}/report`, { data: { state: 'needs', ask: asks[i], ask_kind: 'yes_no', ask_more: DETAIL } })
    expect(asked.ok(), await asked.text()).toBe(true)
    await expect.poll(async () => (((await (await request.get(`/api/tasks/${id}`)).json()).task?.user_status?.actions ?? []) as Array<{ kind: string }>).map((a) => a.kind).join(','), { timeout: 60_000 }).toContain('ask')
  }
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

test('hovering the ask card\'s text opens it downward in its column, at most 1.5 times as tall, its box in sight', async ({ page }, info) => {
  const { card } = await openNeeds(page)
  const shots = process.env.PEEK_SHOTS
  await page.mouse.move(1, 1)
  const before = await cardState(card)
  expect(before.open).toBe(false)
  expect(before.detailClamp, 'closed, the detail is clamped').not.toMatch(/none|unset/)
  if (shots) await card.screenshot({ path: `${shots}/ask-card-closed.png` })

  // The pointer on its box or its buttons opens nothing.
  await card.getByTestId('org-answer-input').hover()
  await page.waitForTimeout(500)
  expect((await cardState(card)).open, 'the box opens nothing').toBe(false)

  // The pointer resting on its text opens it in place.
  await card.locator('.ask-card-question').hover({ position: { x: 20, y: 6 } })
  await expect.poll(async () => (await cardState(card)).open, 'the text opens').toBe(true)
  const open = await cardState(card)
  expectInColumn(open, before.box, 'hover')
  expect(open.expanded).toBe(true)
  expect(open.detailClamp, 'open, the detail is not clamped').toMatch(/none|unset/)
  expect(open.questionClamp, 'open, the question is not clamped').toMatch(/none|unset/)
  expect(open.overflowY).toEqual(['auto', 'auto'])
  // At this width both texts open whole within the 1.5x room.
  for (const k of ['question', 'detail'] as const) expect(open.scroll[k].height, `${k} opens whole`).toBeLessThanOrEqual(open.scroll[k].client + 1)
  // Every word the card holds is in sight (the row's item keeps its detail to 240 characters).
  await expect(card.getByTestId('action-detail')).toContainText(`after ${STAMP}.`)
  // Its box and its buttons stay in sight.
  await expect(card.getByTestId('org-answer-input')).toBeInViewport()
  await expect(card.getByRole('button', { name: 'Yes', exact: true })).toBeInViewport()
  await expect(card.getByRole('button', { name: 'No', exact: true })).toBeInViewport()
  await expect(card.getByTestId('action-snooze')).toBeInViewport()
  if (shots) await page.screenshot({ path: `${shots}/ask-card-open-window.png`, clip: { x: 0, y: Math.max(0, open.box.top - 120), width: 1280, height: Math.min(700, open.box.height + 240) } })
  if (shots) await card.screenshot({ path: `${shots}/ask-card-open.png` })

  // A click in its box and typing keep it open, the box where it is.
  const boxAt = (await card.getByTestId('org-answer-input').boundingBox())!
  await card.getByTestId('org-answer-input').click()
  await page.keyboard.type('Start with the tomatoes')
  await page.waitForTimeout(400)
  expect((await cardState(card)).open, 'open while typing').toBe(true)
  expect(Math.abs((await card.getByTestId('org-answer-input').boundingBox())!.y - boxAt.y), 'the box did not move').toBeLessThanOrEqual(1)

  // Away from the card, focus out: it closes as it was.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.mouse.move(1, 1)
  await page.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect.poll(async () => (await cardState(card)).open, 'closes').toBe(false)
  const after = await cardState(card)
  expect(Math.abs(after.box.height - before.box.height), 'back to its closed height').toBeLessThanOrEqual(1)
  expect(after.expanded).toBe(false)
  await info.attach('boxes', { body: JSON.stringify({ before: before.box, open: open.box, after: after.box }), contentType: 'application/json' })
})

test('in a narrow column the opened card stays at 1.5 times its height; the rest scrolls in its text, never the list', async ({ page }) => {
  const { card } = await openNeeds(page)
  const shots = process.env.PEEK_SHOTS
  // A narrow list (a small window or a resized panel): the texts need far more than the room.
  await page.locator('.todo-panel').evaluate((el: HTMLElement) => { el.style.width = '250px'; el.style.minWidth = '250px'; el.style.maxWidth = '250px'; el.style.flex = 'none' })
  // Narrowed, it is taller: mid-list again (openNeeds).
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.mouse.move(1, 1)
  const before = await cardState(card)
  await card.locator('.ask-card-question').hover({ position: { x: 20, y: 6 } })
  await expect.poll(async () => (await cardState(card)).open, 'the text opens').toBe(true)
  const open = await cardState(card)
  expectInColumn(open, before.box, 'narrow')
  expect(open.overflowY).toEqual(['auto', 'auto'])
  // What does not fit the 1.5x room scrolls inside its own text.
  const part = (['question', 'detail'] as const).find((k) => open.scroll[k].height > open.scroll[k].client + 4)
  expect(part, `one text scrolls inside the card: ${JSON.stringify(open.scroll)}`).toBeTruthy()
  await expect(card.getByTestId('org-answer-input')).toBeInViewport()
  await expect(card.getByTestId('action-snooze')).toBeInViewport()
  if (shots) await card.screenshot({ path: `${shots}/ask-card-open-narrow.png` })
  // A wheel on that text scrolls it, never the list, and the card stays open.
  await card.locator(`.ask-card-${part}`).hover({ position: { x: 30, y: 10 } })
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await cardState(card)).scroll[part!].top, `the ${part} scrolls`).toBeGreaterThan(0)
  // To its end, and still more: the list never takes the wheel.
  await page.mouse.wheel(0, 4000)
  await page.waitForTimeout(300)
  const scrolled = await cardState(card)
  expect(scrolled.listTop, 'the list behind it did not scroll').toBe(open.listTop)
  expect(scrolled.open, 'still open after the wheel').toBe(true)
  expectInColumn(scrolled, before.box, 'after the wheel')
  await page.mouse.move(1, 1)
  await expect.poll(async () => (await cardState(card)).open, 'closes').toBe(false)
  expect(Math.abs((await cardState(card)).box.height - before.box.height), 'back to its closed height').toBeLessThanOrEqual(1)
})

test('the task\'s one-line title row above the card still widens over the panes beside it', async ({ page }) => {
  const { row } = await openNeeds(page)
  await page.mouse.move(1, 1)
  const title = row.locator('.todo-pinned-title, .status-card-title, [data-testid="task-title"]').first()
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1), 'the title is cut').toBe(true)
  const before = (await row.boundingBox())!
  await title.hover({ position: { x: 20, y: 5 } })
  await expectWidensInPlace(row, before, { label: 'title row' })
  await page.mouse.move(1, 1)
  await expectRestored(row, before, 'title row')
})

test('on a touch screen a tap on the card\'s text opens it, a tap again closes it', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true })
  try {
    const page = await context.newPage()
    const { card } = await openNeeds(page)
    const before = await cardState(card)
    await card.locator('.ask-card-question').tap({ position: { x: 20, y: 6 } })
    await expect.poll(async () => (await cardState(card)).open, 'a tap opens it').toBe(true)
    expectInColumn(await cardState(card), before.box, 'tap')
    await expect(card.getByTestId('org-answer-input')).toBeInViewport()
    await card.locator('.ask-card-question').tap({ position: { x: 20, y: 6 } })
    await expect.poll(async () => (await cardState(card)).open, 'a tap again closes it').toBe(false)
    expect(Math.abs((await cardState(card)).box.height - before.box.height)).toBeLessThanOrEqual(1)
  } finally {
    await context.close()
  }
})

test('two ask cards in one list: moving from the open one to the one below opens it where the pointer is, nothing jumps', async ({ page }) => {
  const { card: first } = await openNeeds(page)
  const otherRow = await showSectionCard(page, 'needs', made[1])
  const other = askOf(otherRow)
  await expect(other).toBeVisible({ timeout: 30_000 })
  // Upper and lower by where they are, whichever order the section sorts them in.
  const [upper, lower] = (await first.boundingBox())!.y < (await other.boundingBox())!.y ? [first, other] : [other, first]
  await upper.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await upper.locator('.ask-card-question').hover({ position: { x: 20, y: 6 } })
  await expect.poll(async () => (await cardState(upper)).open, 'the upper card opens').toBe(true)
  // Down to the lower card's text, in steps as a hand moves.
  // Where it is while the upper one is open: where the hand aims.
  const q = (await lower.locator('.ask-card-question').boundingBox())!
  const at = { x: q.x + 20, y: q.y + 6 }
  await page.mouse.move(at.x, at.y, { steps: 8 })
  await expect.poll(async () => (await cardState(lower)).open, 'the lower card opens').toBe(true)
  await page.waitForTimeout(400)
  const now = (await lower.locator('.ask-card-question').boundingBox())!
  expect(Math.abs(now.y - q.y), `the lower card did not move under the pointer (${q.y} -> ${now.y})`).toBeLessThanOrEqual(1)
  expect(await lower.locator('.ask-card-question').evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), at), 'the pointer is still on its text').toBe(true)
  expect((await cardState(lower)).open, 'still open').toBe(true)
  // Off the cards: both close.
  await page.mouse.move(1, 1)
  await expect.poll(async () => (await cardState(upper)).open || (await cardState(lower)).open, 'both close').toBe(false)
})

test('a press in the open card with focus in its box keeps it open: the button stays put and its click lands', async ({ page, request }) => {
  const { card } = await openNeeds(page)
  await page.mouse.move(1, 1)
  await card.locator('.ask-card-question').hover({ position: { x: 20, y: 6 } })
  await expect.poll(async () => (await cardState(card)).open, 'the text opens').toBe(true)
  await card.getByTestId('org-answer-input').click()
  const yes = card.getByRole('button', { name: 'Yes', exact: true })
  // A press on the question's text: nothing there takes focus, so the box blurs to nothing.
  const q = (await card.locator('.ask-card-question').boundingBox())!
  const yesBefore = (await yes.boundingBox())!
  await page.mouse.move(q.x + 30, q.y + 8)
  await page.mouse.down()
  await page.waitForTimeout(250)
  expect((await cardState(card)).open, 'open through a press on its text').toBe(true)
  await page.mouse.up()
  await page.waitForTimeout(250)
  expect((await cardState(card)).open, 'open after it').toBe(true)
  expect(Math.abs((await yes.boundingBox())!.y - yesBefore.y), 'Yes did not move').toBeLessThanOrEqual(1)
  // Focus back in the box, then a press on Yes (WebKit focuses no clicked button: the box blurs to nothing).
  await card.getByTestId('org-answer-input').click()
  const down = (await yes.boundingBox())!
  await page.mouse.move(down.x + down.width / 2, down.y + down.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(250)
  expect((await cardState(card)).open, 'open through the press on Yes').toBe(true)
  const held = (await yes.boundingBox())!
  expect(Math.abs(held.y - down.y), `Yes did not move between down and up (${down.y} -> ${held.y})`).toBeLessThanOrEqual(1)
  await page.mouse.up()
  // The click landed: its answer reached the task's session.
  await expect.poll(() => historyOf(request, sessionId), { timeout: 30_000, message: 'the Yes answer reached the session' }).toMatch(/\bYes\b/)
})

