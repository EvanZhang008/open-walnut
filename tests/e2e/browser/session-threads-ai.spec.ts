/**
 * The question AI end to end on the fixture server (N1, C23, C53, C54, C11, C57).
 *
 * The fixture server is ephemeral, and the titler / takeaway services used to
 * start only on non-ephemeral servers: no browser test ever saw an AI title land,
 * so every new question read `Naming…` forever. The deterministic stub model
 * (WALNUT_THREAD_AI_STUB, see src/core/sessions/thread-ai-stub.ts) serves
 * pw-threads-ai-session: title = the first three words of the question in title
 * case; refine says `Answered: yes` when the question holds `stub-answered`;
 * takeaway = `Stub takeaway: <first 8 words of the answer>.`
 *
 * Every AI write reaches the open page through session:status-changed (the
 * record is refetched only on result, error and reconnect), so these tests also
 * pin that a background write shows without a reload.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, AI_SESSION, openThreadsSession, readRecord, resetThreadsFixture, selectPassage,
} from './threads-helpers'
import { AI_PASSAGE } from './threads-fixture'

const AI_TASK = 'pw-task-threads-ai'
const READY = 'How should the reader treat stale copies?'
const PASSAGE = AI_PASSAGE.slice(0, 44)

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/threads-ai/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

/** Forget every question the previous test asked on the AI session. */
async function resetAi(request: APIRequestContext): Promise<void> {
  const res = await request.patch(`/api/sessions/${AI_SESSION}`, { data: { thread_anchors: [], pinned_messages: [] } })
  expect(res.ok()).toBe(true)
  await resetThreadsFixture(request, AI_SESSION)
}

async function centreText(page: Page, panel: Locator, phrase: string): Promise<void> {
  await centreInHistory(page, panel, phrase)
}

async function askAbout(page: Page, panel: Locator): Promise<void> {
  await centreText(page, panel, PASSAGE)
  await selectPassage(page, panel, PASSAGE)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expectDepth(panel, 1)
}

function composer(panel: Locator): Locator {
  return panel.locator('.chat-input-textarea').first()
}

async function send(panel: Locator, text: string): Promise<void> {
  const box = composer(panel)
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

async function aiCalls(request: APIRequestContext): Promise<Record<string, number>> {
  const res = await request.get(`/api/v1/sessions/${AI_SESSION}/thread-ai-calls`)
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { calls: Record<string, number> }).calls
}

/** The one question head the AI session holds after a send. */
async function headOf(request: APIRequestContext): Promise<string> {
  let head = ''
  await expect.poll(async () => {
    const anchors = (await readRecord(request, AI_SESSION)).threadAnchors ?? []
    head = anchors[0]?.msgId ?? ''
    return anchors.length
  }).toBe(1)
  return head
}

