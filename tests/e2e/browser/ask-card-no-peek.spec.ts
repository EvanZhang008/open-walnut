/**
 * A Home task's ask card never opens on hover (2026-11-24, the user: "please dont enlarge this
 * automtaiclLY, ANYTHING can easily show all by cusotmer shoudln't auto enarge it is so bad, the task
 * titide in sesion page in task pannel is fine, other debateable"). It sat in the task panel's peek
 * zone and opened downward in its column (2026-11-20, utils/truncation-peek-row.ts growsDown); now
 * only a task's own row widens there (utils/truncation-peek-find.ts peekAllowed):
 *   - the pointer resting on the card's text, or on its box, opens nothing and moves nothing, at a
 *     side-list width and in a narrow column
 *   - its cut text carries its full text as a native tooltip
 *   - its own Show more shows the text whole in the card, and Show less cuts it again
 *   - a tap on its text on a touch screen opens nothing
 *   - the task's own title row above it wraps whole, so hovering it widens nothing
 * Real: the fixture server, the mock CLI's session, the report route, Home's Needs you section.
 */
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs, pinTaskPanelWidth } from './todo-panel-helpers'
import { asksOf, presetPanelDesign, setStatusSectionOpen, showSectionCard } from './status-section-helpers'
import { expectTooltipNotPeek, peekMarks, peekPill } from './truncation-peek-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Ask peek ${STAMP}`
const TITLE = `Move the nightly ledger export to the new storage bucket and retire the old cron host ${STAMP}`
// A question and a detail longer than the card's lines, the detail at the 240 characters a row's
// item keeps (core/action-needed.ts detailOf). (An ask is at most 300 characters: core/sessions/report-set.ts.)
const QUESTION = `Both neighbourhood-garden improvements are ready: wheelbarrow-friendly gravel pathways between the raised strawberry beds, rainwater-harvesting barrels feeding the drip irrigation overnight, and both undo with one switch. Do you agree that I start them this weekend ${STAMP}?`
const DETAIL = `The tomato plan has its seed list and spacing drawn up, the rain barrel timer fills the drip line on its own and was tried on the shed tap, and both undo with one switch if the first bed looks too wet after ${STAMP}.`
/** The end of the detail, which only its whole text holds. */
const DETAIL_END = `after ${STAMP}.`
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
  // A side-list width, as beside a session: alone on Home's row the panel grows to a readable list
  // (MainPage's todoAlone) and nothing in the card is cut. A dragged width holds in both layouts.
  await pinTaskPanelWidth(page, 30)
  await loadHome(page)
  await setStatusSectionOpen(page, 'needs', true)
  const row = await showSectionCard(page, 'needs', made[0])
  const card = askOf(row)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.getByTestId('org-answer-input')).toBeVisible({ timeout: 30_000 })
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  return { row, card }
}

type Part = 'question' | 'detail'
const partOf = (card: Locator, part: Part) => card.locator(`.ask-card-${part}`)
/** Whether the page cuts that text of the card now (its lines clamp it). */
const isCut = (card: Locator, part: Part) => partOf(card, part).evaluate((el) => el.scrollHeight > el.clientHeight + 1)
const near = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(a[k] - b[k]) <= 0.5)

/**
 * The pointer on the card's box and on each of its texts opens nothing: no open text, no widened
 * row, no placeholder, no downward opening; the card and its box keep their place to the pixel; a
 * cut text has its whole text as a native tooltip. Returns the texts that were cut.
 */
