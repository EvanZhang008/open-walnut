/**
 * Scenarios for ask-chat-earlier.spec.ts (Chromium) and its WebKit twin (the Mac
 * app's engine): an ask opened in the Ask Walnut slot shows what its chat said
 * before the session it opens on. A `test.use` browser pin only applies at a spec
 * file's top level, hence two spec files over one set of scenarios.
 *
 * Real: the fixture server's lane session records, chat-history files and the
 * continued chat's transcript (chat-earlier-fixture.ts), the
 * GET /api/v1/sessions/:id/chat-earlier assembly, the panel and its timeline.
 * Added on this page only: the two ask tasks naming those sessions (the shared
 * board has no asks, and other specs count them).
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { openAskWalnutDrawer, openChatOnLoad } from './draft-helpers'
import {
  EARLIER_CONT_SESSION, EARLIER_OLD_SESSION, EARLIER_OLD_TURNS, earlierOldAnswer, earlierOldQuestion,
} from './chat-earlier-fixture'

export const SHOTS = process.env.CHAT_EARLIER_SHOT_DIR ?? '/tmp/lane-ask/chat-earlier'

const OLD_ASK = { id: 'pw-ask-earlier-old', title: 'Frozen dumplings (old phone chat)' }
const CONT_ASK = { id: 'pw-ask-earlier-cont', title: 'Shade plants (continued chat)' }

function askTask(ask: { id: string; title: string }, sessionId: string, hoursAgo: number): Record<string, unknown> {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
  return {
    id: ask.id, title: ask.title, project: 'Ask Walnut', walnut_agent: true,
    phase: 'NEED_ACTION', status: 'in_progress', priority: 'none',
    created_at: at, updated_at: at, last_session_update: at,
    session_id: sessionId, session_ids: [sessionId], active_session_ids: [],
    description: '', summary: '', note: '', subtasks: [],
  }
}

/** The two asks appended to every task list read of this page. */
export async function addEarlierAsks(page: Page): Promise<void> {
  await page.route('**/api/tasks*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() !== 'GET' || url.pathname !== '/api/tasks') { await route.fallback(); return }
    const response = await route.fetch()
    let body: { tasks?: unknown[] }
    try { body = await response.json() } catch { await route.fulfill({ response }); return }
    if (!Array.isArray(body.tasks)) { await route.fulfill({ response }); return }
    body.tasks = [...body.tasks, askTask(OLD_ASK, EARLIER_OLD_SESSION, 1), askTask(CONT_ASK, EARLIER_CONT_SESSION, 2)]
    const headers = { ...response.headers() }
    delete headers['content-length']
    delete headers['content-encoding']
    await route.fulfill({ status: response.status(), headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  })
}

const slotSession = (page: Page): Locator => page.locator('[data-testid="ask-walnut-session"]')

async function openAsk(page: Page, title: string, sessionId: string): Promise<Locator> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  // The chat spot starts hidden on a browser that never chose: boot as a user
  // who opened it once.
  await openChatOnLoad(page)
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  const drawer = await openAskWalnutDrawer(page).catch((err: unknown) => {
    throw new Error(`no Ask Walnut slot; page errors: ${JSON.stringify(errors.slice(0, 8))}; ${String(err)}`)
  })
  await drawer.locator('[data-testid="ask-walnut-drawer-item"]', { hasText: title }).click()
  const session = slotSession(page)
  await expect(session).toHaveAttribute('data-session-id', sessionId, { timeout: 20_000 })
  return session
}

/** Wheel the timeline up (over its middle) until `target` sits inside it. */
async function wheelUntilInView(page: Page, scroller: Locator, target: Locator): Promise<void> {
  const box = await scroller.boundingBox()
  if (!box) throw new Error('timeline has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 40; i++) {
    const t = await target.boundingBox()
    if (t && t.y >= box.y + 40 && t.y + t.height <= box.y + box.height - 40) return
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(80)
  }
  throw new Error('never scrolled the target into the timeline')
}

/** Text of every row in the earlier block, top to bottom. */
async function earlierTexts(block: Locator): Promise<string[]> {
  return (await block.locator('[data-testid="chat-earlier-row"]').allInnerTexts()).map((t) => t.trim())
}

