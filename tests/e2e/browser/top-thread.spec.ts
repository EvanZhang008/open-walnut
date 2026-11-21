/**
 * The first thread above the chat (experiment top_thread, web/src/components/org/TopThread.tsx;
 * 2026-11-20, the user: "Only one type, is just called thread ... right now thread has 16, but topp
 * only has 1, not right, I think top only show one but will show how many left, but thread will
 * show all ... also top can be hide, and when hide people can also have a button show it").
 *
 *  1. A VP with five threads for him (two need him, three to read): above its chat the top shows
 *     "1 / 5", 5 being the header's count and the Threads list's, and its first card is the
 *     Threads list's first, one that needs him. › and ‹ step to the list's next one and back. Its
 *     Snooze menu stays in the window.
 *     A new thread that needs him sorts in ahead: the thread on show stays on show ("2 / 6").
 *  2. He replies in the top card: the words are filed in that thread, which leaves the list (his
 *     reply makes it the node's move), so the next takes its place ("2 / 5") and the header reads 5.
 *  3. Hide: one line, "5 threads (2 need you) · Show"; still hidden after a reload; Show brings it back.
 *  3b. A card whose words run past the top's room: the cut block fades at its end, and Show all
 *     (or a click on its title) opens it whole in the Threads view beside the chat, scrolled to and
 *     marked, while the top keeps its bound height and never folds into nothing. With the Threads
 *     in their groups (brief_off), the card's top, its title first, sits just under the sticky
 *     chips, never its middle, also from another chip scrolled far down (2026-11-21, a review on
 *     his data: Show all landed mid-card, the title under the chips, once wholly above the view).
 *  4. A task with Threads on and a letter to answer, in a Home column: the letter (not a thread)
 *     still shows in the strip, the thread under it. The switch off: today's strip alone.
 * The fixture is shared: this file makes its own project, tasks and letter, and puts the flags back.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Top ${STAMP}`
const made: string[] = []
const ids = { lead: '', leadSid: '', needs: [] as string[], read: [] as string[], task: '', taskSid: '', taskThread: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const REPLY = `Ship it on Monday ${STAMP}`
let flagsBefore: Record<string, boolean> | null = null
let cwd = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)
test.use({ video: 'on', viewport: { width: 1440, height: 900 } })

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request.post(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function patch(request: APIRequestContext, url: string, data: unknown, sid?: string): Promise<void> {
  const res = await request.patch(url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
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

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function startSession(request: APIRequestContext, taskId: string, message = 'snapshot-clean-turn:Started.'): Promise<string> {
  await post(request, '/api/sessions/quick-start', { cwd, message, taskId })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return sid
}

/** A thread the node opened that waits on him (as its session does with thread_create). */
async function needsThread(request: APIRequestContext, node: string, sid: string, title: string): Promise<string> {
  const why = { user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes.' }
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${node}/threads/open`, { title, text: `${title}?`, state: 'needs', from: 'node', ...why }, sid)
  await patch(request, `/api/v1/tasks/${node}/threads/${thread.id}`, { reply: `${title}: pick one.`, state: 'needs', ...why }, sid)
  return thread.id
}

/** His request, answered by the node: something to read. */
async function readThread(request: APIRequestContext, node: string, title: string): Promise<string> {
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${node}/threads`, { text: `${title}, how does it stand?` })
  await patch(request, `/api/v1/tasks/${node}/threads/${thread.id}`, { title, reply: `${title}: done, the notes are in.`, state: 'answered' })
  return thread.id
}

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(PROJECT))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

const topOf = (scope: Locator | Page) => scope.getByTestId('top-thread')
const paneCards = (page: Page) => page.getByTestId('org-rail').locator('[data-testid="org-thread-list"][data-show="open"] > [data-testid="org-thread"]')

/** How far a card's top sits under the Threads pane's sticky chips (negative: hidden under them or above). */
async function gapUnderChips(page: Page, card: Locator): Promise<number> {
  const chips = (await page.getByTestId('org-rail').getByTestId('org-threads-filter').boundingBox())!
  const box = (await card.boundingBox())!
  return Math.round(box.y - (chips.y + chips.height))
}

