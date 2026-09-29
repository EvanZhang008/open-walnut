/**
 * The Ask Walnut drawer's list is the shared asks list (src/core/sessions/ask-list.ts):
 * the order it sorts by is the stamp it prints, the dot is the shared state, and
 * rows hold still while the drawer is open.
 *
 * The report this pins (2026-09-26): the drawer read "13h, 16h, 1d, ..., 1w, 1w" and
 * then a blue "1d ago" among the "1w ago" rows. The list was in BIRTH order while
 * each row printed its last touch, so an old ask continued yesterday sat where it
 * was born. The phone listed a different store altogether; it now reads the same
 * rules from GET /api/v1/asks, so the second test compares the drawer's DOM with
 * that endpoint's answer for the same real tasks.
 *
 *  1. DENSITY: 64 invented asks (every state, ties, untitled rows, mixed-script
 *     titles, a few Mentor asks) replace the fixture's asks in GET /api/tasks. The
 *     DOM order, titles, time texts and dots must equal what the shared module
 *     computes for the same rows, and search / the agent switch must filter the
 *     same way.
 *  2. REAL SERVER: three real asks launched through quick-start (mock CLI). The
 *     drawer must match GET /api/v1/asks; a message sent into the OLDEST while
 *     the drawer is open must not move it (rows hold still) nor change the time
 *     it prints (its old "5mo ago", never "just now" at the bottom), a new ask
 *     that arrives while open joins at the end reading "New", switching to
 *     Mentor and back shows Walnut's list exactly as first seen, and the next
 *     open shows the true order with real times on both surfaces.
 *  3. GONE SESSIONS: every request the page makes for a session that no longer
 *     exists settles (the page reaches network idle).
 *  4. EARLY OPEN: the drawer opened while GET /api/tasks is still on its way says
 *     it is loading, then holds the rows it first shows.
 *
 * Real UI: one load of the SPA per test, then clicks and typing. Runs on chromium
 * and webkit (the Mac app is a WKWebView). All data is invented; non-ASCII titles
 * are \u escapes (U+7814 U+7A76 "research", U+90E8 U+7F72 "deploy").
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page, type Request, type WebSocket } from '@playwright/test'
import { openAskWalnutDrawer } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import {
  ASK_WALNUT_PROJECT, GENERAL_AGENT_ID, askProjectFor, buildAskList, matchesAskQuery,
  type AskTaskLike,
} from '../../../src/core/sessions/ask-list'
import { timeAgo } from '../../../web/src/utils/time'

const SHOTS = process.env.ASK_DRAWER_SHOT_DIR ?? '/tmp/ask-drawer-order'
const STAMP = Date.now().toString(36)
const HOUR = 3600_000
const DAY = 24 * HOUR
const RESEARCH = '\u7814\u7a76'
const DEPLOY = '\u90e8\u7f72'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })
test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

const drawer = (page: Page): Locator => page.locator('[data-testid="ask-walnut-drawer"]')
const rows = (page: Page): Locator => page.locator('[data-testid="ask-walnut-drawer-item"]')
const search = (page: Page): Locator => page.locator('[data-testid="ask-walnut-search"]')

const WALNUT = { id: GENERAL_AGENT_ID, project: ASK_WALNUT_PROJECT }
const MENTOR = { id: 'mentor', project: askProjectFor({ id: 'mentor', name: 'Mentor' }) }

interface DomRow { id: string; title: string; time: string; state: string }

async function readRows(page: Page): Promise<DomRow[]> {
  return rows(page).evaluateAll((els) => els.map((el) => ({
    id: el.getAttribute('data-task-id') ?? '',
    title: el.querySelector('.ask-walnut-drawer-item-title')?.textContent ?? '',
    time: el.querySelector('.ask-walnut-drawer-item-time')?.textContent ?? '',
    state: el.querySelector('[data-ask-state]')?.getAttribute('data-ask-state') ?? '',
  })))
}

/**
 * Serve GET /api/tasks with every ask replaced: `keep` decides which real asks
 * stay, `extra` are appended. Non-ask tasks pass through untouched.
 */
