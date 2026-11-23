/**
 * Every thread on a task's Threads says where it came from, and the view filters by it
 * (web/src/components/org/thread-origin.ts, ThreadOriginFilter.tsx; 2026-11-23, the user, on a task
 * with Threads on and nine subtasks: each thread must say whether it is this task's own or which
 * task below it came from, "those are two different things"; then "there can be a filter by ... by
 * default, at least all").
 *
 *  1. A task with Threads on holds two threads of its own (one its agent opened, one from his
 *     message), and threads of a subtask and of that subtask's own subtask pop up to it
 *     (threads_pop_up). Its Threads view beside its chat: the own cards read "Opened by this task"
 *     and "You asked this task"; each card from below reads "From <that task>", the grandchild
 *     named as itself. A picture's path in a card's summary draws the picture, a thumbnail that
 *     opens whole on a click (2026-11-23, the user: "why picture is not render in the thread?").
 *  2. The filter: All (picked, every card), This task, one chip per task below. Picking the
 *     subtask shows only its card; This task only the two own; All again shows all four. The pick
 *     survives a reload.
 *  3. A click on the subtask's name in its card opens that task's session on Home.
 * The fixture is shared: this file makes its own project and tasks, and puts the flag back.
 * ORIGIN_DATA=<json> plays real titles and summaries and his window size (a file outside the repo:
 * { viewport, tasks: {lead, child, grand}, threads: {ownOpened, ownAsked, askedReply, child, grand} });
 * PROOF_VIDEO_DIR=<dir> records it.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { startProofVideo } from './proof-video'

interface PlayData {
  viewport?: { width: number; height: number }
  tasks?: { lead: string; child: string; grand: string }
  threads?: { ownOpened?: string; ownAsked?: string; askedReply?: string; child?: string; grand?: string }
}
const DATA: PlayData | null = process.env.ORIGIN_DATA ? JSON.parse(fs.readFileSync(process.env.ORIGIN_DATA, 'utf8')) as PlayData : null

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Origin ${STAMP}`
const TITLES = DATA?.tasks ?? { lead: `Garden plan ${STAMP}`, child: `Soil test ${STAMP}`, grand: `Order seeds ${STAMP}` }
const PLAY = DATA?.threads ?? {}
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/origin`
const made: string[] = []
const ids = { lead: '', leadSid: '', child: '', childSid: '', grand: '', grandSid: '', ownOpened: '', ownAsked: '', childThread: '', grandThread: '' }
let flagWas: boolean | null = null
let cwd = ''
let picture = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ viewport: DATA?.viewport ?? { width: 1280, height: 1000 } })

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function patch(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<void> {
  const res = await request.patch(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
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

/** A task with Threads on, under `parent`, with a session of its own. */
async function taskWithThreads(request: APIRequestContext, title: string, parent?: string): Promise<{ id: string; sid: string }> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local', ...(parent ? { parent_task_id: parent } : {}) })
  made.push(task.id)
  await patch(request, `/api/tasks/${task.id}`, { threads_on: true })
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: task.id })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${task.id}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return { id: task.id, sid }
}

/** A thread the task's agent opened that waits on him (as its session does with thread_create). */
async function needsThread(request: APIRequestContext, node: string, sid: string, title: string): Promise<string> {
  // A real title asks yes or no: such a card carries its buttons, each naming its result.
  const options = DATA ? { options: [{ label: 'Yes: go ahead as proposed', recommended: true }, { label: 'No: leave it as it is' }] } : {}
  const why = { user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes.', separate_reason: 'Each card here is a decision of its own.', ...options }
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${node}/threads/open`, { title, text: `${title}?`, state: 'needs', from: 'node', ...why }, sid)
  await patch(request, `/api/v1/tasks/${node}/threads/${thread.id}`, { reply: `${title}: pick one.`, state: 'needs', ...why }, sid)
  return thread.id
}

const paneOf = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.leadSid}"]`).getByTestId('session-threads-pane')
const cardIn = (pane: Locator, id: string) => pane.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
const shownIds = (pane: Locator) => pane.locator('[data-testid="org-thread"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')).sort())
const chip = (pane: Locator, origin: string) => pane.locator(`[data-testid="org-threads-origin-chip"][data-origin="${origin}"]`)

/** One picture of the region from the first part's top to the lowest part's bottom, the pane's width
 *  (the first part scrolled to the top of its pane; the parts fit the window under it). */
async function shotOf(page: Page, name: string, parts: Locator[]): Promise<void> {
  await parts[0]!.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const boxes = await Promise.all(parts.map(async (p) => (await p.boundingBox())!))
  const x = Math.min(...boxes.map((b) => b.x)) - 8
  const y = Math.min(...boxes.map((b) => b.y)) - 8
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 8
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(1280, right - x), height: bottom - y } })
}