async function expectTopUnderChips(page: Page, card: Locator): Promise<void> {
  await expect.poll(() => gapUnderChips(page, card), { timeout: 5_000 }).toBeGreaterThanOrEqual(0)
  // Settled there, not drifting on: just under the chips, its head in sight.
  await page.waitForTimeout(800)
  const gap = await gapUnderChips(page, card)
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThanOrEqual(24)
  await expect(card.getByTestId('org-thread-head')).toBeInViewport()
}

async function shot(page: Page, name: string, scope?: Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await (scope ?? page).screenshot({ path: `${SHOTS}/top-thread-${name}.png` })
}

async function keepVideo(page: Page, name: string): Promise<void> {
  const video = page.video()
  await page.close()
  // saveAs waits for the recording to be finished (a copy of path() right after close is cut short).
  if (video) await video.saveAs(`${SHOTS}/top-thread-${name}.webm`)
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks, threads and settings: run them on a test server, never production')
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  await setFlags(request, { top_thread: true, action_needed_everywhere: true })
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, `More work ${STAMP}`]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  ids.leadSid = await startSession(request, ids.lead)
  // Oldest first, so the newest change of each kind is the last made.
  for (const title of ['Trays or pots', 'Release the Mac app']) ids.needs.push(await needsThread(request, ids.lead, ids.leadSid, `${title} ${STAMP}`))
  for (const title of ['Soil test', 'Seed order', 'Greenhouse vents']) ids.read.push(await readThread(request, ids.lead, `${title} ${STAMP}`))

  // A task with Threads on, a letter to answer and one thread to read.
  ids.task = (await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Lease terms ${STAMP}`, project: PROJECT, source: 'local' })).task.id
  made.push(ids.task)
  await patch(request, `/api/tasks/${ids.task}`, { threads_on: true })
  ids.taskSid = await startSession(request, ids.task, `Lease ready ${STAMP}`)
  ids.taskThread = await readThread(request, ids.task, `Lease draft ${STAMP}`)
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': ids.taskSid },
    data: { subject: `Sign the lease ${STAMP}?`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'Pick one.', actions: [{ id: 'sign', label: 'Sign it' }, { id: 'wait', label: 'Not yet' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${ids.task}`)).json()).task?.user_status?.actions ?? []).map((a: { kind: string }) => a.kind).join(','), { timeout: 60_000 }).toContain('letter')
})

test.afterAll(async ({ request }) => {
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
  for (const id of made) await removeTask(request, id)
})