async function rewriteAsks(
  page: Page,
  keep: (task: { id?: string }) => boolean,
  extra: () => AskTaskLike[] = () => [],
  opts: { holdListUntil?: Promise<void>; reshape?: (task: AskTaskLike) => AskTaskLike } = {},
): Promise<void> {
  await page.route('**/api/tasks*', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() !== 'GET' || url.pathname !== '/api/tasks') {
      await route.fallback()
      return
    }
    // A slow board: every list read answers only once the test says so (the
    // dev build's double-mounted effects send two), so the page and the drawer
    // are up before the tasks are, however loaded the machine is. A minute at
    // most, so a broken test cannot pin the run.
    if (opts.holdListUntil && url.searchParams.get('fields') === 'list') {
      await Promise.race([opts.holdListUntil, new Promise((r) => setTimeout(r, 60_000))])
    }
    const response = await route.fetch()
    let body: { tasks?: Array<{ id?: string; walnut_agent?: boolean; project?: string }> }
    try { body = await response.json() } catch { await route.fulfill({ response }); return }
    if (!Array.isArray(body.tasks)) { await route.fulfill({ response }); return }
    const isAsk = (t: { walnut_agent?: boolean; project?: string }) =>
      t.walnut_agent === true || (t.project ?? '').trim().toLowerCase().startsWith('ask ')
    const kept = body.tasks.filter((t) => !isAsk(t) || keep(t))
    const reshape = opts.reshape
    body.tasks = [...(reshape ? kept.map((t) => reshape(t as AskTaskLike)) : kept), ...(extra() as never[])]
    const headers = { ...response.headers() }
    delete headers['content-length']
    delete headers['content-encoding']
    await route.fulfill({ status: response.status(), headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  })
}

/** 64+ invented asks built against `now`, every stamp half a unit away from a
 *  timeAgo boundary so the printed text cannot flip during the test. */
function denseBoard(now: number): AskTaskLike[] {
  const titles = [
    'Weekly plan', `Garden ${RESEARCH} notes`, `Release ${DEPLOY} checklist`, 'Reading list',
    '', 'Trip plan: hotel shortlist', 'Budget review', 'Recipe ideas',
  ]
  const out: AskTaskLike[] = []
  for (let i = 0; i < 64; i++) {
    // Activity offsets: hours for the first rows, then days, then weeks.
    const ago = i < 8 ? (i + 1.5) * HOUR : i < 30 ? (i - 6.5) * DAY : (i - 25.5) * 7 * DAY
    const born = now - ago - ((i * 5) % 9) * DAY
    const hasSession = i % 9 !== 4
    const done = i % 3 === 0
    out.push({
      id: `ad-${STAMP}-${String(i).padStart(2, '0')}`,
      title: titles[i % titles.length],
      project: i % 13 === 5 ? 'Some Project' : ASK_WALNUT_PROJECT,
      walnut_agent: i % 17 !== 7,
      phase: done ? 'COMPLETE' : i % 4 === 1 ? 'NEED_ACTION' : 'IN_PROGRESS',
      status: done ? 'done' : 'in_progress',
      created_at: new Date(born).toISOString(),
      ...(hasSession
        ? { session_id: `pw-sess-${STAMP}-${i}`, session_ids: [`pw-sess-${STAMP}-${i}`], last_session_update: new Date(now - ago).toISOString() }
        : { session_ids: [] }),
      ...(i % 10 === 2 && hasSession ? { session_status: { process_status: 'running' } } : {}),
    })
  }
  // The reported shape: born twelve days ago, continued a day and a half ago.
  out.push({
    id: `ad-${STAMP}-continued`, title: 'Old ask continued yesterday', project: ASK_WALNUT_PROJECT, walnut_agent: true,
    phase: 'NEED_ACTION', status: 'in_progress', created_at: new Date(now - 12.5 * DAY).toISOString(),
    session_id: `pw-sess-${STAMP}-continued`, session_ids: [`pw-sess-${STAMP}-continued`],
    last_session_update: new Date(now - 1.5 * DAY).toISOString(),
  })
  // A tie: same activity AND birth, so only the id decides (code-unit order).
  const tieAt = new Date(now - 3.5 * DAY).toISOString()
  for (const suffix of ['tie-b', 'tie-a']) {
    out.push({
      id: `ad-${STAMP}-${suffix}`, title: `Tie ${suffix}`, project: ASK_WALNUT_PROJECT, walnut_agent: true,
      phase: 'IN_PROGRESS', status: 'in_progress', created_at: tieAt, last_session_update: tieAt,
      session_id: `pw-sess-${STAMP}-${suffix}`, session_ids: [`pw-sess-${STAMP}-${suffix}`],
    })
  }
  // Mentor's own asks: one stamped, one filed under its project by hand.
  out.push(
    { id: `ad-${STAMP}-m1`, title: 'Weekly reflection', project: 'Ask Mentor', walnut_agent: true, agent_id: 'mentor', phase: 'IN_PROGRESS', status: 'in_progress', created_at: new Date(now - 5.5 * DAY).toISOString(), last_session_update: new Date(now - 2.5 * HOUR).toISOString(), session_id: `pw-sess-${STAMP}-m1`, session_ids: [`pw-sess-${STAMP}-m1`] },
    { id: `ad-${STAMP}-m2`, title: 'Morning pages', project: 'Ask Mentor', phase: 'TODO', status: 'todo', created_at: new Date(now - 1.5 * DAY).toISOString(), session_ids: [] },
  )
  return out
}

