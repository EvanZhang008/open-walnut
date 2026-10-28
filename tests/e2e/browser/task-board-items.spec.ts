/**
 * The Board's round two, as a user meets it on Home (web/src/components/board/:
 * the board-*.frame.js runtime, TaskBoardPane.tsx, BoardReplyDock.tsx):
 *
 *   A. A thread reads like the app's chat: oldest first, the reply under the
 *      messages, a capped message area that opens at the newest and stays there,
 *      but leaves a user who scrolled up alone (with a way back down); bubbles
 *      and markdown. "Reply…" opens Walnut's own composer (voice included) inline,
 *      in the thread's place under its messages, and its Send posts to that thread.
 *   B. Projects, checks, choices, reminders and the "updated" dot:
 *      1. the leader's board_project_set recolors the section live, the strip
 *         counts follow, a cleared status gives the author's back, and
 *         <walnut-project> shows its pill and its tasks as chips; the USER picks a
 *         status on the pill (Escape and a script's click do nothing): the section
 *         recolors, the strip recounts, the leader hears it once, and the leader's
 *         next write cannot move it back unless it says so; a project with no
 *         status at all offers "Set status";
 *      2. a ticked point is read, stays read across a reload of the pane, and an
 *         html edit of its text brings it back unread with "Changed";
 *      3. picking option 2 marks it, answers the overview row and the strip, and
 *         the leader's session gets the message once;
 *      4. Remind me: a preset sets it (pending), × clears it; a reminder that comes
 *         due is highlighted, counted, delivered to the leader, and a post answers it;
 *      5. an edited section gets a red dot: on screen it is read after 2 s; a closed
 *         <details> keeps it until the user opens it.
 *      6. the user's note in the overview row: no mark states, and a state left by an
 *         older page is dropped by the note's save.
 *      6b. a note typed while its save fails survives the leader's board edit (a new
 *         document), is saved by the next one, and closing the Board saves it too.
 *   B2. A choice takes the user's own words, with the same docked composer: alone
 *      they answer it (the overview row and the strip follow), the leader hears them
 *      quoted with "no option"; "Change your words…" starts from them; a pick later
 *      keeps them, and the leader hears both in one message.
 *   B3. A note's "Dictate…" docks the same composer (mic included) over the note:
 *      it starts from the note's text (unsaved typing is saved first), Send saves
 *      it, Escape and a closing Board keep what was written, an empty Send clears it.
 *   B4. An agent ticks a point and answers a choice, as the user does (2026-10-27, the user: "all
 *      human action can be done by agent also"): the Board says whose they are, the leader hears
 *      the answer as from that task, and the user's own pick replaces it.
 *   C. A worker has no Board tab (the tab is a lead's, 2026-10-26); its board post
 *      (board_post's path: its owner's board, with its caller id) lands on the
 *      leader's board, which the leader's own tab shows, and a post from there
 *      lands there too.
 *
 * The chromium and webkit projects share ONE fixture board, so every task is
 * named `${engine}-items-…` with a stamp and nothing counts across the board.
 */
import fs from 'node:fs/promises'
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { showCustomBoard } from './board-view-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = '/tmp/board-c'

let fixtureRoot = ''
const litter: string[] = []

// deviceScaleFactor 1: evidence shots stay 1280px wide in WebKit too (Desktop Safari is 2x).
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOT_DIR, { recursive: true })
})

test.afterEach(async () => {
  // Children first, so no delete trips over a parent that still has children.
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
  litter.length = 0
})

async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (res.status === 204 ? undefined : await res.json()) as T
}

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, source: 'local', ...opts })
  litter.push(task.id)
  return task.id
}

interface BoardGet {
  board_task_id?: string
  board: { html: string; version: number } | null
  threads: Record<string, Array<{ id: string; author: string; text: string; ts: string }>>
  checks: Record<string, { hash: string; read: boolean; changed?: boolean }>
  choices: Record<string, { option: string; by?: string }>
  reminders: Record<string, { at: string; fired_at?: string }>
  section_seen: Record<string, { hash: string }>
  projects: Record<string, { status?: string; status_by?: string }>
  marks: Record<string, { state?: string; note?: string }>
}
const getBoard = (taskId: string, team = false) => api<BoardGet>('GET', `/api/v1/tasks/${taskId}/board${team ? '?team=1' : ''}`)

/** The session's recent messages as plain text (the mock CLI answers each delivered message by quoting it). */
const historyText = async (sid: string) => {
  const res = await fetch(`${API}/api/v1/sessions/${sid}/history?tail=80`)
  if (!res.ok) return ''
  const body = (await res.json()) as { messages?: Array<{ text?: string }> }
  return (body.messages ?? []).map((m) => m.text ?? '').join('\n')
}
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1

/** Real navigation by link click (never page.goto), then the home page. */
async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

/** A task with a live mock-CLI session (started by API), and its row on Home. */
async function taskWithSession(title: string, opts: Record<string, unknown>, ready: string): Promise<{ id: string; sid: string }> {
  const id = await createTask(title, { pinned: false, ...opts })
  const { sessionId } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd: `${fixtureRoot}/projects/walnut`, message: `snapshot-clean-turn:${ready}`, taskId: id,
  })
  await expect.poll(() => historyText(sessionId), { timeout: 60_000 }).toContain(ready)
  return { id, sid: sessionId }
}

/** Open a task's session column from its row, then its Board tab, on the leader's page (Custom) unless `custom` is false. */
async function openBoardTab(page: Page, taskId: string, sid: string, custom = true): Promise<{ panel: Locator; pane: Locator; frame: FrameLocator }> {
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  if (custom) await showCustomBoard(pane)
  return { panel, pane, frame: page.frameLocator('.task-board-frame') }
}

const leaderPost = (board: string, sid: string, thread: string, text: string) => api(
  'POST', `/api/v1/tasks/${board}/board/threads/${thread}`, { text }, { 'x-walnut-caller-sid': sid },
)

const STYLE = `<style>
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; background: #f3f4f7; color: #1f2430; }
  header { padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e8ee; }
  header h1 { margin: 0 0 4px; font-size: 17px; }
  main { padding: 6px 16px 40px; }
  table.overview { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e8ee; }
  .overview td, .overview th { padding: 6px 8px; border-bottom: 1px solid #eef0f4; text-align: left; vertical-align: top; font-size: 13px; }
  section, details { background: #fff; border: 1px solid #e5e8ee; border-radius: 10px; margin: 10px 0; padding: 4px 12px 12px; }
  [data-status="decide"] { border-left: 4px solid #d93025; }
  [data-status="wip"] { border-left: 4px solid #2f6feb; }
  [data-status="wait"] { border-left: 4px solid #d97706; }
  summary { cursor: pointer; padding: 8px 0; }
  h3 { margin: 8px 0; font-size: 14px; }
</style>`

