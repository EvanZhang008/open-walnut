/**
 * A task's asks are pages, one at a time, on Home's row (web/src/components/actions/ask-pages.ts;
 * 2026-11-20, the user: "max shoudl 1 decision, and can left and right", then "each quesiton is jsut
 * left and right, and each quesiton it selse have options, and titme and descirption, don't mix
 * them ... what if the qeusiton is not cr"). One task asks three questions of three kinds: a yes / no
 * to publish and a pick of one of three plans (letters from its session), and one answered in words
 * (its session's own ask).
 *   - one card shows, "1/3"; the arrows page it, Left / Right too, the focus stays on an arrow, and
 *     a screen reader hears "Decision 2 of 3"
 *   - each page has its own words, options and box, and is answered on its own
 *   - an answered page stays, marked with what was said; paging away and back finds it so, and the
 *     place still counts every page
 *   - after an answer the focus is on an arrow, so the keys go on paging
 *   - a send that fails late, while he is on another page, leaves him there; the place says
 *     "1 not sent", and the page shows its reason when he goes back
 *   - a page the status drops while shown: the next takes its place, the focus stays on an arrow
 *   - with every page answered the block goes
 *   - a sideways swipe on a touch screen pages it; an upright one does not
 * Real: the fixture server, the mock CLI's session, the inbox and report routes, the status sync.
 */
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { asksOf, pageToAsk, presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Ask pages ${STAMP}`
const PUBLISH = `Publish the garden newsletter to the neighbours now ${STAMP}?`
const PLAN = `Which watering plan for the summer ${STAMP}?`
const CODE = `What should the new shed code be ${STAMP}?`
const made: string[] = []
let taskId = ''
let sid = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: { width: 1280, height: 900 } })

async function post<T>(request: APIRequestContext, url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request.post(url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}
const actionsOf = async (request: APIRequestContext) =>
  (((await (await request.get(`/api/tasks/${taskId}`)).json()).task?.user_status?.actions ?? []) as Array<{ id: string; kind: string; summary: string }>)
const historyOf = async (request: APIRequestContext) =>
  ((await (await request.get(`/api/v1/sessions/${sid}/history?tail=80`)).json()) as { messages?: Array<{ text?: string }> }).messages?.map((m) => m.text ?? '').join('\n') ?? ''

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and letters: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Plan the community garden ${STAMP}`, project: PROJECT, source: 'local' })
  taskId = task.id
  made.push(taskId)
  sid = (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: `Garden ready ${STAMP}`, taskId })).sessionId
  await expect.poll(() => historyOf(request), { timeout: 90_000 }).toContain(`Garden ready ${STAMP}`)
  const from = { 'x-walnut-caller-sid': sid }
  await post(request, '/api/v1/human-inbox', { subject: PUBLISH, type: 'action_required', user_kind: 'outward', user_kind_why: 'it goes out to the neighbours in his name', markdown: 'The newsletter has the planting dates and the work day.', actions: [{ id: 'yes', label: 'Publish' }, { id: 'no', label: 'Not yet' }] }, from)
  await post(request, '/api/v1/human-inbox', { subject: PLAN, type: 'action_required', user_kind: 'user_own', user_kind_why: 'he decides how his garden is watered', markdown: 'Three plans, each tried on the shed tap.', actions: [{ id: 'dawn', label: 'Water at dawn' }, { id: 'dusk', label: 'Water at dusk' }, { id: 'drip', label: 'Drip all night' }] }, from)
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  const asked = await request.put(`/api/v1/tasks/${taskId}/report`, { data: { state: 'needs', ask: CODE, ask_kind: 'text', ask_more: 'The lock takes four digits.' } })
  expect(asked.ok(), await asked.text()).toBe(true)
  await expect.poll(async () => (await actionsOf(request)).map((a) => a.kind).sort().join(','), { timeout: 60_000 }).toBe('ask,letter,letter')
})