test('on a VP: the top is the Threads list\'s first, steps through all of them, takes a reply, and hides', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. "1 / 5": the header's count, the Threads list's count; the first is the list's first, one that needs him.
  const chat = page.getByTestId('org-chat')
  const top = topOf(chat)
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 5', { timeout: 30_000 })
  await expect(page.getByTestId('org-pill-threads')).toHaveAttribute('data-threads', '5')
  await expect(paneCards(page)).toHaveCount(5)
  const paneIds = await paneCards(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-thread-id')))
  // The ones that need him lead the list, newest first, then the ones to read.
  expect(paneIds).toEqual([...ids.needs].reverse().concat([...ids.read].reverse()))
  await expect(top).toHaveAttribute('data-thread-id', paneIds[0]!)
  await expect(top.getByTestId('org-thread')).toHaveAttribute('data-state', 'needs')
  await expect(top.getByTestId('top-thread-left')).toHaveText('4 more')
  await expect(top.getByTestId('top-thread-prev')).toBeDisabled()
  await shot(page, '1-top', page.getByTestId('org-detail'))

  // › steps to the list's next one, ‹ back.
  await top.getByTestId('top-thread-next').click()
  await expect(top.getByTestId('top-thread-pos')).toHaveText('2 / 5')
  await expect(top).toHaveAttribute('data-thread-id', paneIds[1]!)
  for (let i = 3; i <= 5; i++) await top.getByTestId('top-thread-next').click()
  await expect(top.getByTestId('top-thread-pos')).toHaveText('5 / 5')
  await expect(top).toHaveAttribute('data-thread-id', paneIds[4]!)
  await expect(top.getByTestId('org-thread')).toHaveAttribute('data-state', 'answered')
  await expect(top.getByTestId('top-thread-next')).toBeDisabled()
  for (let i = 4; i >= 1; i--) await top.getByTestId('top-thread-prev').click()
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 5')
  await expect(top).toHaveAttribute('data-thread-id', paneIds[0]!)

  // Its Snooze menu opens inside the window and closes again.
  await top.getByTestId('org-thread-snooze').click()
  const menu = page.getByTestId('org-thread-snooze-menu')
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  await shot(page, '2-snooze-menu')
  await top.getByTestId('org-thread-snooze').click()
  await expect(menu).toHaveCount(0)

  // A new one that needs him sorts in ahead: the thread on show stays on show, now "2 / 6".
  const late = await needsThread(request, ids.lead, ids.leadSid, `Late question ${STAMP}`)
  await expect(page.getByTestId('org-pill-threads')).toHaveAttribute('data-threads', '6', { timeout: 30_000 })
  await expect(top.getByTestId('top-thread-pos')).toHaveText('2 / 6')
  await expect(top).toHaveAttribute('data-thread-id', paneIds[0]!)
  await expect(paneCards(page).first()).toHaveAttribute('data-thread-id', late)

  // 2. He replies in the top card, typing as a person does.
  const replied = paneIds[0]!
  const follow = top.getByTestId('org-thread-follow-open')
  if (await follow.isVisible()) await follow.click()
  await top.getByTestId('org-thread-follow-input').click()
  await page.keyboard.type(REPLY, { delay: 15 })
  await top.getByTestId('org-thread-follow-send').click()
  await expect.poll(async () => {
    const r = await request.get(`/api/v1/tasks/${ids.lead}/threads/${replied}`)
    return ((await r.json()) as { thread?: { messages: Array<{ text: string }> } }).thread?.messages.map((m) => m.text).at(-1)
  }, { timeout: 30_000 }).toBe(REPLY)
  // It is the node's move now: it leaves the list, and the next takes its place.
  await expect(top.getByTestId('top-thread-pos')).toHaveText('2 / 5', { timeout: 30_000 })
  await expect(top).toHaveAttribute('data-thread-id', paneIds[1]!)
  await expect(page.getByTestId('org-pill-threads')).toHaveAttribute('data-threads', '5')
  await expect(paneCards(page)).toHaveCount(5)
  await shot(page, '3-replied', page.getByTestId('org-detail'))

  // 3. Hide: one line that counts them; kept over a reload; Show brings it back.
  await top.getByTestId('top-thread-hide').click()
  await expect(top).toHaveAttribute('data-hidden', 'true')
  await expect(top.getByTestId('top-thread-show')).toHaveText('5 threads (2 need you) · Show')
  await shot(page, '4-hidden', page.getByTestId('org-detail'))
  await page.reload()
  await page.waitForLoadState('networkidle')
  if (!(await page.getByTestId('org-detail').isVisible())) await openLead(page)
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(PROJECT))
  const again = topOf(page.getByTestId('org-chat'))
  await expect(again).toHaveAttribute('data-hidden', 'true', { timeout: 30_000 })
  await again.getByTestId('top-thread-show').click()
  // A fresh load starts on the first.
  await expect(again.getByTestId('top-thread-pos')).toHaveText('1 / 5')
  await expect(again).toHaveAttribute('data-thread-id', late)
  await shot(page, '5-shown-again', page.getByTestId('org-detail'))
  expect(pageErrors).toEqual([])
  await keepVideo(page, 'vp')
})