function itemsBoard(engine: string, stamp: string, worker: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Board</title>${STYLE}</head>
<body>
<header>
  <h1>${engine} items board ${stamp}</h1>
  <div class="sub">Checked just now · <walnut-unread></walnut-unread></div>
  <walnut-strip></walnut-strip>
</header>
<main>
<table class="overview">
  <tr><th>Project</th><th>Status</th><th>Next</th><th>Your note</th></tr>
  <tr><td>Probe timeout</td><td><walnut-project id="probe"></walnut-project></td><td>Fix the probe</td><td><walnut-mark id="probe"></walnut-mark></td></tr>
  <tr class="needs-you" data-choice="deploy-when"><td>Deploy timing</td><td>Needs you</td><td>Pick an option below</td><td></td></tr>
  <tr class="rollout-row" data-project="rollout"><td>Rollout</td><td><walnut-project id="rollout" labels="wip:Rolling out,blocked:Blocked"></walnut-project></td><td>Wait for the deploy</td><td></td></tr>
  <tr><td>Loose end</td><td><walnut-project id="loose"></walnut-project></td><td>Nobody has looked yet</td><td></td></tr>
</table>
<section id="sec-probe" data-project="probe" data-status="decide">
  <h3>Probe timeout</h3>
  <walnut-check id="cause-timeout">The probe times out after <b>30 s</b> on the cold path.</walnut-check>
  <walnut-check id="fix-retry">Raise the retry budget to 3 tries.</walnut-check>
  <walnut-choice id="deploy-when" title="When to ship the fix" options="wait:Wait for the deploy window,now:Run it now,skip:Skip this week" recommended="wait" task="${worker}">
    <p class="choice-context">The window opens at 16:00; running now risks a page.</p>
  </walnut-choice>
  <walnut-thread id="probe-talk" title="Probe" task="${worker}"></walnut-thread>
</section>
<details id="sec-rollout" data-project="rollout" data-status="wip">
  <summary><h3 style="display:inline">Rollout</h3></summary>
  <p class="rollout-text">Rollout is paused at 40 percent.</p>
</details>
</main>
</body></html>`
}

test('a thread reads like the chat, and Reply docks Walnut\'s composer', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const project = `${engine}-items-chat ${stamp}`
  const { id: leader, sid } = await taskWithSession(`${engine}-items-chat-leader ${stamp}`, { project }, 'Chat leader ready')
  await api('PUT', `/api/v1/tasks/${leader}/board`, {
    html: `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body><main>
<h1 style="font-size:17px">${engine} chat board ${stamp}</h1>
<walnut-thread id="talk" title="Rollout talk"></walnut-thread>
</main></body></html>`,
  })
  // A long conversation, oldest first: the leader's notes, one with markdown, and the user's.
  for (let i = 1; i <= 14; i++) {
    const text = i === 7 ? 'Step **seven**: `retry=3`\n\n- one\n- two' : `Leader note ${i}: the probe owner reports back.`
    await leaderPost(leader, sid, 'talk', text)
  }
  await api('POST', `/api/v1/tasks/${leader}/board/threads/talk`, { text: 'User note: noted, thanks.' })

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { pane, frame } = await openBoardTab(page, leader, sid)
  const thread = frame.locator('walnut-thread[id="talk"]')
  const rows = thread.locator('.wn-msg')
  await expect(rows).toHaveCount(15, { timeout: 15_000 })
  await expect(rows.first().locator('.wn-text')).toHaveText('Leader note 1: the probe owner reports back.')
  await expect(rows.last().locator('.wn-text')).toHaveText('User note: noted, thanks.')
  await expect(rows.last().locator('.wn-who')).toHaveText('You')

  // The composer sits UNDER the messages; the message area is capped and opens at the newest.
  const layout = () => thread.evaluate((el) => {
    const s = el.querySelector('.wn-scroll') as HTMLElement
    const composer = el.querySelector('.wn-composer') as HTMLElement
    return {
      clientHeight: s.clientHeight, scrollHeight: s.scrollHeight, gap: s.scrollHeight - s.scrollTop - s.clientHeight,
      scrollTop: s.scrollTop, composerBelow: composer.getBoundingClientRect().top >= s.getBoundingClientRect().bottom - 1,
    }
  })
  const first = await layout()
  expect(first.clientHeight).toBeLessThanOrEqual(424)
  expect(first.scrollHeight).toBeGreaterThan(first.clientHeight)
  expect(first.composerBelow).toBe(true)
  await expect.poll(async () => (await layout()).gap).toBeLessThanOrEqual(2)

  // Bubbles: the user's on the right in the accent colour, the leader's on the left with its name; markdown typography.
  const styleOf = (row: Locator) => row.evaluate((el) => ({
    align: getComputedStyle(el).alignSelf, bg: getComputedStyle(el.querySelector('.wn-text')!).backgroundColor,
  }))
  expect(await styleOf(rows.last())).toEqual({ align: 'flex-end', bg: 'rgb(0, 122, 255)' })
  expect((await styleOf(rows.first())).align).toBe('flex-start')
  await expect(rows.first().locator('.wn-who')).toHaveText('Leader')
  const md = rows.nth(6)
  await expect(md.locator('.wn-text strong')).toHaveText('seven')
  await expect(md.locator('.wn-text code')).toHaveText('retry=3')
  await expect(md.locator('.wn-text li')).toHaveText(['one', 'two'])
  await thread.scrollIntoViewIfNeeded()
  await thread.screenshot({ path: `${SHOT_DIR}/${engine}-A1-conversation.png` })

  // Open at the newest, on screen: 1.5 s reads the thread.
  await expect(thread.locator('.wn-badge')).toBeHidden({ timeout: 10_000 })
  // Scrolled up to read: a new message leaves the position alone, offers a way down, and is not read yet.
  await thread.evaluate((el) => { (el.querySelector('.wn-scroll') as HTMLElement).scrollTop = 0 })
  await expect.poll(async () => (await layout()).scrollTop).toBe(0)
  await leaderPost(leader, sid, 'talk', 'Leader note 15: the newest one.')
  await expect(rows).toHaveCount(16, { timeout: 15_000 })
  await expect(thread.locator('.wn-badge')).toHaveText('1 new')
  const jump = thread.locator('.wn-jump')
  await expect(jump).toHaveText('1 new message ↓')
  await page.waitForTimeout(2_200)
  expect((await layout()).scrollTop).toBe(0)
  await expect(thread.locator('.wn-badge')).toHaveText('1 new')
  // The way down brings it into view, and 1.5 s there reads it.
  await jump.click()
  await expect.poll(async () => (await layout()).gap).toBeLessThanOrEqual(2)
  await expect(jump).toBeHidden()
  await expect(thread.locator('.wn-badge')).toBeHidden({ timeout: 10_000 })
  // Pinned again: the next message keeps the newest in view.
  await leaderPost(leader, sid, 'talk', 'Leader note 16: still pinned.')
  await expect(rows).toHaveCount(17, { timeout: 15_000 })
  await expect.poll(async () => (await layout()).gap).toBeLessThanOrEqual(2)

  // "Reply…" opens Walnut's own composer (with the mic) inline, where the field was; Send posts to the thread.
  await thread.locator('.wn-reply').click()
  const dock = pane.getByTestId('board-reply-dock')
  await expect(dock).toBeVisible()
  await expect(dock).toHaveAttribute('data-placement', 'inline')
  await expect(dock.getByTestId('board-reply-title')).toHaveText('Reply in Rollout talk')
  await expect(dock.locator('.mic-btn-wrapper button')).toBeVisible()
  await expect(thread.locator('.wn-reply')).toBeHidden()
  const slot = thread.locator('.wn-composer .wn-dock-slot')
  await expect.poll(async () => {
    const [d, s] = [await dock.boundingBox(), await slot.boundingBox()]
    return d && s ? Math.max(Math.abs(d.y - s.y), Math.abs(d.x - s.x), Math.abs(d.width - s.width), Math.abs(d.height - s.height)) : 99
  }).toBeLessThanOrEqual(2)
  const input = dock.locator('.chat-input-textarea')
  await expect(input).toBeFocused()
  await input.fill(`From the dock ${stamp}`)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-A2-dock.png` })
  await input.press('Enter')
  await expect(rows.last().locator('.wn-text')).toHaveText(`From the dock ${stamp}`, { timeout: 15_000 })
  await expect(rows.last()).not.toHaveClass(/wn-pending|wn-failed/, { timeout: 15_000 })
  await expect(input).toHaveValue('')
  await expect.poll(async () => (await getBoard(leader)).threads.talk.map((m) => [m.author, m.text]), { timeout: 10_000 })
    .toContainEqual(['user', `From the dock ${stamp}`])
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain(`From the dock ${stamp}`)
  await expect.poll(async () => (await layout()).gap).toBeLessThanOrEqual(2)
  // The draft is per thread and outlives the dock: Escape closes it, Reply brings the text back.
  await input.fill('Half a thought')
  await page.waitForTimeout(500) // the composer saves its draft after 300 ms
  await input.press('Escape')
  await expect(dock).toHaveCount(0)
  await expect(thread.locator('.wn-reply')).toHaveText('Reply…')
  await thread.locator('.wn-reply').click()
  await expect(pane.getByTestId('board-reply-dock').locator('.chat-input-textarea')).toHaveValue('Half a thought')
  expect(pageErrors).toEqual([])
})