test.afterAll(async ({ request }) => {
  if (sid) await request.post(`/api/v1/sessions/${sid}/terminate`, { data: { force: true } })
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

async function openBlock(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
  const row = await showSectionCard(page, 'needs', taskId)
  const block = asksOf(row).getByTestId('action-needed')
  await expect(block.getByTestId('action-item')).toHaveCount(1, { timeout: 30_000 })
  await block.scrollIntoViewIfNeeded()
  return block
}
const shown = (block: Locator) => block.getByTestId('action-item')
const pageOf = (block: Locator, words: string) => block.locator('[data-testid="action-item"]', { hasText: words })

test('one question at a time, "1/3": the arrows and Left / Right page it, the focus stays on an arrow', async ({ page }) => {
  const block = await openBlock(page)
  const at = block.getByTestId('action-page-at')
  await expect(at).toHaveText('1/3')
  await expect(block).toHaveAttribute('data-pages', '3')
  await expect(block.getByTestId('action-page-prev')).toBeDisabled()
  await expect(block.getByTestId('action-needed-place')).toHaveText('Decision 1 of 3')
  await expect(block.getByTestId('action-needed-more')).toHaveCount(0)
  const seen = new Set<string>()
  for (let i = 1; i <= 3; i++) {
    const card = shown(block)
    // Each page: its own question, its own answer parts, its box, Snooze and the arrows.
    await expect(card.getByTestId('action-summary')).toBeVisible()
    await expect(card.getByTestId('org-answer-input')).toBeVisible()
    await expect(card.getByTestId('action-snooze')).toBeVisible()
    await expect(card.getByTestId('action-pager')).toBeVisible()
    seen.add((await card.getAttribute('data-item-id'))!)
    if (i < 3) {
      await block.getByTestId('action-page-next').click()
      await expect(at).toHaveText(`${i + 1}/3`)
      await expect(block.getByTestId('action-needed-place')).toHaveText(`Decision ${i + 1} of 3`)
    }
  }
  expect(seen.size, 'three different questions').toBe(3)
  await expect(block.getByTestId('action-page-next')).toBeDisabled()
  // Paged by its arrow, the focus is on an arrow of the new page: the keys go on from there.
  await block.getByTestId('action-page-prev').click()
  await expect(at).toHaveText('2/3')
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('action-page-prev')
  await page.keyboard.press('ArrowLeft')
  await expect(at).toHaveText('1/3')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(at).toHaveText('3/3')
  // In the box, the arrows move the caret: no page turns.
  await shown(block).getByTestId('org-answer-input').click()
  await page.keyboard.type('ab')
  await page.keyboard.press('ArrowLeft')
  await expect(at).toHaveText('3/3')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
})

test('a page the status drops while shown: the next one takes its place, the focus stays on an arrow', async ({ page, request }) => {
  const extra = `Order more compost for the beds ${STAMP}?`
  const sent = await post<{ id: string }>(request, '/api/v1/human-inbox', { subject: extra, type: 'action_required', user_kind: 'user_own', user_kind_why: 'he decides what the garden money buys', markdown: 'Twelve bags.', actions: [{ id: 'yes', label: 'Order' }, { id: 'no', label: 'Wait' }] }, { 'x-walnut-caller-sid': sid })
  await expect.poll(async () => (await actionsOf(request)).length, { timeout: 60_000 }).toBe(4)
  const block = await openBlock(page)
  const at = block.getByTestId('action-page-at')
  await pageToAsk(block, pageOf(block, extra))
  const was = Number((await at.textContent())!.split('/')[0])
  // The focus on an arrow of that page.
  await block.getByTestId(was > 1 ? 'action-page-prev' : 'action-page-next').click()
  await block.getByTestId(was > 1 ? 'action-page-next' : 'action-page-prev').click()
  await expect(pageOf(block, extra)).toBeVisible()
  // Its task settles it (nobody needs to answer it any more): the status drops it while it is shown.
  const settled = await request.post(`/api/v1/human-inbox/${sent.id}/settle`, { data: { reason: 'The compost came with the seeds' }, headers: { 'x-walnut-caller-sid': sid } })
  expect(settled.ok(), await settled.text()).toBe(true)
  await expect(block).toHaveAttribute('data-pages', '3', { timeout: 30_000 })
  await expect(pageOf(block, extra)).toHaveCount(0)
  await expect(at).toHaveText(`${Math.min(was, 3)}/3`)
  await expect(shown(block).getByTestId('action-summary')).toBeVisible()
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName)).toMatch(/^action-page-(prev|next)$/)
  await page.keyboard.press(was > 1 ? 'ArrowLeft' : 'ArrowRight')
  await expect(at).not.toHaveText(`${Math.min(was, 3)}/3`)
})