/** The lead's column with its Threads view open beside the chat (a reload keeps it open: never toggled shut). */
async function showLeadThreads(page: Page): Promise<Locator> {
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.leadSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const threads = panel.getByTestId('session-threads-chip')
  await expect(threads).toBeVisible({ timeout: 30_000 })
  if ((await threads.getAttribute('aria-pressed')) !== 'true') await threads.click()
  await expect(threads).toHaveAttribute('aria-pressed', 'true')
  const pane = paneOf(page)
  await expect(cardIn(pane, ids.grandThread)).toBeVisible({ timeout: 30_000 })
  return pane
}

async function openLeadThreads(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.leadSid])
  await loadHome(page)
  return showLeadThreads(page)
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(300_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks, threads and settings: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  flagWas = cfg.config?.experimental?.threads_pop_up === true
  const on = await request.put('/api/config', { data: { experimental: { threads_pop_up: true } } })
  expect(on.ok(), await on.text()).toBe(true)

  const lead = await taskWithThreads(request, TITLES.lead)
  ids.lead = lead.id; ids.leadSid = lead.sid
  const child = await taskWithThreads(request, TITLES.child, ids.lead)
  ids.child = child.id; ids.childSid = child.sid
  const grand = await taskWithThreads(request, TITLES.grand, ids.child)
  ids.grand = grand.id; ids.grandSid = grand.sid

  // The lead's own: one its agent opened, one from his message (answered: something to read).
  ids.ownOpened = await needsThread(request, ids.lead, ids.leadSid, PLAY.ownOpened ?? `Trays or pots ${STAMP}`)
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads`, { text: PLAY.ownAsked ? `${PLAY.ownAsked}?` : `How is the greenhouse ${STAMP}?` })
  ids.ownAsked = thread.id
  // Its summary ends with a picture's path, as the user's did ("why picture is not render in the thread?").
  picture = `${fixtureRoot}/projects/walnut/greenhouse-${STAMP}.png`
  fs.copyFileSync(`${process.cwd()}/web/public/icon-192.png`, picture)
  await patch(request, `/api/v1/tasks/${ids.lead}/threads/${ids.ownAsked}`, { title: PLAY.ownAsked ?? `Greenhouse ${STAMP}`, reply: `${PLAY.askedReply ?? 'The vents are fixed.'}\n\nPicture: ${picture}`, state: 'answered' })
  // A thread of the subtask and one of its own subtask, both waiting on him: they pop up to the lead.
  ids.childThread = await needsThread(request, ids.child, ids.childSid, PLAY.child ?? `Lime or sulfur ${STAMP}`)
  ids.grandThread = await needsThread(request, ids.grand, ids.grandSid, PLAY.grand ?? `Which seed vendor ${STAMP}`)
  await expect.poll(async () => {
    const r = await (await request.get(`/api/v1/tasks/${ids.lead}/threads`)).json() as { threads: Array<{ id: string; owner?: { task_id: string } }> }
    return r.threads.map((t) => `${t.id}:${t.owner?.task_id ?? 'own'}`).sort()
  }, { timeout: 30_000 }).toEqual(expect.arrayContaining([`${ids.ownOpened}:own`, `${ids.ownAsked}:own`, `${ids.childThread}:${ids.child}`, `${ids.grandThread}:${ids.grand}`]))
})

test.afterAll(async ({ request }) => {
  if (picture) fs.rmSync(picture, { force: true })
  if (flagWas !== null) await request.put('/api/config', { data: { experimental: { threads_pop_up: flagWas } } })
  for (const id of [...made].reverse()) await removeTask(request, id)
})

test('each card says where its thread came from, and the view filters by it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const video = await startProofVideo(page)
  const pane = await openLeadThreads(page)
  await video.caption('Each card says where its thread came from: this task, or the task below it')
  await video.hold(2500)

  // 1. Own cards say they are this task's; the ones from below name their task.
  const from = (id: string) => cardIn(pane, id).getByTestId('org-thread-from')
  await expect(from(ids.ownOpened)).toHaveText('Opened by this task')
  await expect(from(ids.ownOpened)).toHaveAttribute('data-origin', 'own')
  await expect(from(ids.ownOpened)).toHaveAttribute('title', new RegExp(`Opened by this task \\(.*${esc(TITLES.lead)}`))
  await expect(cardIn(pane, ids.ownAsked)).toBeVisible()
  await expect(from(ids.ownAsked)).toHaveText('You asked this task')
  await expect(from(ids.childThread)).toHaveText(`From ${TITLES.child}`)
  await expect(from(ids.childThread)).toHaveAttribute('data-origin', 'below')
  await expect(cardIn(pane, ids.childThread).getByTestId('org-thread-owner')).toHaveText(TITLES.child)
  // Two levels down: named as itself, the task holding the thread.
  await expect(from(ids.grandThread)).toHaveText(`From ${TITLES.grand}`)

  // A picture in a card's summary is drawn (a thumbnail), its path the caption; a click opens it whole.
  const thumb = cardIn(pane, ids.ownAsked).getByTestId('org-thread-reply').locator('img.inline-image')
  await expect(thumb).toHaveCount(1)
  await thumb.scrollIntoViewIfNeeded()
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 20_000 }).toBe(true)
  expect((await thumb.boundingBox())!.height).toBeLessThanOrEqual(201)
  await video.caption('A picture in a summary is drawn; a click opens it whole')
  await video.hold(1200)
  await thumb.click()
  await expect(page.locator('.lightbox-overlay img.lightbox-image')).toBeVisible()
  await video.hold(1200)
  await page.locator('.lightbox-close').click()
  await expect(page.locator('.lightbox-overlay')).toHaveCount(0)

  // 2. The filter: All picked, This task, then each task below with its count.
  const row = pane.getByTestId('org-threads-origin')
  await expect(row).toBeVisible()
  const chips = row.getByTestId('org-threads-origin-chip')
  await expect(chips).toHaveCount(4)
  expect(await chips.evaluateAll((els) => els.slice(0, 2).map((e) => e.getAttribute('data-origin')))).toEqual(['all', 'own'])
  await expect(chip(pane, 'all')).toHaveText(/^All\s*4$/)
  await expect(chip(pane, 'own')).toHaveText(/^This task\s*2$/)
  await expect(chip(pane, ids.child)).toHaveText(new RegExp(`^${esc(TITLES.child)}\\s*1$`))
  await expect(chip(pane, ids.grand)).toHaveText(new RegExp(`^${esc(TITLES.grand)}\\s*1$`))
  await expect(chip(pane, 'all')).toHaveAttribute('aria-pressed', 'true')
  const all = [ids.ownOpened, ids.ownAsked, ids.childThread, ids.grandThread].sort()
  expect(await shownIds(pane)).toEqual(all)
  fs.mkdirSync(SHOTS, { recursive: true })
  // The two kinds of card, cropped: the filter row, the cards from below and an own card with its
  // picture, in the list's order (newest first).
  await shotOf(page, 'thread-origin-cards', [row, cardIn(pane, ids.childThread), cardIn(pane, ids.ownAsked)])

  await row.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await video.caption('The filter: All, This task, then each task below with its count')
  await video.hold(2000)
  await chip(pane, ids.child).click()
  await expect(chip(pane, ids.child)).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => shownIds(pane)).toEqual([ids.childThread])
  await video.caption('One task below: only its threads')
  await video.hold(2000)
  await shotOf(page, 'thread-origin-filtered', [row, cardIn(pane, ids.childThread)])
  await chip(pane, 'own').click()
  await expect.poll(() => shownIds(pane)).toEqual([ids.ownOpened, ids.ownAsked].sort())
  await video.caption('This task: only its own threads')
  await video.hold(2000)
  await chip(pane, 'all').click()
  await expect.poll(() => shownIds(pane)).toEqual(all)
  await video.caption('All again: every thread')
  await video.hold(1500)
  await video.stop('thread-origin')

  // The pick is kept: picked again, it is still picked after a reload.
  await chip(pane, ids.grand).click()
  await expect.poll(() => shownIds(pane)).toEqual([ids.grandThread])
  await page.reload()
  await page.waitForLoadState('networkidle')
  // The kept pick shows its one card: wait for the filter row itself, not for a card it hides.
  const panelAgain = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.leadSid}"]`)
  const threadsAgain = panelAgain.getByTestId('session-threads-chip')
  await expect(threadsAgain).toBeVisible({ timeout: 30_000 })
  if ((await threadsAgain.getAttribute('aria-pressed')) !== 'true') await threadsAgain.click()
  const again = paneOf(page)
  await expect(chip(again, ids.grand)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  await expect.poll(() => shownIds(again)).toEqual([ids.grandThread])
  await chip(again, 'all').click()
  await expect.poll(() => shownIds(again)).toEqual(all)

  // 3. The subtask's name in its card opens that task's session on Home.
  await cardIn(again, ids.childThread).getByTestId('org-thread-owner').click()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.childSid}"]`)).toBeVisible({ timeout: 30_000 })
  expect(pageErrors).toEqual([])
})