/**
 * Load the home page and wait for what these tests use: the task panel and the
 * Ask slot's menu button. NOT `networkidle`: a page is allowed to keep a request
 * open, and waiting on the network measures that rather than the page.
 */
async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="ask-walnut-menu"]')).toBeVisible({ timeout: 30_000 })
}

function expected(tasks: AskTaskLike[], agent: { id: string; project: string }, now: number, query = ''): DomRow[] {
  return buildAskList(tasks, agent, { query }).asks.map((r) => ({
    id: r.id, title: r.title, time: timeAgo(r.activityAt, { now }), state: r.state,
  }))
}

test('the drawer lists 60+ asks in the shared order, printing the stamp it sorts by', async ({ page }) => {
  const now = Date.now()
  const board = denseBoard(now)
  await rewriteAsks(page, () => false, () => board)
  await openHome(page)
  await openAskWalnutDrawer(page)

  const want = expected(board, WALNUT, now)
  expect(want.length).toBeGreaterThanOrEqual(60)
  await expect(rows(page)).toHaveCount(want.length, { timeout: 20_000 })
  const got = await readRows(page)
  expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id))
  expect(got.map((r) => r.title)).toEqual(want.map((r) => r.title))
  expect(got.map((r) => r.time)).toEqual(want.map((r) => r.time))
  expect(got.map((r) => r.state)).toEqual(want.map((r) => r.state))
  expect(new Set(got.map((r) => r.state))).toEqual(new Set(['running', 'idle', 'done', 'todo']))

  // The reported row now sits among the rows of its own age.
  const idx = got.findIndex((r) => r.id === `ad-${STAMP}-continued`)
  expect(got[idx].time).toBe('1d ago')
  expect(got[idx].state).toBe('idle')
  expect(got[idx - 1].time === '1d ago' || got[idx - 1].time.endsWith('h ago')).toBe(true)
  expect(got[idx + 1].time.endsWith('d ago')).toBe(true)
  await drawer(page).screenshot({ path: `${SHOTS}/dense-${test.info().project.name}.png` })

  // Search: every word, any case; a CJK query filters by substring.
  for (const q of ['PLAN weekly', RESEARCH, 'no such ask anywhere']) {
    await search(page).fill(q)
    const hits = expected(board, WALNUT, now, q)
    if (hits.length === 0) {
      await expect(page.locator('[data-testid="ask-walnut-search-empty"]')).toBeVisible()
      continue
    }
    await expect(rows(page)).toHaveCount(hits.length)
    expect((await readRows(page)).map((r) => r.id)).toEqual(hits.map((r) => r.id))
    expect(hits.every((h) => matchesAskQuery(h.title, q))).toBe(true)
  }
  await search(page).fill('')

  // The agent switch: Mentor's list, by the same rules.
  await page.locator('[data-testid="ask-walnut-agent-switch"]').click()
  await page.locator('[data-testid="ask-walnut-agent-item"][data-agent-id="mentor"]').click()
  const mentorWant = expected(board, MENTOR, now)
  await expect(rows(page)).toHaveCount(mentorWant.length)
  expect(await readRows(page)).toEqual(mentorWant)
  await drawer(page).screenshot({ path: `${SHOTS}/mentor-${test.info().project.name}.png` })
})

interface Launched { taskId: string; sessionId: string }

/**
 * Launch one real ask and wait until its session is LINKED (the endpoint shows
 * the session id). The link stamps the activity, and it lands when the CLI comes
 * up, not when the launch answers: launches in quick succession can otherwise
 * link in either order under load, and the order under test is then a coin flip.
 */
