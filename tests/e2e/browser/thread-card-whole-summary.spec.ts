/**
 * Every thread card shows its whole summary, packed tight (2026-11-20, the user on a lead's
 * Threads: "the threa over here shoud show all , not just 2 line only the one show on top",
 * then "shoudl be narrow"). A thread of a task below (PoppedThreadCard, the one ask card) read
 * two lines and "…" while the lead's own card above it read whole.
 *
 *  1. Class guard: no text block on any thread card is cut to two lines or fewer. Every element
 *     on every card is measured, so a new two-line clamp anywhere on a card fails here.
 *  2. A summary reads whole on both kinds of card, a very long one too: no block on a card in the
 *     Threads view stops short and scrolls inside itself (2026-11-21, a review on his data: a
 *     popped card stopped at its third list item with no sign of more). Only the top of a chat
 *     bounds it, with a fade and Show all (top-thread.spec.ts).
 *  3. The cards are packed tight: small padding and gaps.
 *
 * WALNUT_THREAD_CARD_TEXTS may name a JSON file of `{ title, reply }` rows to fill the cards with
 * (a copy of real threads, for a before/after picture); the committed run uses the invented ones.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { restoreOneCard, setOneCard, type OneCardWas } from './one-card-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Whole summary ${STAMP}`
const made: string[] = []
let oneCardWas: OneCardWas | null = null
let popUpWas: boolean | null = null
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

const SENTENCE = 'The garden shed roof needs new boards before the rain, and the boards from the second shop are cheaper but take a week longer to arrive. '
const MEDIUM = `Do you want the cheaper boards? I recommend them. ${SENTENCE.repeat(4)}Reply yes and I order them today.`
const LONG = `Pick the boards for the shed. ${SENTENCE.repeat(40)}`
type Row = { title: string; reply: string }
const INVENTED: Row[] = [
  { title: `Shed roof boards ${STAMP}`, reply: MEDIUM },
  { title: `Fence paint colour ${STAMP}`, reply: `Which paint for the fence? ${SENTENCE.repeat(3)}` },
  { title: `Very long plan ${STAMP}`, reply: LONG },
]
const REAL: Row[] | null = process.env.WALNUT_THREAD_CARD_TEXTS
  ? (JSON.parse(fs.readFileSync(process.env.WALNUT_THREAD_CARD_TEXTS, 'utf8')) as Row[])
  : null
const ROWS = REAL ?? INVENTED
const OWN: Row = REAL?.[0] ?? { title: `Own thread ${STAMP}`, reply: MEDIUM }
const BELOW = REAL ? REAL.slice(1) : ROWS

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ viewport: { width: 1440, height: 900 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`
const WHY = { user_kind: 'user_own', user_kind_why: 'It spends his own money.' }

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function experimental(request: APIRequestContext, key: string, on: boolean | null): Promise<boolean> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const was = cfg.config?.experimental?.[key] === true
  if (on !== null) expect((await request.put('/api/config', { data: { experimental: { [key]: on } } })).ok()).toBe(true)
  return was
}

async function openThread(request: APIRequestContext, taskId: string, row: Row, state: 'needs' | 'answered'): Promise<void> {
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${taskId}/threads/open`, {
    title: row.title, text: row.title, state, from: 'node', ...WHY,
  })
  const res = await request.patch(`/api/v1/tasks/${taskId}/threads/${opened.thread.id}`, { data: { reply: row.reply, state, ...WHY } })
  expect(res.ok(), await res.text()).toBe(true)
}

test.beforeAll(async ({ request }) => {
  oneCardWas = await setOneCard(request, true)
  popUpWas = await experimental(request, 'threads_pop_up', true)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, `More work ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  const lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(lead)
  await openThread(request, lead, OWN, 'answered')
  for (const [i, row] of BELOW.entries()) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Team ${i + 1} ${STAMP}`, project: PROJECT, source: 'local', parent_task_id: lead })
    made.push(task.id)
    expect((await request.patch(`/api/tasks/${task.id}`, { data: { threads_on: true } })).ok()).toBe(true)
    await openThread(request, task.id, row, 'needs')
  }
})

test.afterAll(async ({ request }) => {
  await restoreOneCard(request, oneCardWas)
  if (popUpWas !== null) await experimental(request, 'threads_pop_up', popUpWas)
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(PROJECT))
}

/** Every text block on a card cut to two lines or fewer (a line clamp of 1 or 2 that hides words). */
async function cutToTwoLines(page: Page): Promise<string[]> {
  return page.locator('[data-testid="org-thread"]').evaluateAll((cards) => {
    const out: string[] = []
    for (const card of cards) {
      for (const el of [card, ...card.querySelectorAll('*')] as HTMLElement[]) {
        const s = getComputedStyle(el)
        const clamp = Number.parseInt(s.getPropertyValue('-webkit-line-clamp'), 10)
        if (!(clamp >= 1 && clamp <= 2)) continue
        if (s.display === 'none' || el.scrollHeight <= el.clientHeight + 1) continue
        out.push(`${el.className || el.tagName} (${clamp} lines) on ${card.getAttribute('data-thread-id')}: ${(el.textContent ?? '').slice(0, 40)}`)
      }
    }
    return out
  })
}

test('every thread card shows its whole summary, packed tight', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const popped = page.getByTestId('org-thread-popped')
  await expect(popped).toHaveCount(BELOW.length, { timeout: 20_000 })
  await expect(page.getByTestId('org-thread-reply').first()).toBeVisible()
  await page.waitForTimeout(500)
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/thread-card-whole-summary-${REAL ? 'real' : 'invented'}-${test.info().project.name}.png` })

  // 1. Nothing on any card is cut to two lines.
  expect(await cutToTwoLines(page)).toEqual([])

  if (!REAL) {
    // 2. Every summary reads whole, the very long one too.
    const detail = (title: string) => page.locator('[data-testid="org-thread-popped"]', { hasText: title }).locator('.ask-card-detail')
    const medium = await detail(INVENTED[0].title).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
    expect(medium.sh).toBeLessThanOrEqual(medium.ch + 1)
    await expect(detail(INVENTED[0].title)).toContainText('Reply yes and I order them today.')
    const long = await detail(INVENTED[2].title).evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
    expect(long.ch).toBeGreaterThan(400)
    expect(long.sh).toBeLessThanOrEqual(long.ch + 1)
    // The class: no word block on any card in the Threads view is cut short with more inside it.
    const cut = await page.getByTestId('org-rail').locator('[data-testid="org-thread"]').evaluateAll((cards) => cards.flatMap((card) =>
      [...card.querySelectorAll<HTMLElement>('.ask-card-detail, .ask-card-question, .org-thread-summary')]
        .filter((el) => getComputedStyle(el).display !== 'none' && el.scrollHeight > el.clientHeight + 1)
        .map((el) => `${el.className} on ${card.getAttribute('data-thread-id')}`)))
    expect(cut).toEqual([])
    // The lead's own card reads its summary whole too.
    const own = await page.getByTestId('org-thread-reply').first().evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
    expect(own.sh).toBeLessThanOrEqual(own.ch + 1)
  }

  // 3. Packed tight: the card's padding and the gaps between its parts stay small.
  const pack = await page.locator('[data-testid="org-thread"]').first().evaluate((el) => {
    const s = getComputedStyle(el)
    return { pad: Number.parseFloat(s.paddingTop), gap: Number.parseFloat(s.rowGap) }
  })
  expect(pack.pad).toBeLessThanOrEqual(10)
  expect(pack.gap).toBeLessThanOrEqual(6)
  expect(pageErrors).toEqual([])
})