export async function oldChatOpensWithItsHistory(page: Page, engine: string): Promise<void> {
  const failed: string[] = []
  page.on('response', (r) => { if (r.url().includes('/chat-earlier') && r.status() !== 200) failed.push(`${r.status()} ${r.url()}`) })
  page.on('pageerror', (e) => failed.push(`pageerror ${e.message}`))
  await addEarlierAsks(page)
  const session = await openAsk(page, OLD_ASK.title, EARLIER_OLD_SESSION)

  const block = session.locator('[data-testid="chat-earlier"]')
  await expect(block).toBeVisible({ timeout: 20_000 })
  await expect(block.locator('.chat-earlier-label')).toHaveText('Earlier in this chat')
  // The blank page this replaces said exactly this.
  await expect(session.getByText('No conversation history found')).toHaveCount(0)
  // …or, for a warm session with no transcript file, this: false over a readable chat.
  await expect(session.getByText('History unavailable')).toHaveCount(0)
  await expect(block.locator('.chat-earlier-divider')).toHaveText('This session')

  // 60 rows: the newest 40 first, the rest one click away.
  const total = EARLIER_OLD_TURNS * 2
  await expect(block.locator('[data-testid="chat-earlier-row"]')).toHaveCount(40)
  const more = block.getByRole('button', { name: /Show 20 earlier messages/ })
  await expect(more).toBeVisible()
  let texts = await earlierTexts(block)
  expect(texts[texts.length - 1]).toBe(earlierOldAnswer(EARLIER_OLD_TURNS).replace(/\*\*/g, ''))
  expect(texts[0]).toBe(earlierOldQuestion(EARLIER_OLD_TURNS - 19))
  // Markdown renders (the answer's bold), it is not shown raw.
  await expect(block.locator('[data-testid="chat-earlier-row"] strong').last()).toHaveText('bold')
  await session.screenshot({ path: `${SHOTS}/${engine}-01-old-chat-open.png` })

  // A real wheel, as a reader scrolls: the timeline follows its bottom and snaps
  // a programmatic scroll (scrollIntoView) straight back.
  await wheelUntilInView(page, session.locator('.session-history'), more)
  await more.click()
  await expect(block.locator('[data-testid="chat-earlier-row"]')).toHaveCount(total)
  // The reader stays where they were: the row that headed the list is still on
  // screen, with the newly shown ones above it.
  const formerHead = block.getByText(earlierOldQuestion(EARLIER_OLD_TURNS - 19), { exact: true })
  await expect(formerHead).toBeInViewport()
  await session.screenshot({ path: `${SHOTS}/${engine}-01b-after-show-earlier.png` })
  await expect(more).toHaveCount(0)
  texts = await earlierTexts(block)
  expect(texts[0]).toBe(earlierOldQuestion(1))
  expect(texts.filter((t, i) => i % 2 === 0)).toEqual(
    Array.from({ length: EARLIER_OLD_TURNS }, (_, i) => earlierOldQuestion(i + 1)),
  )
  // The composer is still where a reply goes.
  await expect(session.locator('textarea').first()).toBeVisible()
  expect(failed).toEqual([])
}

export async function continuedChatPutsTheEarlierPartAboveTheSession(page: Page, engine: string): Promise<void> {
  await addEarlierAsks(page)
  const session = await openAsk(page, CONT_ASK.title, EARLIER_CONT_SESSION)
  const own = session.getByText('Hellebores flower in late winter.')
  await expect(own).toBeVisible({ timeout: 20_000 })
  const block = session.locator('[data-testid="chat-earlier"]')
  await expect(block).toBeVisible({ timeout: 20_000 })
  expect(await earlierTexts(block)).toEqual(['Which plants like shade?', 'Ferns, hostas and hellebores.'])
  await expect(block.getByRole('button', { name: /earlier messages/ })).toHaveCount(0)

  // Above the session's own first message, and the session's turn stays in view.
  const firstOwn = session.getByText('And which of them flower?')
  const blockBox = await block.boundingBox()
  const ownBox = await firstOwn.boundingBox()
  expect(blockBox && ownBox).toBeTruthy()
  expect(blockBox!.y + blockBox!.height).toBeLessThanOrEqual(ownBox!.y + 1)
  await expect(own).toBeInViewport()
  // Shown once: the earlier rows are not repeated inside the session's timeline.
  await expect(session.getByText('Ferns, hostas and hellebores.')).toHaveCount(1)
  await session.screenshot({ path: `${SHOTS}/${engine}-02-continued-chat.png` })
}