async function launchAsk(page: Page, label: string): Promise<Launched> {
  const res = await page.request.post('/api/sessions/quick-start', {
    data: { cwd: '', message: `drawer order ${label} ${STAMP}`, project: ASK_WALNUT_PROJECT, walnutAgent: true },
  })
  expect(res.status(), await res.text()).toBe(200)
  const launched = await res.json() as Launched
  await expect.poll(async () => {
    const list = await page.request.get('/api/v1/asks?agentId=general&limit=1000')
    const body = await list.json() as { asks?: Array<{ id: string; sessionId?: string }> }
    return body.asks?.find((r) => r.id === launched.taskId)?.sessionId ?? null
  }, { timeout: 60_000 }).toBe(launched.sessionId)
  return launched
}

/** The endpoint's order for the given task ids (the phone's view of the same board). */
async function endpointOrder(page: Page, ids: ReadonlySet<string>): Promise<Array<{ id: string; title: string; state: string }>> {
  const res = await page.request.get('/api/v1/asks?agentId=general&limit=1000')
  expect(res.status(), await res.text()).toBe(200)
  const body = await res.json() as { asks: Array<{ id: string; title: string; state: string }> }
  return body.asks.filter((r) => ids.has(r.id)).map(({ id, title, state }) => ({ id, title, state }))
}

/** Every WS frame the page receives, as text. Attach BEFORE the page loads:
 *  `websocket` fires only for sockets opened after the listener. */
function collectFrames(page: Page): string[] {
  const frames: string[] = []
  page.on('websocket', (ws: WebSocket) => ws.on('framereceived', (f) => {
    frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8'))
  }))
  return frames
}