test('a card cut off in the top fades at its end, and Show all opens it whole in the Threads view', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const why = { user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes.' }
  const title = `Long field notes ${STAMP}`
  const { thread } = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${ids.lead}/threads/open`, { title, text: `${title}?`, state: 'needs', from: 'node', ...why }, ids.leadSid)
  // Well under the summary's cap (THREAD_REPLY_MAX), so the Threads view holds every word of it.
  const long = Array.from({ length: 30 }, (_, i) => `Bed ${i + 1}: soil turned, seedlings up.`).join('\n\n')
  await patch(request, `/api/v1/tasks/${ids.lead}/threads/${thread.id}`, { reply: `${long}\n\nWhich bed gets the beans?`, state: 'needs', ...why }, ids.leadSid)
  // The Threads in their groups, with Done long enough to scroll far down in.
  await setFlags(request, { brief_off: true })
  for (let i = 1; i <= 10; i++) await readThread(request, ids.lead, `Shed shelf ${i} ${STAMP}`)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)
  const detail = page.getByTestId('org-detail')
  const top = topOf(page.getByTestId('org-chat'))
  await expect(top).toHaveAttribute('data-thread-id', thread.id, { timeout: 30_000 })
  const room = (await top.boundingBox())!
  // Its words are cut: the block fades at its end, and the bar offers Show all.
  await expect(top.locator('[data-clipped="true"]').first()).toBeVisible()
  const mask = await top.locator('[data-clipped="true"]').first().evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage)
  expect(mask).toContain('linear-gradient')
  await expect(top.getByTestId('top-thread-whole')).toBeVisible()
  await shot(page, '8-clipped', detail)
  // Show all: the Threads beside the chat bring the card into view and mark it.
  await top.getByTestId('top-thread-whole').click()
  const rail = page.getByTestId('org-rail')
  const inRail = rail.locator(`[data-testid="org-thread"][data-thread-id="${thread.id}"]`)
  await expect(inRail).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
  await expect(inRail).toBeInViewport()
  // Its top just under the sticky chips: the card is taller than the pane, so a centred one hid its title.
  expect((await inRail.boundingBox())!.height).toBeGreaterThan((await rail.boundingBox())!.height)
  await expectTopUnderChips(page, inRail)
  await expect(inRail.getByTestId('org-thread-reply')).toContainText('Bed 30')
  await shot(page, '9-show-all', detail)
  // From another chip scrolled far down: a click on its title picks All and brings its top under the
  // chips the same; the top neither folds nor grows.
  await expect(inRail).not.toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
  await rail.locator('[data-testid="org-threads-chip"][data-group="read"]').click()
  await expect(rail.getByTestId('org-thread-groups')).toHaveAttribute('data-filter', 'read')
  await rail.getByTestId('org-thread').last().evaluate((el) => {
    let s: HTMLElement | null = el.parentElement
    while (s && !(s.scrollHeight > s.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement
    if (!s) throw new Error('the Threads pane does not scroll')
    s.scrollTop = s.scrollHeight
  })
  await top.getByTestId('org-thread-head').click()
  await expect(rail.getByTestId('org-thread-groups')).toHaveAttribute('data-filter', 'all')
  await expect(inRail).toHaveAttribute('data-focused', 'true', { timeout: 10_000 })
  await expectTopUnderChips(page, inRail)
  await shot(page, '9b-show-all-from-done', detail)
  await expect(top.getByTestId('org-thread-messages')).toHaveCount(0)
  await expect(top.getByTestId('org-thread-reply')).toBeVisible()
  const after = (await top.boundingBox())!
  expect(Math.abs(after.height - room.height)).toBeLessThanOrEqual(2)
  // Scrolled to its end, the block no longer fades.
  await top.locator('[data-clipped="true"]').first().evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(top.getByTestId('org-thread-reply')).not.toHaveAttribute('data-clipped', 'true')
  await patch(request, `/api/v1/tasks/${ids.lead}/threads/${thread.id}`, { close: 'acked' })
  await setFlags(request, { brief_off: false })
  expect(pageErrors).toEqual([])
  await keepVideo(page, 'show-all')
})

test('a task with Threads on: its letter still shows above its thread; the switch off shows today\'s strip', async ({ page, request }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.taskSid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${ids.taskSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const strip = panel.getByTestId('session-action-needed')
  await expect(strip.locator('[data-testid="action-item"][data-kind="letter"]')).toBeVisible({ timeout: 30_000 })
  const top = topOf(panel)
  await expect(top.getByTestId('top-thread-pos')).toHaveText('1 / 1')
  await expect(top).toHaveAttribute('data-thread-id', ids.taskThread)
  // The letter leads, the thread under it.
  const [s, t] = [(await strip.boundingBox())!, (await top.boundingBox())!]
  expect(s.y).toBeLessThan(t.y)
  await shot(page, '6-task-on', panel)

  await setFlags(request, { top_thread: false })
  await expect(top).toHaveCount(0, { timeout: 30_000 })
  await expect(strip.locator('[data-testid="action-item"][data-kind="letter"]')).toBeVisible()
  await expect(panel.getByTestId('session-top')).toHaveCount(0)
  await shot(page, '7-task-off', panel)
  expect(pageErrors).toEqual([])
  await keepVideo(page, 'task')
})
