/**
 * The line at the top of a chat also says how many threads are being worked on (experiment
 * threads_each_question; web/src/components/org/top-thread-model.ts hiddenLine). 2026-11-25: a
 * question of his still being worked on sat in the folded Working group of the Threads view, the
 * line read "1 thread (1 needs you)", and he concluded his question had no thread.
 *
 *  A. A lead on the Org page, 1280 x 800, every switch he runs on: one thread that needs him and two
 *     being worked on. The bar reads "1 / 1 · 2 working"; hidden, the line reads
 *     "1 thread (1 needs you) · 2 working". The one that needs him closes: "2 working" alone (today the
 *     top showed nothing), and its click opens the Threads beside the chat with Working open. One of
 *     them is answered: "1 thread · 1 working". Each change swaps only the words: the line keeps its
 *     height and the chat its scroll position.
 *  B. The same chat in a Home column about 400 px wide, light and dark: the bar and the line fit.
 *  C. The switch off: today's words, and no line for a chat whose threads are all being worked on.
 * The fixture is shared: the switches are this page's own (its GET /api/config), the tasks its own.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { glassOn } from './session-scroll-glass-helpers'
import { startProofVideo } from './proof-video'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Bench ${STAMP}`
const made: string[] = []
const ids = { lead: '', sid: '', needs: '', work: [] as string[], side: [] as string[] }
const FRAMES = process.env.TOP_WORKING_FRAMES ?? `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/proof/frames-bar`
let cwd = ''

/** What he runs: every experiment the top reads on. Off drops threads_each_question alone. */
const ON = { top_thread: true, action_needed_everywhere: true, brief_off: true, threads_each_question: true }
const OFF = { ...ON, threads_each_question: false }

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)
test.use({ viewport: { width: 1280, height: 800 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function send<T>(request: APIRequestContext, method: 'post' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function startSession(request: APIRequestContext, taskId: string): Promise<string> {
  await send(request, 'post', '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return sid
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** A decision the node asks him (as its session does with thread_create). */
async function needsThread(request: APIRequestContext, title: string): Promise<string> {
  const why = { user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes.', separate_reason: 'Each card here is a decision of its own.' }
  const { thread } = await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, { title, text: `${title}?`, state: 'needs', from: 'node', ...why }, ids.sid)
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${thread.id}`, { reply: `${title}: pick one.`, state: 'needs', ...why }, ids.sid)
  return thread.id
}

/** A question of his the node has not answered yet: Working. */
async function workingThread(request: APIRequestContext, text: string): Promise<string> {
  const out = await send<{ thread: { id: string; state: string }; created: boolean }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads`, { text })
  expect(out.created, 'a thread of its own').toBe(true)
  return out.thread.id
}

/** A dense chat, so its timeline scrolls and a moved row shows. */
function denseRows(sid: string, n = 40) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    msgId: `${sid}-m${i}`,
    text: i % 2 === 0 ? `Question ${i}: how does the bench stand?` : `## Answer ${i}\n\nA paragraph of a real reply, long enough to wrap once in a column.\n\nFinal line of answer ${i}.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }))
}

async function denseChat(page: Page, sid: string): Promise<void> {
  const messages = denseRows(sid)
  await page.route(`**/api/sessions/${sid}/history**`, (route) => route.fulfill({
    json: { messages, total: messages.length, ...(route.request().url().includes('source=streams') ? {} : { cursor: messages.length }), delta: false },
  }))
}

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(PROJECT))
}

/** The top of a chat, cropped, as a frame for the proof. */
async function frame(page: Page, scope: Locator, name: string, height = 220): Promise<void> {
  fs.mkdirSync(FRAMES, { recursive: true })
  const box = (await scope.boundingBox())!
  await page.screenshot({ path: `${FRAMES}/${name}.png`, clip: { x: box.x, y: box.y, width: Math.min(box.width, 1280), height: Math.min(height, box.height) } })
}

/** The line's height, the chat's scroll and where the row he reads (readMiddle) sits on screen. */
async function still(chat: Locator): Promise<{ line: number; top: number; scroll: number; row: number }> {
  return chat.evaluate((root) => {
    const hist = root.querySelector<HTMLElement>('.session-history')!
    const row = hist.querySelector<HTMLElement>('[data-pw-reading]')
    return {
      line: Math.round(root.querySelector<HTMLElement>('[data-testid="top-thread"]')!.getBoundingClientRect().height),
      top: Math.round(root.querySelector<HTMLElement>('[data-testid="session-top"]')!.getBoundingClientRect().height),
      scroll: Math.round(hist.scrollTop),
      row: Math.round(row?.getBoundingClientRect().top ?? NaN),
    }
  })
}

/** He scrolls the chat up with the wheel and reads in the middle: far from its end, a row near the middle marked. */
async function readMiddle(chat: Locator): Promise<void> {
  const hist = chat.locator('.session-history').first()
  await hist.hover()
  // From the end, about two screens up: the same place whatever came before.
  await chat.page().mouse.wheel(0, 20_000)
  await chat.page().waitForTimeout(400)
  for (let i = 0; i < 2; i++) { await chat.page().mouse.wheel(0, -400); await chat.page().waitForTimeout(150) }
  await chat.page().waitForTimeout(600)
  const at = await hist.evaluate((el) => {
    for (const old of el.querySelectorAll('[data-pw-reading]')) old.removeAttribute('data-pw-reading')
    const box = el.getBoundingClientRect()
    const mid = box.top + box.height / 2
    const row = [...el.querySelectorAll<HTMLElement>('p, h2')].find((r) => { const b = r.getBoundingClientRect(); return b.top <= mid && b.bottom >= mid - 40 })
    row?.setAttribute('data-pw-reading', '')
    return { fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), fromTop: Math.round(el.scrollTop), row: row?.textContent ?? null }
  })
  console.log(`[top-working] reading ${JSON.stringify(at)}`)
  expect(at.fromEnd, 'scrolled away from the end').toBeGreaterThan(600)
  expect(at.fromTop, 'and from the top').toBeGreaterThan(300)
  expect(at.row, 'a row near the middle').not.toBeNull()
}

/** Nothing in the top runs past its own box (the words cut only where the title ellipsis is). */
async function fits(scope: Locator): Promise<void> {
  const over = await scope.evaluate((root) => {
    const r = root.getBoundingClientRect()
    return [...root.querySelectorAll<HTMLElement>('.top-thread-bar > *, .top-thread-line > *')]
      .filter((el) => el.getClientRects().length && (el.getBoundingClientRect().right > r.right + 0.5 || el.getBoundingClientRect().left < r.left - 0.5))
      .map((el) => el.textContent)
  })
  expect(over, 'every part of the bar and the line inside the top').toEqual([])
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks and threads: run them on a test server, never production')
  cwd = `${(await discoverBrowserFixture(TEST_PORT)).fixtureRoot}/projects/walnut`
  // A project with two teams gets a lead (org_contact).
  for (const title of [`Potting bench ${STAMP}`, `Seed trays ${STAMP}`]) {
    const id = (await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id
    made.push(id)
    ids.side.push(await startSession(request, id))
  }
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  ids.sid = await startSession(request, ids.lead)
  ids.needs = await needsThread(request, `Cedar or pine ${STAMP}`)
  ids.work.push(await workingThread(request, `How long does the cedar take to dry ${STAMP}?`))
  ids.work.push(await workingThread(request, `Which hinges fit the lid ${STAMP}?`))
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('on: the line says how many are being worked on, and changes only its words', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await isolateUiPrefs(page)
  await glassOn(page, ON)
  await denseChat(page, ids.sid)
  const video = await startProofVideo(page)
  await loadHome(page)
  await openLead(page)
  const chat = page.getByTestId('org-chat')
  const top = chat.getByTestId('top-thread')
  // The side bar shows the Threads: the top draws none of them again; hidden, the top comes.
  const toggle = page.getByTestId('org-detail').getByTestId('org-rail-toggle')
  await expect(page.getByTestId('org-rail')).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  await expect(page.getByTestId('org-rail')).toHaveCount(0)
  await video.caption('One thread needs him, two of his questions are being worked on')
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 1', { timeout: 30_000 })
  await expect(top.getByTestId('top-thread-working')).toHaveText('2 working')
  await expect(top).toHaveAttribute('data-thread-id', ids.needs)
  await fits(top)
  await video.hold()
  await frame(page, chat, '1-bar-1280')

  await video.caption('Hidden: "1 thread (1 needs you) · 2 working"')
  await top.getByTestId('top-thread-hide').click()
  const count = top.getByTestId('top-thread-count')
  await expect(count).toHaveText('1 thread (1 needs you) · 2 working')
  await fits(top)
  await video.hold()
  await frame(page, chat, '2-hidden-needs-and-working-1280', 160)

  // The one that needs him is closed: the working ones keep the line, its words alone change.
  await readMiddle(chat)
  const before = await still(chat)
  await video.caption('He closes the one that needs him: "2 working" stays, nothing moves')
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.needs}`, { close: 'acked' })
  await expect(count).toHaveText('2 working', { timeout: 30_000 })
  await expect(top.getByTestId('top-thread-show')).toContainText('Open')
  await page.waitForTimeout(600)
  const alone = await still(chat)
  console.log(`[top-working] needs closed: ${JSON.stringify({ before, alone })}`)
  expect(alone).toEqual(before)
  await video.hold()
  await frame(page, chat, '3-working-alone-1280', 160)

  // Its click opens the Threads beside the chat, Working open, the first of them in view.
  await video.caption('A click opens the Threads, Working open')
  await top.getByTestId('top-thread-show').click()
  const rail = page.getByTestId('org-rail')
  await expect(rail).toBeVisible({ timeout: 15_000 })
  const working = rail.locator('[data-testid="org-thread-group"][data-group="working"]')
  await expect(working).toHaveAttribute('data-open', 'true', { timeout: 15_000 })
  await expect(working.getByTestId('org-thread-group-count')).toHaveText('2')
  await expect(working.locator(`[data-testid="org-thread"][data-thread-id="${ids.work[0]}"]`)).toBeInViewport()
  await expect(chat.getByTestId('top-thread')).toHaveCount(0)
  await video.hold()
  await frame(page, page.getByTestId('org-detail'), '4-threads-working-open', 520)

  // Back to the chat: one is answered, "1 thread · 1 working", the line and the chat still.
  await toggle.click()
  await expect(count).toHaveText('2 working', { timeout: 15_000 })
  await readMiddle(chat)
  const mid = await still(chat)
  await video.caption('One is answered: "1 thread · 1 working", nothing moves')
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.work[0]}`, { title: `Cedar drying ${STAMP}`, reply: 'Two weeks in the shed, turned once.', state: 'answered' })
  await expect(count).toHaveText('1 thread · 1 working', { timeout: 30_000 })
  await expect(top.getByTestId('top-thread-show')).toContainText('Show')
  await page.waitForTimeout(600)
  const answered = await still(chat)
  console.log(`[top-working] one answered: ${JSON.stringify({ mid, answered })}`)
  expect(answered).toEqual(mid)
  await video.hold()
  await frame(page, chat, '5-answered-and-working-1280', 160)

  // Show brings the card back (and leaves the choice as it was found).
  await top.getByTestId('top-thread-show').click()
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 1')
  await expect(top.getByTestId('top-thread-working')).toHaveText('1 working')
  await video.hold()
  await video.stop('thread-bar-working-chromium')
  expect(errors).toEqual([])
})

test('on, in a Home column about 400 px wide, light and dark: the bar and the line fit', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  ids.needs = await needsThread(request, `Oil or wax the top ${STAMP}`)
  // Three columns in a window this wide: each about 420 px.
  await page.setViewportSize({ width: 1180, height: 800 })
  await isolateUiPrefs(page)
  await glassOn(page, ON)
  await denseChat(page, ids.sid)
  await seedColumns(page, [ids.sid, ...ids.side])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const width = Math.round((await panel.boundingBox())!.width)
  console.log(`[top-working] column width ${width}`)
  expect(width).toBeLessThanOrEqual(440)
  const top = panel.getByTestId('top-thread')
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 2', { timeout: 30_000 })
  await expect(top.getByTestId('top-thread-working')).toHaveText('1 working')
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 2')
    await fits(top)
    await top.getByTestId('top-thread-hide').click()
    await expect(top.getByTestId('top-thread-count')).toHaveText('2 threads (1 needs you) · 1 working')
    await fits(top)
    await frame(page, panel, `6-narrow-hidden-${scheme}`, 200)
    await top.getByTestId('top-thread-show').click()
    await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 2')
    if (scheme === 'dark') await frame(page, panel, '7-narrow-bar-dark', 260)
  }
  expect(errors).toEqual([])
})

test('off: today\'s words, and no line for a chat whose threads are all being worked on', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.needs}`, { close: 'acked' })
  await isolateUiPrefs(page)
  await glassOn(page, OFF)
  await denseChat(page, ids.sid)
  await loadHome(page)
  await openLead(page)
  const chat = page.getByTestId('org-chat')
  const top = chat.getByTestId('top-thread')
  await expect(page.getByTestId('org-rail')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('org-detail').getByTestId('org-rail-toggle').click()
  // One answered, one still worked on: the card of the answered one, no working count.
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 1', { timeout: 30_000 })
  await expect(top).toHaveAttribute('data-thread-id', ids.work[0]!)
  await expect(top.getByTestId('top-thread-working')).toHaveCount(0)
  await top.getByTestId('top-thread-hide').click()
  await expect(top.getByTestId('top-thread-count')).toHaveText('1 thread')
  await top.getByTestId('top-thread-show').click()
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 1')
  // The answered one closed: only a working one is left, and the top shows nothing, as before.
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.work[0]}`, { close: 'acked' })
  await expect(chat.getByTestId('session-top')).toHaveCount(0, { timeout: 30_000 })
  expect(errors).toEqual([])
})