test('each page is answered on its own: an answered page stays marked, paging away and back; a failed send opens it again', async ({ page, request }) => {
  const block = await openBlock(page)
  const at = block.getByTestId('action-page-at')
  // The question in words first (its words start a turn of the session, which ends its own ask):
  // its own box, its words go to the session, its page marked with them.
  const code = await pageToAsk(block, pageOf(block, CODE))
  await expect(code.getByTestId('org-answer-option')).toHaveCount(0)
  const codeAt = await at.textContent()
  const words = `Use 4721 for the shed ${STAMP}`
  await code.getByTestId('org-answer-input').fill(words)
  await code.getByTestId('org-answer-send').click()
  await expect(pageOf(block, CODE).getByTestId('action-answered')).toContainText(`Answered: ${words}`, { timeout: 15_000 })
  await expect(pageOf(block, CODE).getByTestId('org-answer-input')).toHaveCount(0)
  await expect(pageOf(block, CODE).getByTestId('action-snooze')).toHaveCount(0)
  await expect.poll(() => historyOf(request), { timeout: 60_000 }).toContain(words)
  // The server no longer counts it; its page stays where it was.
  await expect.poll(async () => (await actionsOf(request)).some((a) => a.kind === 'ask'), { timeout: 60_000 }).toBe(false)
  await expect(pageOf(block, CODE).getByTestId('action-answered')).toBeVisible()
  await expect(at).toHaveText(codeAt!)
  await expect(block).toHaveAttribute('data-pages', '3')

  // The pick of three plans: its first send fails late, while he is on another page. He stays
  // there, the place says "1 not sent", and the page shows its reason when he goes back.
  const plan = await pageToAsk(block, pageOf(block, PLAN))
  await expect(plan.getByTestId('org-answer-option')).toHaveCount(3)
  const planAt = (await at.textContent())!
  await page.route('**/api/v1/human-inbox/*/answer', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' })
  })
  await plan.getByRole('button', { name: 'Water at dawn', exact: true }).click()
  await expect(pageOf(block, PLAN).getByTestId('action-answered')).toBeVisible()
  await pageToAsk(block, pageOf(block, PUBLISH))
  const awayAt = (await at.textContent())!
  expect(awayAt).not.toBe(planAt)
  await expect(block.getByTestId('action-page-unsent')).toHaveText('· 1 not sent', { timeout: 15_000 })
  await expect(block.getByTestId('action-needed-place')).toContainText('1 not sent')
  await expect(at).toHaveText(awayAt)
  await expect(pageOf(block, PUBLISH)).toBeVisible()
  await page.unroute('**/api/v1/human-inbox/*/answer')
  const again = await pageToAsk(block, pageOf(block, PLAN))
  await expect(again.getByTestId('org-answer-error')).toContainText('Not sent')
  await expect(again.getByTestId('action-answered')).toHaveCount(0)
  await expect(block.getByTestId('action-page-unsent')).toHaveCount(0)

  // Then answered on its own; away and back, it is still marked.
  await again.getByRole('button', { name: 'Water at dusk', exact: true }).click()
  await expect(pageOf(block, PLAN).getByTestId('action-answered')).toContainText('Answered: Water at dusk')
  // Its button went with the answer: the focus is on an arrow, and the keys page on.
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toMatch(/^action-page-(prev|next)$/)
  await expect.poll(async () => (await actionsOf(request)).some((a) => a.summary.includes(`watering plan for the summer ${STAMP}`)), { timeout: 30_000 }).toBe(false)
  await expect(at).toHaveText(planAt)
  await expect(block).toHaveAttribute('data-pages', '3')
  await pageToAsk(block, pageOf(block, CODE))
  await expect(pageOf(block, CODE).getByTestId('action-answered')).toContainText(words)
  await pageToAsk(block, pageOf(block, PLAN))
  await expect(pageOf(block, PLAN).getByTestId('action-answered')).toContainText('Water at dusk')

  // The last open page answered: nothing needs him, the block goes.
  await pageToAsk(block, pageOf(block, PUBLISH))
  await pageOf(block, PUBLISH).getByRole('button', { name: 'Not yet', exact: true }).click()
  await expect(block).toHaveCount(0, { timeout: 15_000 })
})

test('a sideways swipe on a touch screen pages it', async ({ browser, request }: { browser: Browser; request: APIRequestContext }) => {
  // A fresh question for this test (the one above answered them all).
  expect((await request.put(`/api/v1/tasks/${taskId}/report`, { data: { state: 'needs', ask: `Should the hose reel go by the shed ${STAMP}?`, ask_kind: 'yes_no' } })).ok()).toBe(true)
  await post(request, '/api/v1/human-inbox', { subject: `Order more compost ${STAMP}?`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'he decides what the garden money buys', markdown: 'Twelve bags.', actions: [{ id: 'yes', label: 'Order' }, { id: 'no', label: 'Wait' }] }, { 'x-walnut-caller-sid': sid })
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await expect.poll(async () => (await actionsOf(request)).length, { timeout: 60_000 }).toBe(2)
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true })
  try {
    const page = await context.newPage()
    const block = await openBlock(page)
    const at = block.getByTestId('action-page-at')
    // The answered pages of the other test are gone: a later ask starts afresh.
    await expect(at).toHaveText('1/2')
    const box = (await shown(block).getByTestId('action-summary').boundingBox())!
    const cdp = await context.newCDPSession(page)
    const swipe = async (from: number, by: number) => {
      const y = box.y + box.height / 2
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] })
      for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from + (by * i) / 6, y: y + i }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    }
    await swipe(box.x + box.width - 10, -150)
    await expect(at).toHaveText('2/2')
    await swipe(box.x + 10, 150)
    await expect(at).toHaveText('1/2')
    // A short or a mostly upright stroke turns no page.
    await swipe(box.x + box.width / 2, -20)
    await expect(at).toHaveText('1/2')
    const y0 = box.y + box.height / 2
    const x0 = box.x + box.width / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 - i * 8, y: y0 + i * 25 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(500)
    await expect(at).toHaveText('1/2')
  } finally { await context.close() }
})