/** Whether a received frame carries this task with a `last_session_update` newer than `after`. */
function sawActivity(frames: readonly string[], taskId: string, after: string): boolean {
  return frames.some((text) => text.includes(taskId)
    && [...text.matchAll(/"last_session_update":"([^"]+)"/g)].some((m) => m[1] > after))
}

/** A timeAgo text as minutes ago, so a column of them can be checked for order. */
function minutesAgo(text: string): number {
  if (text === 'just now') return 0
  const m = /^(\d+)(m|h|d|w|mo|y) ago$/.exec(text)
  if (!m) throw new Error(`not a timeAgo text: ${JSON.stringify(text)}`)
  const unit = { m: 1, h: 60, d: 1440, w: 10_080, mo: 43_200, y: 525_600 }[m[2] as 'm']
  return Number(m[1]) * unit
}
/** The printed times read in order down the list: never newer than the row above. */
function readsInOrder(times: readonly string[]): boolean {
  const mins = times.map(minutesAgo)
  return mins.every((t, i) => i === 0 || mins[i - 1] <= t)
}

test('a real board: the drawer equals GET /api/v1/asks, and rows hold still while it is open', async ({ page }) => {
  const ours = new Set<string>()
  // The board serves each real ask as older than it is: C 2.5 hours, B a day
  // and a half, A five months (the same order the real stamps give). The first
  // task:updated frame for an ask brings its real stamp, so a held row's
  // printed time and its live one read differently, as on a real board where
  // continuing a months-old ask used to print "just now" under "5mo ago".
  const agedHours = new Map<string, number>()
  await rewriteAsks(page, (t) => !!t.id && ours.has(t.id), () => [], {
    reshape: (t) => {
      const hours = agedHours.get(t.id)
      if (hours === undefined) return t
      const at = new Date(Date.now() - hours * HOUR).toISOString()
      return { ...t, created_at: at, last_session_update: at }
    },
  })
  // Three real asks, oldest first. The middle one is renamed (title drift is an
  // edit, not activity), which must not move it.
  const a = await launchAsk(page, 'A'); ours.add(a.taskId)
  const b = await launchAsk(page, 'B'); ours.add(b.taskId)
  const c = await launchAsk(page, 'C'); ours.add(c.taskId)
  const renamed = `Renamed by drift ${STAMP}`
  const patch = await page.request.patch(`/api/tasks/${b.taskId}`, { data: { title: renamed } })
  expect(patch.status(), await patch.text()).toBe(200)
  agedHours.set(c.taskId, 2.5).set(b.taskId, 36).set(a.taskId, 150.5 * 24)

  const frames = collectFrames(page)
  await openHome(page)
  await openAskWalnutDrawer(page)
  await expect(rows(page)).toHaveCount(3, { timeout: 20_000 })

  const before = await readRows(page)
  expect(before.map((r) => r.id)).toEqual([c.taskId, b.taskId, a.taskId])
  expect(before[1].title).toBe(renamed)
  expect(before[2].time).toBe('5mo ago')
  expect(readsInOrder(before.map((r) => r.time))).toBe(true)
  // Parity: the phone's endpoint says the same thing about the same tasks.
  await expect.poll(async () => (await endpointOrder(page, ours)).map((r) => [r.id, r.title]), { timeout: 20_000 })
    .toEqual(before.map((r) => [r.id, r.title]))
  await drawer(page).screenshot({ path: `${SHOTS}/real-before-${test.info().project.name}.png` })

  // While the drawer is OPEN: continue the oldest ask. The server moves it to
  // the top (the endpoint shows that) but the drawer must not move a row.
  const cOrder = (await endpointOrder(page, ours)).map((r) => r.id)
  expect(cOrder).toEqual([c.taskId, b.taskId, a.taskId])
  const sentAt = new Date(Date.now() - 500).toISOString()
  const send = await page.request.post(`/api/v1/sessions/${a.sessionId}/messages`, { data: { text: `continue ${STAMP}` } })
  expect(send.status(), await send.text()).toBeLessThan(300)
  await expect.poll(async () => (await endpointOrder(page, ours)).map((r) => r.id), { timeout: 30_000 })
    .toEqual([a.taskId, c.taskId, b.taskId])
  // The browser's store has the new stamp (it rode a task:updated frame).
  await expect.poll(() => sawActivity(frames, a.taskId, sentAt), { timeout: 30_000 }).toBe(true)
  await page.waitForTimeout(400)
  const continued = await readRows(page)
  expect(continued.map((r) => r.id)).toEqual([c.taskId, b.taskId, a.taskId])
  // Its time is held with its place: still "5mo ago", not "just now" at the bottom.
  expect(continued.map((r) => r.time)).toEqual(before.map((r) => r.time))

  // A new ask that arrives while open joins at the END (nothing shifts) and
  // reads "New" where a time would be, so the times above still read in order.
  const d = await launchAsk(page, 'D'); ours.add(d.taskId)
  await expect(rows(page)).toHaveCount(4, { timeout: 30_000 })
  const held = await readRows(page)
  expect(held.map((r) => r.id)).toEqual([c.taskId, b.taskId, a.taskId, d.taskId])
  expect(held.map((r) => r.time)).toEqual([...before.map((r) => r.time), 'New'])
  await expect(drawer(page).locator('[data-testid="ask-walnut-drawer-item-new"]')).toHaveCount(1)
  await drawer(page).screenshot({ path: `${SHOTS}/real-held-${test.info().project.name}.png` })

  // Mentor and back: one snapshot per agent for the whole open, so Walnut's
  // list comes back exactly as first seen, not re-taken in the live order.
  await page.locator('[data-testid="ask-walnut-agent-switch"]').click()
  await page.locator('[data-testid="ask-walnut-agent-item"][data-agent-id="mentor"]').click()
  await expect(drawer(page).locator('.ask-walnut-drawer-title')).toHaveText(new RegExp(MENTOR.project))
  await page.locator('[data-testid="ask-walnut-agent-switch"]').click()
  await page.locator('[data-testid="ask-walnut-agent-item"][data-agent-id="general"]').click()
  await expect(drawer(page).locator('.ask-walnut-drawer-title')).toHaveText(new RegExp(WALNUT.project))
  await expect(rows(page)).toHaveCount(4)
  // Places and printed times (a dot may change state meanwhile: D's first turn ends).
  expect((await readRows(page)).map((r) => [r.id, r.time])).toEqual(held.map((r) => [r.id, r.time]))
  await drawer(page).screenshot({ path: `${SHOTS}/real-switch-back-${test.info().project.name}.png` })

  // Close, reopen: the true order, the same on both surfaces.
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await openAskWalnutDrawer(page)
  const trueOrder = [d.taskId, a.taskId, c.taskId, b.taskId]
  await expect.poll(async () => (await readRows(page)).map((r) => r.id), { timeout: 10_000 }).toEqual(trueOrder)
  await expect.poll(async () => (await endpointOrder(page, ours)).map((r) => r.id), { timeout: 20_000 }).toEqual(trueOrder)
  const after = await readRows(page)
  expect((await endpointOrder(page, ours)).map((r) => r.title)).toEqual(after.map((r) => r.title))
  // Real times again: the continued ask reads its new time at the top, and no row reads "New".
  expect(after.some((r) => r.time === 'New')).toBe(false)
  expect(minutesAgo(after[1].time)).toBeLessThan(60)
  expect(readsInOrder(after.map((r) => r.time))).toBe(true)
  await drawer(page).screenshot({ path: `${SHOTS}/real-after-${test.info().project.name}.png` })
})

test('an ask whose session is gone leaves no request open', async ({ page }) => {
  // The dense board's asks name sessions this server never had, so the session
  // the slot opens answers 404. Its read used to leave that answer's body unread,
  // and Chromium then never finishes the request: the page never reached network
  // idle, and the connection stayed held until the page was collected.
  const board = denseBoard(Date.now())
  await rewriteAsks(page, () => false, () => board)
  const dead = (r: Request) => /\/api\/sessions\/pw-sess-/.test(new URL(r.url()).pathname)
  const seen: string[] = []
  const open = new Set<Request>()
  page.on('request', (r) => { if (dead(r)) { seen.push(r.url()); open.add(r) } })
  page.on('requestfinished', (r) => { open.delete(r) })
  page.on('requestfailed', (r) => { open.delete(r) })
  await openHome(page)
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0)
  await expect.poll(() => [...open].map((r) => r.url()), { timeout: 15_000 }).toEqual([])
  await page.waitForLoadState('networkidle', { timeout: 20_000 })
})