test.describe('Question AI on the fixture server', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => { await resetAi(request) })

  test('the AI title lands at send, before a queued answer (N1, C23, C54)', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, AI_SESSION, AI_TASK, READY)
    const history = panel.locator('.session-history')
    // A root turn the mock answers after 25s: the question waits behind it, so a
    // title that shows before that answer was named at send, not at the answer.
    await send(panel, 'slow:25000 root turn for naming')
    await expect(history).toContainText('root turn for naming')
    const t0 = Date.now()
    await askAbout(page, panel)
    await send(panel, 'why merge once a minute')
    const title = panel.locator('.thread-stack-header .thread-stack-title')
    await expect(title).toHaveText('Why Merge Once', { timeout: 20_000 })
    const namedMs = Date.now() - t0
    await expect(panel.locator('.thread-stack-header .thread-naming')).toHaveCount(0)
    // The root answer (25s) has not arrived: naming did not wait for it.
    await expect(history).not.toContainText('processed your message: slow:25000')
    expect(namedMs, 'named while the answer was still queued').toBeLessThan(25_000)
    await shot(page, 'n1-named-before-answer')
    const head = await headOf(request)
    const meta = (await readRecord(request, AI_SESSION)).threadMeta ?? []
    const entry = meta.find((m) => m.headId === head)
    expect(entry?.titleState).toBe('done')
    expect(entry?.titleSource).toBe('ai')
    expect((await aiCalls(request))[head]).toBe(1)
    // The queued question is answered on its own page once the root turn ends,
    // so the next test starts on an idle session.
    await expect(history).toContainText('processed your message', { timeout: 90_000 })
  })

  test('refine says looks answered on the open page; Mark done writes the AI takeaway without a reload (C53, C11, C57)', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, AI_SESSION, AI_TASK, READY)
    const history = panel.locator('.session-history')
    await askAbout(page, panel)
    await send(panel, 'stub-answered what does compaction cost')
    await expect(history).toContainText('processed your message', { timeout: 60_000 })
    // The refine write after the answer reaches this open page (status-changed).
    const header = panel.locator('.thread-stack-header')
    await expect(header.locator('.thread-stack-suggested-label')).toBeVisible({ timeout: 30_000 })
    await expect(header.locator('.thread-stack-title')).toHaveText('Stub-answered What Does')
    const head = await headOf(request)
    // Title at send + refine at the first answer: two calls, never more (C53).
    await expect.poll(async () => (await aiCalls(request))[head]).toBe(2)
    await shot(page, 'c53-looks-answered')
    await header.locator('.thread-stack-done').click()
    await expectDepth(panel, 0)
    const row = panel.locator('.thread-asked-row.is-resolved')
    await expect(row).toHaveCount(1)
    // The AI takeaway replaces the fallback on the open page (C11, C57).
    await expect(row.locator('.thread-asked-takeaway')).toHaveText(/^Stub takeaway: /, { timeout: 30_000 })
    const meta = ((await readRecord(request, AI_SESSION)).threadMeta ?? []).find((m) => m.headId === head)
    expect(meta?.status).toBe('resolved')
    expect(meta?.takeawaySource).toBe('ai')
    expect((await aiCalls(request))[head]).toBe(3)
    await row.click()
    await expectDepth(panel, 1)
    await expect(panel.locator('[data-thread-strip="resolved"] .thread-strip-text')).toHaveText(/^Stub takeaway: /)
    await shot(page, 'c57-ai-takeaway')
  })

  test('with the gate closed a new question never shows Naming…, not even for a frame (C23)', async ({ page, request }) => {
    const sendSession = 'pw-threads-send-session'
    const res = await request.patch(`/api/sessions/${sendSession}`, { data: { thread_anchors: [], pinned_messages: [] } })
    expect(res.ok()).toBe(true)
    await boot(page)
    const panel = await openThreadsSession(page, sendSession, 'pw-task-threads-send', 'Phase three only verifies checksums.')
    const phrase = 'rewrites the index in place'
    await centreText(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expectDepth(panel, 1)
    // Count every animation frame that renders a `Naming…` from the send on.
    await page.evaluate(() => {
      const w = window as unknown as { __namingFrames: number; __frames: number; __stop: boolean }
      w.__namingFrames = 0; w.__frames = 0; w.__stop = false
      const tick = () => {
        if (w.__stop) return
        w.__frames++
        if (document.querySelector('.thread-naming')) w.__namingFrames++
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await send(panel, 'what does in place mean here')
    await expect.poll(async () => {
      const meta = (await readRecord(request, sendSession)).threadMeta ?? []
      return meta[0]?.titleState ?? ''
    }).toBe('unavailable')
    await page.waitForTimeout(1500)
    const counts = await page.evaluate(() => {
      const w = window as unknown as { __namingFrames: number; __frames: number; __stop: boolean }
      w.__stop = true
      return { naming: w.__namingFrames, frames: w.__frames }
    })
    expect(counts.frames).toBeGreaterThan(20)
    expect(counts.naming, 'frames showing Naming…').toBe(0)
    await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 60_000 })
  })
})