test('projects, checks, choices, reminders and the updated dot', async ({ page }) => {
  test.setTimeout(360_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const project = `${engine}-items ${stamp}`
  const { id: leader, sid } = await taskWithSession(`${engine}-items-leader ${stamp}`, { project }, 'Items leader ready')
  const workerTitle = `${engine}-items-worker ${stamp}`
  const worker = await createTask(workerTitle, { project, pinned: false, parent_task_id: leader })
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: itemsBoard(engine, stamp, worker) })

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  let { pane, frame } = await openBoardTab(page, leader, sid)
  const box = (f: string) => frame.locator(`.wn-box[data-f="${f}"] b`)
  const probe = frame.locator('#sec-probe')
  const probePill = frame.locator('walnut-project[id="probe"] .wn-proj-pill')
  await expect(probePill).toHaveText('Needs you', { timeout: 15_000 }) // the author's status, until Walnut has one
  await expect(box('decide')).toHaveText('1')
  await expect(box('wip')).toHaveText('1')
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages')

  // ── 1. The leader's project status recolors live; cleared, the author's comes back ──
  // Tagged on its overview row too, a project still counts once.
  const asLeader = { 'x-walnut-caller-sid': sid }
  await api('PUT', `/api/v1/tasks/${leader}/board/projects/rollout`, { status: 'wip' }, asLeader)
  await expect(frame.locator('tr.rollout-row')).toHaveAttribute('data-status', 'wip', { timeout: 15_000 })
  await expect(box('wip')).toHaveText('1')
  await expect(box('')).toHaveText('2')
  await api('PUT', `/api/v1/tasks/${leader}/board/projects/probe`, { status: 'wait', tasks: [worker] }, asLeader)
  await expect(probe).toHaveAttribute('data-status', 'wait', { timeout: 15_000 })
  await expect(box('decide')).toHaveText('0')
  await expect(box('wait')).toHaveText('1')
  await expect(probe).toHaveCSS('border-left-color', 'rgb(217, 119, 6)')
  await expect(probePill).toHaveText('Waiting')
  await expect(probePill).toHaveAttribute('title', /^Set by the leader, .*\. Click to change it\.$/)
  const projChip = frame.locator(`walnut-project[id="probe"] walnut-task[id="${worker}"] .wn-task`)
  await expect(projChip).toHaveAttribute('title', workerTitle)
  await expect(projChip).toHaveAttribute('data-phase', 'TODO')
  await api('PUT', `/api/v1/tasks/${leader}/board/projects/probe`, { status: '' }, asLeader)
  await expect(probe).toHaveAttribute('data-status', 'decide', { timeout: 15_000 })
  await expect(box('decide')).toHaveText('1')
  await expect(probePill).toHaveText('Needs you')
  await expect(projChip).toHaveCount(1) // the tasks stay: a partial update
  await api('PUT', `/api/v1/tasks/${leader}/board/projects/probe`, { status: 'decide' }, asLeader)
  // The page already said "Needs you": wait for Walnut's copy, whose tip names the leader.
  await expect(probePill).toHaveAttribute('title', /^Set by the leader, /, { timeout: 15_000 })

  // ── 1b. The user picks a status on the pill ──
  const pick = frame.locator('walnut-project[id="probe"] .wn-proj-pick')
  await probePill.click()
  await expect(probePill).toHaveAttribute('aria-expanded', 'true')
  await expect(probePill).toBeHidden() // the options take its place: the status shows once, pressed
  await expect(pick.locator('.wn-proj-opt')).toHaveText(['Needs you', 'Working', 'Waiting', 'Done'])
  await expect(pick.locator('.wn-proj-opt[aria-pressed="true"]')).toHaveText('Needs you')
  await expect(pick.locator('.wn-proj-opt[aria-pressed="true"]')).toBeFocused()
  await frame.locator('table.overview tr', { has: frame.locator('walnut-project[id="probe"]') })
    .screenshot({ path: `${SHOT_DIR}/${engine}-B1b-status-picker.png` })
  // Escape closes it and gives the focus back; nothing is written.
  await page.keyboard.press('Escape')
  await expect(pick).toHaveCount(0)
  await expect(probePill).toBeVisible()
  await expect(probePill).toBeFocused()
  // A script on the board cannot open it, let alone pick.
  await frame.locator('body').evaluate(() => (document.querySelector('walnut-project[id="probe"] .wn-proj-pill') as HTMLButtonElement).click())
  await page.waitForTimeout(500)
  await expect(pick).toHaveCount(0)
  expect((await getBoard(leader)).projects.probe).toMatchObject({ status: 'decide', status_by: `task:${leader}` })
  // The pick: recolored, recounted, stored as the user's, and the leader told once.
  await probePill.click()
  await pick.locator('.wn-proj-opt[data-pick="wait"]').click()
  await expect(pick).toHaveCount(0, { timeout: 15_000 })
  await expect(probe).toHaveAttribute('data-status', 'wait')
  await expect(box('decide')).toHaveText('0')
  await expect(box('wait')).toHaveText('1')
  await expect(probePill).toHaveText('Waiting')
  await expect(probePill).toHaveAttribute('title', /^Set by you, .*\. Click to change it\.$/)
  await expect.poll(async () => (await getBoard(leader)).projects.probe, { timeout: 10_000 }).toMatchObject({ status: 'wait', status_by: 'human' })
  const statusLine = 'On your Board the user set project "probe" to wait (Waiting); it was decide (Needs you), set by you.'
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain(statusLine)
  // The leader's next write cannot move it back unless it says so.
  const refused = await fetch(`${API}/api/v1/tasks/${leader}/board/projects/probe`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...asLeader }, body: JSON.stringify({ status: 'decide' }),
  })
  expect(refused.status).toBe(409)
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('status_set_by_user')
  await expect(probe).toHaveAttribute('data-status', 'wait')
  // The same status again is no news.
  await probePill.click()
  await pick.locator('.wn-proj-opt[data-pick="wait"]').click()
  await expect(pick).toHaveCount(0)
  await page.waitForTimeout(1500)
  expect(occurrences(await historyText(sid), statusLine)).toBe(1)
  // A board's labels rename the four statuses; a key Walnut does not know is not offered.
  const rolloutPill = frame.locator('walnut-project[id="rollout"] .wn-proj-pill')
  await expect(rolloutPill).toHaveText('Rolling out')
  await rolloutPill.click()
  await expect(frame.locator('walnut-project[id="rollout"] .wn-proj-opt')).toHaveText(['Needs you', 'Rolling out', 'Waiting', 'Done'])
  await page.keyboard.press('Escape')
  await expect(frame.locator('walnut-project[id="rollout"] .wn-proj-pick')).toHaveCount(0)
  // A project with no status anywhere offers "Set status".
  const loose = frame.locator('walnut-project[id="loose"] .wn-proj-pill')
  await expect(loose).toHaveText('Set status')
  await loose.click()
  await frame.locator('walnut-project[id="loose"] .wn-proj-opt[data-pick="done"]').click()
  await expect(loose).toHaveText('Done', { timeout: 15_000 })
  await expect(loose).toHaveAttribute('data-proj-status', 'done')
  await expect(box('')).toHaveText('2') // no section carries it, so the strip does not count it
  // Back to "Needs you", on purpose, for the steps below.
  await api('PUT', `/api/v1/tasks/${leader}/board/projects/probe`, { status: 'decide', override_user: true }, asLeader)
  await expect(probe).toHaveAttribute('data-status', 'decide', { timeout: 15_000 })

  // ── 2. A point ticked read stays read across a pane reload; an edit of its text brings it back ──
  const point = frame.locator('walnut-check[id="cause-timeout"]')
  const tick = point.locator('.wn-check-box')
  await expect(tick).toHaveAttribute('aria-pressed', 'false')
  await expect(point.locator('.wn-check-box')).toHaveCount(1)
  await tick.click()
  await expect(point).toHaveAttribute('data-read', '')
  await expect(tick).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await getBoard(leader)).checks['cause-timeout']?.read, { timeout: 10_000 }).toBe(true)
  // A synthetic click (an author script) does nothing.
  await frame.locator('body').evaluate(() => (document.querySelector('walnut-check[id="fix-retry"] .wn-check-box') as HTMLButtonElement).click())
  await page.waitForTimeout(800)
  expect((await getBoard(leader)).checks['fix-retry']?.read).toBe(false)
  // Reload the pane: Files, then the Board again.
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(pane).toHaveCount(0)
  await panel.getByTestId('session-board-chip').click()
  ;({ pane, frame } = { pane: page.getByTestId('task-board-pane'), frame: page.frameLocator('.task-board-frame') })
  const point2 = frame.locator('walnut-check[id="cause-timeout"]')
  await expect(point2).toHaveAttribute('data-read', '', { timeout: 15_000 })
  await expect(point2.locator('.wn-check-box')).toHaveCount(1)
  // The spacer keeps the section off screen in the re-rendered page, so nothing reads
  // its updated dot before the assertions below look for it.
  await api('POST', `/api/v1/tasks/${leader}/board/edits`, { edits: [
    { old: '<b>30 s</b>', new: '<b>45 s</b>' },
    { old: '<section id="sec-probe"', new: '<div class="spacer" style="height:3000px"></div><section id="sec-probe"' },
  ] })
  await expect(point2.locator('b')).toHaveText('45 s', { timeout: 15_000 })
  await frame.locator('body').evaluate(() => window.scrollTo(0, 0))
  await expect(point2).not.toHaveAttribute('data-read')
  await expect(point2).toHaveAttribute('data-changed', '')
  await expect(point2.locator('.wn-check-hint')).toHaveText('Changed')
  // The edit also changed the section: it shows the updated dot, and 2 s on screen reads it.
  await expect(frame.locator('#sec-probe h3 .wn-updated')).toHaveCount(1, { timeout: 10_000 })
  await frame.locator('#sec-probe').evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await expect(frame.locator('#sec-probe h3 .wn-updated')).toHaveCount(0, { timeout: 10_000 })

  // ── 3. Option 2: picked, the overview row and the strip answered, the leader told once ──
  const choice = frame.locator('walnut-choice[id="deploy-when"]')
  const opts = choice.locator('.wn-choice-opt')
  await expect(opts).toHaveText(['1.Wait for the deploy windowRecommended', '2.Run it now', '3.Skip this week'])
  await expect(choice.locator('.wn-choice-title')).toHaveText('When to ship the fix')
  await expect(choice.locator('.choice-context')).toBeVisible() // the author's context stays
  await expect(frame.locator('tr.needs-you')).toBeVisible()
  await opts.nth(1).click()
  await expect(opts.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(choice.locator('.wn-choice-status')).toHaveText(/^(Sent to the leader|Saved\. The leader sees it on the board\.)$/, { timeout: 15_000 })
  await expect(choice).toHaveAttribute('data-answered', '')
  await expect(frame.locator('tr.needs-you')).toBeHidden()
  await expect(box('decide')).toHaveText('0')
  const pickLine = 'On your Board the user chose option 2 "Run it now" (recommended was 1 "Wait for the deploy window")'
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain(pickLine)
  await choice.scrollIntoViewIfNeeded()
  await choice.screenshot({ path: `${SHOT_DIR}/${engine}-B3-answered-choice.png` })
  // The chosen option again: nothing new reaches the leader.
  await opts.nth(1).click()
  await page.waitForTimeout(1500)
  expect(occurrences(await historyText(sid), pickLine)).toBe(1)
  expect((await getBoard(leader)).choices['deploy-when']).toMatchObject({ option: 'now' })

  // ── 4. Remind me on the thread: a preset, then clear; one that comes due ──
  const talk = frame.locator('walnut-thread[id="probe-talk"]')
  const remind = talk.locator('.wn-remind-btn')
  await expect(remind).toHaveText('Remind me')
  await remind.click()
  const panelR = talk.locator('.wn-remind-panel')
  await expect(panelR).toBeVisible()
  await panelR.getByRole('button', { name: 'In 1 hour' }).click()
  await expect(remind).toHaveText(/^Reminder (\w+ \d+ )?\d\d:\d\d$/, { timeout: 10_000 })
  await expect(panelR).toBeHidden()
  await expect(talk).toHaveAttribute('data-reminder', 'pending')
  const setAt = Date.parse((await getBoard(leader)).reminders['probe-talk'].at)
  expect(Math.abs(setAt - (Date.now() + 3_600_000))).toBeLessThan(120_000)
  await talk.locator('.wn-remind-clear').click()
  await expect(remind).toHaveText('Remind me', { timeout: 10_000 })
  await expect.poll(async () => (await getBoard(leader)).reminders['probe-talk']).toBeUndefined()
  // Due in 3 s: highlighted, counted, delivered to the leader by Walnut's clock.
  await api('PUT', `/api/v1/tasks/${leader}/board/reminders/probe-talk`, { at: new Date(Date.now() + 3_000).toISOString() })
  await expect(talk).toHaveAttribute('data-reminder', 'pending', { timeout: 10_000 })
  await expect(talk.locator('.wn-remind-btn')).toHaveText('Reminder due', { timeout: 15_000 })
  await expect(talk).toHaveAttribute('data-reminder', 'due')
  await expect(frame.locator('.wn-unread-n')).toHaveText('1 reminder due', { timeout: 15_000 })
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain('A reminder the user set on your Board is due: "Probe" (thread probe-talk')
  await expect.poll(async () => (await getBoard(leader)).reminders['probe-talk']?.fired_at, { timeout: 15_000 }).toBeTruthy()
  await talk.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-B4-reminder-due.png` })
  // A post in the thread answers it.
  await talk.locator('.wn-reply').click()
  const input = pane.getByTestId('board-reply-dock').locator('.chat-input-textarea')
  await input.fill('Back on it: run it now.')
  await input.press('Enter')
  await expect(talk.locator('.wn-msg').last().locator('.wn-text')).toHaveText('Back on it: run it now.', { timeout: 15_000 })
  await expect(talk.locator('.wn-remind-btn')).toHaveText('Remind me', { timeout: 15_000 })
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages')
  await expect.poll(async () => (await getBoard(leader)).reminders['probe-talk']).toBeUndefined()
  await pane.getByTestId('board-reply-close').click()

  // ── 5. An edited section in a closed <details>: the dot waits until the user opens it ──
  const before = (await getBoard(leader)).section_seen.rollout?.hash
  expect(before).toBeTruthy() // first sight was recorded silently
  await api('POST', `/api/v1/tasks/${leader}/board/edits`, { edits: [{ old: 'paused at 40 percent', new: 'paused at 60 percent' }] })
  const rollout = frame.locator('#sec-rollout')
  const dot = rollout.locator('summary h3 .wn-updated')
  await expect(dot).toHaveCount(1, { timeout: 15_000 })
  await expect(rollout).toHaveAttribute('data-updated', '')
  await expect(frame.locator('.wn-unread-n')).toHaveText('1 updated section')
  await rollout.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(2_500) // on screen but closed: not read
  await expect(dot).toHaveCount(1)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-B5-updated-dot.png` })
  await rollout.locator('summary').click()
  await expect(dot).toHaveCount(0)
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages')
  await expect.poll(async () => (await getBoard(leader)).section_seen.rollout?.hash, { timeout: 10_000 }).not.toBe(before)

  // ── 6. The board as a whole, with the user's note in the overview row ──
  // A state an older page left on the mark is not shown, and the note's save drops it.
  await api('PUT', `/api/v1/tasks/${leader}/board/marks/probe`, { state: 'revisit' })
  const note = frame.locator('walnut-mark[id="probe"]')
  await expect(note.locator('.wn-mark-note-toggle')).toHaveText('Add note')
  await expect(note.locator('.wn-mark-state')).toHaveCount(0)
  await note.locator('.wn-mark-note-toggle').click()
  await note.locator('.wn-mark-note').fill('Looks right; ship after the window.')
  await expect(note.locator('.wn-saved')).toHaveText(/^Saved \d\d:\d\d$/, { timeout: 10_000 })
  await expect.poll(async () => (await getBoard(leader)).marks.probe, { timeout: 10_000 })
    .toEqual({ note: 'Looks right; ship after the window.', updated_at: expect.any(String) })

  // ── 6b. A note is not lost when the leader edits the board (a new document) or the Board closes ──
  // Saves fail while blocked, so only the host's copy of the text can bring it back.
  let blockMarks = true
  await page.route('**/board/marks/**', (route) => (blockMarks ? route.abort() : route.continue()))
  const typed = 'Typed while the leader edits: keep this.'
  await note.locator('.wn-mark-note').fill(typed)
  await expect(note.locator('.wn-saved.wn-failed')).toHaveCount(1, { timeout: 10_000 })
  await api('POST', `/api/v1/tasks/${leader}/board/edits`, { edits: [{ old: 'Fix the probe', new: 'Fix the probe today' }] }, asLeader)
  await expect(frame.locator('table.overview')).toContainText('Fix the probe today', { timeout: 15_000 })
  await expect(note.locator('.wn-mark-note')).toHaveValue(typed)
  // It grows with its text: all of it shows, no inner scroll.
  expect(await note.locator('.wn-mark-note').evaluate((t) => t.scrollHeight - t.clientHeight)).toBeLessThanOrEqual(1)
  expect((await getBoard(leader)).marks.probe?.note).toBe('Looks right; ship after the window.')
  // Saves work again: the next document saves the kept text on its own.
  blockMarks = false
  await api('POST', `/api/v1/tasks/${leader}/board/edits`, { edits: [{ old: 'Fix the probe today', new: 'Fix the probe now' }] }, asLeader)
  await expect(frame.locator('table.overview')).toContainText('Fix the probe now', { timeout: 15_000 })
  await expect.poll(async () => (await getBoard(leader)).marks.probe?.note, { timeout: 10_000 }).toBe(typed)
  await expect(note.locator('.wn-saved')).toHaveText(/^Saved \d\d:\d\d$/)
  await expect(note.locator('.wn-mark-note')).toHaveValue(typed)
  // Closing the Board saves what the page could not.
  blockMarks = true
  const lastWords = 'Written just before closing the Board.'
  await note.locator('.wn-mark-note').fill(lastWords)
  await expect(note.locator('.wn-saved.wn-failed')).toHaveCount(1, { timeout: 10_000 })
  blockMarks = false
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(pane).toHaveCount(0)
  await expect.poll(async () => (await getBoard(leader)).marks.probe?.note, { timeout: 10_000 }).toBe(lastWords)
  await panel.getByTestId('session-board-chip').click()
  ;({ pane, frame } = { pane: page.getByTestId('task-board-pane'), frame: page.frameLocator('.task-board-frame') })
  await expect(frame.locator('walnut-mark[id="probe"] .wn-mark-note')).toHaveValue(lastWords, { timeout: 15_000 })
  await page.unroute('**/board/marks/**')
  await frame.locator('body').evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-B6-board.png` })
  expect(pageErrors).toEqual([])
})

test('a choice takes the user\'s own words, alone or beside a pick', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const project = `${engine}-items ${stamp}`
  const { id: leader, sid } = await taskWithSession(`${engine}-items-words-leader ${stamp}`, { project }, 'Words leader ready')
  const workerTitle = `${engine}-items-words-worker ${stamp}`
  const worker = await createTask(workerTitle, { project, pinned: false, parent_task_id: leader })
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: itemsBoard(engine, stamp, worker) })

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { pane, frame } = await openBoardTab(page, leader, sid)
  const box = (f: string) => frame.locator(`.wn-box[data-f="${f}"] b`)
  const choice = frame.locator('walnut-choice[id="deploy-when"]')
  const own = choice.locator('.wn-choice-own .wn-reply')
  const words = choice.locator('.wn-choice-words')
  const status = choice.locator('.wn-choice-status')
  await expect(own).toHaveText('Answer in your own words…', { timeout: 15_000 })
  await expect(words).toBeHidden()
  await expect(frame.locator('tr.needs-you')).toBeVisible()
  await expect(box('decide')).toHaveText('1')

  // ── The words alone: the same docked composer as a thread's, mic included ──
  await own.click()
  const dock = pane.getByTestId('board-reply-dock')
  await expect(dock).toHaveAttribute('data-choice', 'deploy-when')
  await expect(dock.getByTestId('board-reply-title')).toHaveText(`Answer When to ship the fix in your own words about ${workerTitle}`)
  await expect(dock.locator('.mic-btn-wrapper button')).toBeVisible()
  await expect(own).toBeHidden()
  await expect(own).toHaveAttribute('aria-pressed', 'true')
  await expect(dock).toHaveAttribute('data-placement', 'inline')
  await expect(choice.locator('.wn-choice-own .wn-dock-slot')).toHaveCount(1)
  const input = dock.locator('.chat-input-textarea')
  await expect(input).toBeFocused()
  const mine = `Neither yet: wait for the backup ${stamp}, then run it.`
  await input.fill(mine)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-B2-words-dock.png` })
  await input.press('Enter')
  await expect(dock).toHaveCount(0) // an answer is one message: the box is done
  await expect(words.locator('.wn-text')).toHaveText(mine, { timeout: 15_000 })
  await expect(words.locator('.wn-who')).toHaveText('You wrote')
  await expect(status).toHaveText(/^(Sent to the leader|Saved\. The leader sees it on the board\.)$/)
  await expect(choice).toHaveAttribute('data-answered', '')
  await expect(choice.locator('.wn-choice-opt[aria-pressed="true"]')).toHaveCount(0)
  await expect(frame.locator('tr.needs-you')).toBeHidden()
  await expect(box('decide')).toHaveText('0')
  await expect(own).toHaveText('Change your words…')
  await expect.poll(async () => (await getBoard(leader)).choices['deploy-when'], { timeout: 10_000 })
    .toMatchObject({ option: '', text: mine })
  const wordsLine = 'On your Board the user answered for "When to ship the fix" (choice deploy-when'
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain(wordsLine)
  expect(await historyText(sid)).toContain(mine)
  await choice.scrollIntoViewIfNeeded()
  await choice.screenshot({ path: `${SHOT_DIR}/${engine}-B2-words-answer.png` })

  // ── "Change your words…" starts from them; Escape leaves them as they were ──
  await own.click()
  await expect(dock.locator('.chat-input-textarea')).toHaveValue(mine)
  await dock.locator('.chat-input-textarea').press('Escape')
  await expect(dock).toHaveCount(0)
  await expect(words.locator('.wn-text')).toHaveText(mine)

  // ── A pick later keeps the words; the leader hears both, once ──
  await choice.locator('.wn-choice-opt').nth(1).click()
  await expect(choice.locator('.wn-choice-opt').nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(status).toHaveText(/^(Sent to the leader|Saved\. The leader sees it on the board\.)$/, { timeout: 15_000 })
  await expect(words.locator('.wn-text')).toHaveText(mine)
  await expect.poll(async () => (await getBoard(leader)).choices['deploy-when'], { timeout: 10_000 })
    .toMatchObject({ option: 'now', text: mine })
  const pickLine = 'On your Board the user chose option 2 "Run it now" (recommended was 1 "Wait for the deploy window")'
  await expect.poll(() => historyText(sid), { timeout: 30_000 }).toContain(pickLine)
  expect(await historyText(sid)).toContain('and wrote in their own words:')
  expect(occurrences(await historyText(sid), wordsLine)).toBe(1)
  await choice.screenshot({ path: `${SHOT_DIR}/${engine}-B2-words-and-pick.png` })

  expect(pageErrors).toEqual([])
})