async function expectCardStill(page: Page, card: Locator, label: string): Promise<Part[]> {
  await page.mouse.move(1, 1)
  await page.waitForTimeout(150)
  const input = card.getByTestId('org-answer-input')
  const cardBefore = (await card.boundingBox())!
  const inputBefore = (await input.boundingBox())!
  await input.hover()
  await page.waitForTimeout(400)
  expect(await peekMarks(page), `${label}: the box opens nothing`).toBe(0)
  const cut: Part[] = []
  for (const part of ['question', 'detail'] as const) {
    if (await isCut(card, part)) {
      cut.push(part)
      // The words the card shows (a row's item may shorten its ask), as a tooltip whole.
      const shown = ((await partOf(card, part).textContent()) ?? '').trim().replace(/\s+/g, ' ')
      await expectTooltipNotPeek(partOf(card, part), shown, `${label}: the ${part}`)
    } else {
      await partOf(card, part).hover({ position: { x: 20, y: 6 } })
      await page.waitForTimeout(400)
      expect(await peekMarks(page), `${label}: the ${part}, whole, opens nothing`).toBe(0)
    }
    expect(near((await card.boundingBox())!, cardBefore), `${label}: the card kept its box after the ${part}`).toBe(true)
    expect(near((await input.boundingBox())!, inputBefore), `${label}: its box did not move`).toBe(true)
  }
  await expect(peekPill(page)).toHaveCount(0)
  await page.mouse.move(1, 1)
  return cut
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
  expect((await request.patch(`/api/tasks/${made[0]}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  const asked = await request.put(`/api/v1/tasks/${made[0]}/report`, { data: { state: 'needs', ask: QUESTION, ask_kind: 'yes_no', ask_more: DETAIL } })
  expect(asked.ok(), await asked.text()).toBe(true)
  await expect.poll(async () => (((await (await request.get(`/api/tasks/${made[0]}`)).json()).task?.user_status?.actions ?? []) as Array<{ kind: string }>).map((a) => a.kind).join(','), { timeout: 60_000 }).toContain('ask')
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

test('hovering the ask card opens nothing and moves nothing, in a side list and a narrow column; its cut text is its tooltip', async ({ page }) => {
  const { card } = await openNeeds(page)
  const shots = process.env.PEEK_SHOTS
  if (shots) await card.screenshot({ path: `${shots}/ask-card-side-list.png` })
  // At a side list's width the detail is cut to its lines (its end is past them).
  expect(await isCut(card, 'detail'), 'the detail is cut at a side list\'s width').toBe(true)
  expect(await expectCardStill(page, card, 'side list')).toContain('detail')
  // A narrow list (a small window or a resized panel): both texts are cut, and still nothing opens.
  await page.locator('.todo-panel').evaluate((el: HTMLElement) => { el.style.width = '250px'; el.style.minWidth = '250px'; el.style.maxWidth = '250px'; el.style.flex = 'none' })
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  expect(await expectCardStill(page, card, 'narrow')).toEqual(['question', 'detail'])
  if (shots) await card.screenshot({ path: `${shots}/ask-card-narrow.png` })
})

test('the card\'s own Show more shows its text whole in the card, and Show less cuts it again', async ({ page }) => {
  const { card } = await openNeeds(page)
  await page.mouse.move(1, 1)
  const detail = partOf(card, 'detail')
  const cutHeight = await detail.evaluate((el) => el.clientHeight)
  const toggle = card.getByTestId('ask-card-more')
  await expect(toggle).toHaveText('Show more')
  await toggle.click()
  await expect(toggle).toHaveText('Show less')
  await expect(card).toHaveClass(/is-whole/)
  await expect.poll(() => detail.evaluate((el) => el.clientHeight)).toBeGreaterThan(cutHeight)
  await expect(detail).toContainText(DETAIL_END)
  for (const part of ['question', 'detail'] as const) expect(await isCut(card, part), `the ${part} shows whole`).toBe(false)
  // Its box and buttons are still there to answer.
  await expect(card.getByTestId('org-answer-input')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Yes', exact: true })).toBeVisible()
  // Hovering the whole text opens nothing either.
  await detail.hover({ position: { x: 20, y: 6 } })
  await page.waitForTimeout(400)
  expect(await peekMarks(page), 'hovering the whole text opens nothing').toBe(0)
  await page.mouse.move(1, 1)
  await toggle.click()
  await expect(toggle).toHaveText('Show more')
  await expect.poll(() => detail.evaluate((el) => el.clientHeight)).toBe(cutHeight)
  expect(await isCut(card, 'detail'), 'cut again').toBe(true)
})

// A task's title is never cut any more (d670f86000): it wraps whole, so hovering it has nothing to show.
test('the task\'s title above the card wraps whole, and hovering it widens nothing', async ({ page }) => {
  const { row } = await openNeeds(page)
  await page.mouse.move(1, 1)
  const title = row.locator('.todo-pinned-title, .status-card-title, [data-testid="task-title"]').first()
  await expect(title).toContainText(TITLE)
  expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1), 'the title is whole').toBe(false)
  const before = (await row.boundingBox())!
  await title.hover({ position: { x: 20, y: 5 } })
  await page.waitForTimeout(600)
  const after = (await row.boundingBox())!
  for (const k of ['x', 'width'] as const) expect(Math.abs(after[k] - before[k]), `title row ${k} kept`).toBeLessThanOrEqual(1)
  expect(await page.locator('[data-peek-placeholder]').count()).toBe(0)
})

test('on a touch screen a tap on the card\'s text opens nothing', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true })
  try {
    const page = await context.newPage()
    const { card } = await openNeeds(page)
    const before = (await card.boundingBox())!
    for (const label of ['a tap', 'a tap again']) {
      await partOf(card, 'detail').tap({ position: { x: 20, y: 6 } })
      await page.waitForTimeout(400)
      expect(await peekMarks(page), `${label} opens nothing`).toBe(0)
      expect(near((await card.boundingBox())!, before), `${label}: the card kept its box`).toBe(true)
    }
    expect(await isCut(card, 'detail'), 'the detail is still cut').toBe(true)
  } finally {
    await context.close()
  }
})
