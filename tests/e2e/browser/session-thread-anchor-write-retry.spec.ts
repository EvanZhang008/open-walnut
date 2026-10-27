/**
 * A question's anchor write that fails never strands the question (2026-10-27
 * live run in WebKit: a 3 s server stall failed the PATCH with "Load failed",
 * the anchor was rolled back while the message itself went out, the card fell
 * back to the main conversation, and the next round typed in it went there as a
 * plain message). The write is retried; when every try fails the question stays
 * on screen as unsaved, the next round still goes into it with its tag, and the
 * anchor is stored by the next write, or after a reload.
 *
 * Chromium and WebKit. The reload fixture session (its sends reach the transcript).
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { centreInHistory, openThreadsSession, readRecord, resetThreadsFixture, selectPassage } from './threads-helpers'
import { RELOAD_PASSAGE, RELOAD_SESSION } from './threads-fixture'

const RELOAD_TASK = 'pw-task-threads-reload'
const READY = 'What does the reader do after a rotation?'
const PHRASE = RELOAD_PASSAGE.slice(0, 40)
const UNSAVED_KEY = `walnut:thread-question-unsaved.v1:${RELOAD_SESSION}`

/** Fail the next `n` PATCHes that write thread anchors (a network error, as a
 *  dropped connection gives); `n` Infinity fails them all. Returns the count. */
async function failAnchorWrites(page: Page, n: number): Promise<{ failed: () => number }> {
  let failed = 0
  await page.route(`**/api/sessions/${RELOAD_SESSION}`, async (route) => {
    const req = route.request()
    if (req.method() === 'PATCH' && failed < n && (req.postData() ?? '').includes('"thread_anchors"')) {
      failed += 1
      await route.abort('failed')
      return
    }
    await route.fallback()
  })
  return { failed: () => failed }
}

/** The passage paints a mark (any state). */
const markOnPassage = (page: Page) => page.evaluate((phrase) => {
  for (const [name, h] of CSS.highlights ?? new Map()) {
    if (!name.startsWith('thread-mark')) continue
    if (Array.from(h as unknown as Iterable<Range>).some((r) => r.toString().includes(phrase))) return name
  }
  return null
}, PHRASE)

const unsavedHeads = (page: Page) => page.evaluate((k) => {
  const raw = localStorage.getItem(k)
  return raw ? (JSON.parse(raw) as Array<{ anchor: { msgId: string } }>).map((q) => q.anchor.msgId) : []
}, UNSAVED_KEY)

const storedAnchorIds = async (request: APIRequestContext) => (await readRecord(request, RELOAD_SESSION)).threadAnchors?.map((a) => a.msgId) ?? []

async function askOnPassage(page: Page, panel: Locator, question: string): Promise<Locator> {
  await centreInHistory(page, panel, PHRASE)
  await selectPassage(page, panel, PHRASE)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  const card = panel.locator('.thread-card')
  await expect(card).toHaveAttribute('data-draft', 'true')
  await card.locator('.thread-card-input').fill(question)
  await card.locator('.thread-card-input').press('Enter')
  return card
}

const cardIdle = (card: Locator) => expect.poll(async () => (await card.getAttribute('data-answering')) !== 'true'
  && (await card.getAttribute('data-waiting')) !== 'true' && (await card.getAttribute('data-draft')) !== 'true', { timeout: 60_000 }).toBe(true)

async function open(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.evaluate((k) => localStorage.removeItem(k), UNSAVED_KEY)
  return openThreadsSession(page, RELOAD_SESSION, RELOAD_TASK, READY, { view: 'linear' })
}

test.describe('a failed question write keeps the question', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, RELOAD_SESSION) })
  test.afterEach(async ({ request }) => { await resetThreadsFixture(request, RELOAD_SESSION) })

  test('one failed try is retried and the anchor is stored', async ({ page, request }) => {
    const panel = await open(page)
    const writes = await failAnchorWrites(page, 1)
    await askOnPassage(page, panel, 'What drains first?')
    await expect.poll(() => writes.failed()).toBe(1)
    await expect.poll(() => unsavedHeads(page), { timeout: 15_000 }).toEqual([])
    const stored = await storedAnchorIds(request)
    expect(stored.length).toBeGreaterThan(0)
    expect(await markOnPassage(page)).not.toBeNull()
  })

  test('every try failing: the question stays, the next round goes into it with its tag, then both are stored', async ({ page, request }) => {
    const panel = await open(page)
    const before = await storedAnchorIds(request)
    const writes = await failAnchorWrites(page, 3)
    const card = await askOnPassage(page, panel, 'What drains first?')
    // Three tries (1 s and 3 s apart), all failed.
    await expect.poll(() => writes.failed(), { timeout: 15_000 }).toBe(3)
    await page.waitForTimeout(800)
    const [head] = await unsavedHeads(page)
    expect(head, 'the question is kept as unsaved').toBeTruthy()
    expect(await storedAnchorIds(request)).not.toContain(head)
    // Still the question: its mark, its card, its own composer target.
    await expect.poll(() => markOnPassage(page)).not.toBeNull()
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-input')).not.toHaveAttribute('placeholder', /Main conversation/)
    await expect(page.getByText('This question is no longer in the transcript.')).toHaveCount(0)
    await cardIdle(card)

    // The second round, typed in the same card, goes into the same question.
    await card.locator('.thread-card-input').fill('And after the rotation?')
    await card.locator('.thread-card-input').press('Enter')
    await expect.poll(async () => (await storedAnchorIds(request)).includes(head), { timeout: 20_000 }).toBe(true)
    const stored = await storedAnchorIds(request)
    expect(stored.length, 'the question and its follow-up are both anchored').toBe(before.length + 2)
    await expect.poll(() => unsavedHeads(page)).toEqual([])
    const rec = await readRecord(request, RELOAD_SESSION)
    expect(rec.threadMeta?.find((m) => m.headId === head), 'the question\'s meta (its number) is stored too').toMatchObject({ seq: expect.any(Number) })
    const history = await (await page.request.get(`/api/sessions/${RELOAD_SESSION}/history`)).json() as { messages: Array<{ role: string; text?: string }> }
    const second = history.messages.filter((m) => m.role === 'user' && (m.text ?? '').includes('And after the rotation?'))
    expect(second.length).toBe(1)
    expect(second[0].text, 'the follow-up carries its question tag').toMatch(/\[Question Q\d+\]/)
    expect(await markOnPassage(page)).not.toBeNull()
  })

  test('every try failing, then a reload: the question comes back and is stored', async ({ page, request }) => {
    let panel = await open(page)
    const writes = await failAnchorWrites(page, Number.POSITIVE_INFINITY)
    const card = await askOnPassage(page, panel, 'What drains first?')
    await expect.poll(() => writes.failed(), { timeout: 15_000 }).toBe(3)
    await page.waitForTimeout(800)
    const [head] = await unsavedHeads(page)
    expect(head).toBeTruthy()
    await cardIdle(card)
    await page.unroute(`**/api/sessions/${RELOAD_SESSION}`)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    panel = await openThreadsSession(page, RELOAD_SESSION, RELOAD_TASK, READY, { view: 'linear' })
    await expect.poll(async () => (await storedAnchorIds(request)).includes(head), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => unsavedHeads(page)).toEqual([])
    await centreInHistory(page, panel, PHRASE)
    await expect.poll(() => markOnPassage(page)).not.toBeNull()
  })
})