test('an agent ticks a point and answers a choice; the Board says whose they are', async ({ page }) => {
  test.setTimeout(240_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-items-agent ${stamp}`
  const { id: leader, sid: leaderSid } = await taskWithSession(`${engine}-items-agent-lead ${stamp}`, { project }, 'Agent lead ready')
  const workerTitle = `${engine}-items-agent-worker ${stamp}`
  const { id: worker, sid: workerSid } = await taskWithSession(workerTitle, { project, parent_task_id: leader }, 'Agent worker ready')
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: itemsBoard(engine, stamp, worker) })

  // The worker's session ticks a point and picks an option, with its caller id, as an agent does.
  const asWorker = { 'x-walnut-caller-sid': workerSid }
  const hash = (await getBoard(leader)).checks['cause-timeout']!.hash
  await api('PUT', `/api/v1/tasks/${leader}/board/checks/cause-timeout`, { read: true, hash }, asWorker)
  await api('PUT', `/api/v1/tasks/${leader}/board/choices/deploy-when`, { option: 'now' }, asWorker)
  expect((await getBoard(leader)).choices['deploy-when']).toMatchObject({ option: 'now', by: `task:${worker}` })
  // The leader's session hears it as from the worker's task, once.
  await expect.poll(() => historyText(leaderSid), { timeout: 60_000 }).toContain('Run it now')
  expect(occurrences(await historyText(leaderSid), 'Run it now')).toBeGreaterThanOrEqual(1)

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { pane, frame } = await openBoardTab(page, leader, leaderSid)
  const check = frame.locator('walnut-check[id="cause-timeout"]')
  await expect(check.locator('.wn-check-box')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(check.locator('.wn-check-by')).toHaveText(`by the task "${workerTitle}"`)
  const other = frame.locator('walnut-check[id="fix-retry"]')
  await expect(other.locator('.wn-check-by')).toBeHidden()
  const choice = frame.locator('walnut-choice[id="deploy-when"]')
  // An answered choice opens folded, its one line naming whose answer it is.
  await expect(choice.locator('.wn-fold-row .wn-fold-by')).toHaveText(`by the task "${workerTitle}"`, { timeout: 15_000 })
  await choice.locator('.wn-fold-row').click()
  await expect(choice.locator('.wn-choice-status')).toContainText(`Answered by the task "${workerTitle}"`)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-B4-agent-answers.png` })

  // The user picks another option: theirs replaces the agent's, and says nothing of an agent.
  await choice.locator('.wn-choice-opt').nth(0).click()
  await expect.poll(async () => (await getBoard(leader)).choices['deploy-when'], { timeout: 15_000 }).toMatchObject({ option: 'wait' })
  expect((await getBoard(leader)).choices['deploy-when']?.by).toBeUndefined()
  await expect(choice.locator('.wn-choice-status')).not.toContainText('by the task', { timeout: 15_000 })
  // And the user unticks the agent's point.
  await check.locator('.wn-check-box').click()
  await expect(check.locator('.wn-check-box')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 })
  await expect(check.locator('.wn-check-by')).toBeHidden()
  await expect(pane).toBeVisible()
})