test('opened before the board loads: says it is loading, then holds the rows it shows', async ({ page }) => {
  // The gate's report: the drawer opened while GET /api/tasks was still on its
  // way took its open-time snapshot of the empty list, so every row counted as
  // new and followed the live order for the whole open (an old ask that got a
  // message jumped from the bottom to the top).
  const ours = new Set<string>()
  const a = await launchAsk(page, 'E1'); ours.add(a.taskId)
  const b = await launchAsk(page, 'E2'); ours.add(b.taskId)
  const c = await launchAsk(page, 'E3'); ours.add(c.taskId)
  let release!: () => void
  const board = new Promise<void>((resolve) => { release = resolve })
  await rewriteAsks(page, (t) => !!t.id && ours.has(t.id), () => [], { holdListUntil: board })
  const frames = collectFrames(page)
  await page.goto('/')
  await openAskWalnutDrawer(page)

  // The board is still on its way: the list says so, never "no sessions yet".
  const loading = page.locator('[data-testid="ask-walnut-drawer-loading"]')
  await expect(loading).toBeVisible()
  await expect(loading).toHaveText(/Loading your asks/)
  // A list-line spinner, text-sized (the global `.spinner` is 32px). Layout
  // width, not the bounding box: the spinner rotates, and a turned 12px square's
  // box is up to 17px wide.
  expect(await loading.locator('.spinner').evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(12)
  await expect(drawer(page).getByText(/No .* sessions yet/)).toHaveCount(0)
  await expect(rows(page)).toHaveCount(0)
  await drawer(page).screenshot({ path: `${SHOTS}/early-loading-${test.info().project.name}.png` })

  release()
  await expect(rows(page)).toHaveCount(3, { timeout: 30_000 })
  await expect(loading).toHaveCount(0)
  const shown = (await readRows(page)).map((r) => r.id)
  expect(shown).toEqual([c.taskId, b.taskId, a.taskId])

  // Continue the oldest while the drawer is still open: the server moves it to
  // the top, the drawer does not.
  const sentAt = new Date(Date.now() - 500).toISOString()
  const send = await page.request.post(`/api/v1/sessions/${a.sessionId}/messages`, { data: { text: `early ${STAMP}` } })
  expect(send.status(), await send.text()).toBeLessThan(300)
  await expect.poll(async () => (await endpointOrder(page, ours)).map((r) => r.id), { timeout: 30_000 })
    .toEqual([a.taskId, c.taskId, b.taskId])
  await expect.poll(() => sawActivity(frames, a.taskId, sentAt), { timeout: 30_000 }).toBe(true)
  await page.waitForTimeout(400)
  expect((await readRows(page)).map((r) => r.id)).toEqual(shown)
  await drawer(page).screenshot({ path: `${SHOTS}/early-held-${test.info().project.name}.png` })

  // The next open shows the true order.
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await openAskWalnutDrawer(page)
  await expect.poll(async () => (await readRows(page)).map((r) => r.id), { timeout: 10_000 })
    .toEqual([a.taskId, c.taskId, b.taskId])
})