test('a note docks Walnut\'s composer (voice included) through Dictate…', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  // Each page error names the step it happened in.
  const pageErrors: string[] = []
  let step = 'setup'
  page.on('pageerror', (e) => pageErrors.push(`${step}: ${e.message}`))
  const project = `${engine}-items ${stamp}`
  const { id: leader, sid } = await taskWithSession(`${engine}-items-note-leader ${stamp}`, { project }, 'Note leader ready')
  const worker = await createTask(`${engine}-items-note-worker ${stamp}`, { project, pinned: false, parent_task_id: leader })
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: itemsBoard(engine, stamp, worker) })

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { panel, pane, frame } = await openBoardTab(page, leader, sid)
  const note = frame.locator('walnut-mark[id="probe"]')
  const field = note.locator('.wn-mark-note')
  const voice = note.locator('.wn-mark-voice')
  const dock = pane.getByTestId('board-reply-dock')
  const input = dock.locator('.chat-input-textarea')
  const savedNote = async () => (await getBoard(leader)).marks.probe?.note
  await expect(voice).toHaveText('Dictate…', { timeout: 15_000 })
  await expect(note.locator('.wn-mark-note-toggle')).toHaveText('Add note')

  step = 'typed-then-dictate'
  // ── Typed and not saved yet, then Dictate…: the box starts from those words, and they are saved first ──
  await note.locator('.wn-mark-note-toggle').click()
  await field.fill('Typed first')
  await voice.click()
  await expect(dock).toHaveAttribute('data-mark', 'probe')
  await expect(dock.getByTestId('board-reply-title')).toHaveText(/^Your note for the leader/)
  await expect(dock.locator('.mic-btn-wrapper button')).toBeVisible()
  await expect(dock).toHaveAttribute('data-placement', 'inline')
  await expect(note.locator('.wn-dock-slot')).toHaveCount(1)
  await expect(field).toBeHidden()
  await expect(voice).toBeHidden()
  await expect(input).toHaveValue('Typed first')
  await expect(input).toBeFocused()
  await expect.poll(savedNote, { timeout: 10_000 }).toBe('Typed first')
  // The box lies over the note's slot, in the overview row's cell, at a usable width.
  const slotBox = await note.locator('.wn-dock-slot').boundingBox()
  const dockBox = await dock.boundingBox()
  expect(slotBox && dockBox && slotBox.width >= 300 && dockBox.width >= 300).toBe(true)
  await page.screenshot({ path: `/tmp/voice-mic-everywhere/board-mark-${engine}-docked.png` })

  step = 'send'
  // ── Send saves the note and closes the box; the field shows the saved words ──
  const dictated = `Ship after the window ${stamp}, written in the composer.`
  await input.fill(dictated)
  await dock.screenshot({ path: `/tmp/voice-mic-everywhere/board-mark-${engine}-dock-typed.png` })
  await input.press('Enter')
  await expect(dock).toHaveCount(0)
  await expect.poll(savedNote, { timeout: 10_000 }).toBe(dictated)
  await expect(field).toBeVisible()
  await expect(field).toHaveValue(dictated)
  await expect(voice).toBeVisible()
  await expect(note.locator('.wn-dock-slot')).toHaveCount(0)

  step = 'escape'
  // ── Dictate… again starts from the saved note; Escape still keeps what was written ──
  await voice.click()
  await expect(input).toHaveValue(dictated)
  const escaped = `Closed with Escape ${stamp}, still kept.`
  await input.fill(escaped)
  await input.press('Escape')
  await expect(dock).toHaveCount(0)
  await expect(field).toHaveValue(escaped, { timeout: 10_000 })
  await expect.poll(savedNote, { timeout: 10_000 }).toBe(escaped)
  await expect(note.locator('.wn-saved')).toHaveText(/^Saved \d\d:\d\d$/, { timeout: 10_000 })

  step = 'typed-after'
  // ── The field and the box share one note: typing here after the box closed autosaves as before ──
  const typedAfter = `${escaped} Plus a typed line.`
  await field.fill(typedAfter)
  await expect.poll(savedNote, { timeout: 10_000 }).toBe(typedAfter)

  step = 'empty-send'
  // ── An empty Send clears the note: "Add note" again ──
  await voice.click()
  await expect(input).toHaveValue(typedAfter)
  await input.fill('')
  await input.press('Enter')
  await expect(dock).toHaveCount(0)
  await expect.poll(savedNote, { timeout: 10_000 }).toBeUndefined()
  await expect(note.locator('.wn-mark-note-toggle')).toHaveText('Add note')
  await expect(field).toBeHidden()

  step = 'board-closes'
  // ── The Board closing under an open box still saves its words ──
  await voice.click()
  const lastWords = `Written in the box as the Board closes ${stamp}.`
  await input.fill(lastWords)
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(pane).toHaveCount(0)
  await expect.poll(savedNote, { timeout: 10_000 }).toBe(lastWords)
  await panel.getByTestId('session-board-chip').click()
  const frame2 = page.frameLocator('.task-board-frame')
  await expect(frame2.locator('walnut-mark[id="probe"] .wn-mark-note')).toHaveValue(lastWords, { timeout: 15_000 })
  await frame2.locator('walnut-mark[id="probe"]').screenshot({ path: `/tmp/voice-mic-everywhere/board-mark-${engine}-saved.png` })

  step = 'open-close-unchanged'
  // ── Opened and closed with nothing written: no draft is left behind to write the
  //    old words back over an edit made elsewhere (another tab, the phone) ──
  const note2 = frame2.locator('walnut-mark[id="probe"]')
  await note2.locator('.wn-mark-voice').click()
  await expect(input).toHaveValue(lastWords)
  await input.press('Escape')
  await expect(dock).toHaveCount(0)
  const elsewhere = `Changed on another device ${stamp}.`
  await api('PUT', `/api/v1/tasks/${leader}/board/marks/probe`, { note: elsewhere })
  await expect(note2.locator('.wn-mark-note')).toHaveValue(elsewhere, { timeout: 15_000 })
  await page.waitForTimeout(1500)
  expect(await savedNote()).toBe(elsewhere)

  // The leader's session heard nothing: a note is read on the board, never delivered.
  expect(await historyText(sid)).not.toContain(lastWords)
  expect(pageErrors).toEqual([])
})

test('a worker has no Board tab; its board posts land on its leader\'s board, which the leader\'s tab shows', async ({ page }) => {
  test.setTimeout(240_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-items-team ${stamp}`
  const leaderTitle = `${engine}-items-team-lead ${stamp}`
  const { id: leader, sid: leaderSid } = await taskWithSession(leaderTitle, { project }, 'Team lead ready')
  const { id: worker, sid } = await taskWithSession(`${engine}-items-team-worker ${stamp}`, { project, parent_task_id: leader }, 'Team worker ready')
  await api('PUT', `/api/v1/tasks/${leader}/board`, {
    html: `<!doctype html><html><head><meta charset="utf-8">${STYLE}</head><body><main>
<h1 class="team-h1" style="font-size:17px">${engine} team board ${stamp}</h1>
<walnut-thread id="team-talk" title="Team talk"></walnut-thread>
</main></body></html>`,
  })

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  // A new parent starts folded: unfold it to reach the worker's own row.
  const leaderRow = page.locator(`.todo-panel-item[data-task-id="${leader}"]`)
  await expect(leaderRow).toBeVisible({ timeout: 90_000 })
  const chevron = leaderRow.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) await chevron.click()

  // ── The worker's panel: no Board tab (2026-10-26, "for non leader, please don't show board") ──
  // Whether it leads is the panel's owner read: wait for that answer, so "no chip" is the decision, not a chip on its way.
  const ownerRead = page.waitForResponse((r) => r.url().includes(`/api/v1/tasks/${worker}/board/owner?tab=1`), { timeout: 60_000 })
  const workerRow = page.locator(`.todo-panel-item[data-task-id="${worker}"]`)
  await expect(workerRow).toBeVisible({ timeout: 30_000 })
  await workerRow.locator('.todo-item-title').click()
  const workerPanel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(workerPanel).toBeVisible({ timeout: 30_000 })
  await expect(workerPanel.locator('[data-header-id="files"]')).toBeVisible({ timeout: 30_000 })
  expect(await (await ownerRead).json()).toMatchObject({ task_id: leader, self: false, own_board: false, open_subtasks: 0 })
  await expect(workerPanel.getByTestId('session-board-chip')).toHaveCount(0)
  await expect(workerPanel.locator('[data-header-id="board"]')).toHaveCount(0)

  // ── The worker still writes the team's board, the way its board_post op does (src/ops/boards.ts):
  // the default board is its owner's, and the post carries the worker session's caller id ──
  const owner = await api<{ task_id: string; self: boolean }>('GET', `/api/v1/tasks/${worker}/board/owner`)
  expect(owner).toMatchObject({ task_id: leader, self: false })
  const workerText = `From the worker session ${stamp}`
  await api('POST', `/api/v1/tasks/${owner.task_id}/board/threads/team-talk`, { text: workerText }, { 'x-walnut-caller-sid': sid })
  await expect.poll(async () => (await getBoard(leader)).threads['team-talk']?.map((m) => [m.author, m.text]), { timeout: 10_000 })
    .toContainEqual([`task:${worker}`, workerText])
  expect((await getBoard(worker)).board).toBeNull()
  expect((await getBoard(worker, true)).board_task_id).toBe(leader)

  // ── The leader's panel has the tab (an open subtask); the worker's still has none ──
  await leaderRow.locator('.todo-item-title').click()
  const leaderPanel = page.locator(`${REAL_PANEL}[data-session-id="${leaderSid}"]`)
  await expect(leaderPanel).toBeVisible({ timeout: 30_000 })
  const leaderChip = leaderPanel.getByTestId('session-board-chip')
  await expect(leaderChip).toBeEnabled({ timeout: 30_000 })
  await expect(workerPanel.getByTestId('session-board-chip')).toHaveCount(0)

  // ── The team board there: the leader's page, with the worker's post in its thread ──
  await leaderChip.click()
  const pane = page.getByTestId('task-board-pane')
  await showCustomBoard(pane)
  const frame = page.frameLocator('.task-board-frame')
  await expect(frame.locator('h1.team-h1')).toHaveText(`${engine} team board ${stamp}`, { timeout: 15_000 })
  const rows = frame.locator('walnut-thread[id="team-talk"] .wn-msg')
  await expect(rows.last().locator('.wn-text')).toHaveText(workerText, { timeout: 15_000 })
  // And the user's post from the leader's tab lands there too.
  await frame.locator('walnut-thread[id="team-talk"] .wn-reply').click()
  const input = pane.getByTestId('board-reply-dock').locator('.chat-input-textarea')
  await input.fill(`From the leader tab ${stamp}`)
  await input.press('Enter')
  await expect(rows.last().locator('.wn-text')).toHaveText(`From the leader tab ${stamp}`, { timeout: 15_000 })
  await expect.poll(async () => (await getBoard(leader)).threads['team-talk']?.map((m) => [m.author, m.text]), { timeout: 10_000 })
    .toContainEqual(['user', `From the leader tab ${stamp}`])
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-C-team-board.png` })
})
