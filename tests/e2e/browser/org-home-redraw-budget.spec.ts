/**
 * The Org page and Home draw only what changed, at the user's density, on the production bundle.
 *
 * The complaint (2026-11-23, task 9bceb9f2): the Mac app's main thread blocked 100 to 470 ms in
 * 27 React render passes, 20 of them on /org, each set off by a task update over the socket, and
 * the chat beside the Org page logged 195 slow commits (p50 540 ms). The app's list held about
 * 1,169 tasks, 84% complete. Two causes: a task update drew the whole page (its root, the list,
 * every row, the node's chat and the chat beside it), and a minute clock at the page root (and at
 * Home's list) drew the whole page every 60 s to move a few "5m ago" labels.
 *
 * The guard, on /org with an org of several VPs and a chat open beside, and on Home:
 *  - one agent status write draws the rows that show that task, never the node's chat or the
 *    chat beside it (SessionChatHistory, SessionPanelBody);
 *  - a minute of the clock draws no page root, no list and no row (the time labels subscribe to
 *    one shared minute clock themselves: web/src/utils/minute-clock.ts).
 * Each step's draws (web/src/utils/render-count.ts) and its main-thread CPU (Chrome's trace) are
 * printed on a `REDRAW` line.
 *
 * The open session panels themselves (2026-11-25, task 9bceb9f2: 119 main-thread blocks in a day
 * on the Mac app, p50 300 ms, each drawing SessionPanelBody and SessionChatHistory up to 21
 * times): a panel draws its body (over a thousand hooks) for every new copy of something it
 * reads, and its pollers and re-reads handed it new copies of the same answer. On Home with two
 * long chats open, and on /org, none of these may draw a panel or a chat:
 *  - its polls (cron recovery every 15 s, the slash command retries, the browser tabs);
 *  - the window coming back to the front (focus, show: the inbox and more read again);
 *  - a config change (every experiment's reader read the flags again);
 *  - and a status write of its own session that changes nothing its chat shows draws no chat.
 */
import { test, expect, type Page } from '@playwright/test'
import { serveProductionBundle } from './production-bundle'
import { isolateUiPrefs } from './todo-panel-helpers'
import { REAL_PANEL, seedColumns } from './draft-helpers'
import { answerTaskList } from './task-list-stub'
import { traceTaskTimes } from './cpu-reference'
import { AI_SESSION, DENSE_SESSION, NO_THREAD_SESSION } from './threads-fixture'

test.use({ viewport: { width: 1600, height: 900 } })
test.describe.configure({ mode: 'default' })
test.setTimeout(240_000)

/** The Mac app's list on 2026-11-23: about 1,169 tasks, 84% of them completed. */
const TASKS = 1169
const PROJECTS = ['Atlas', 'Beacon', 'Cedar', 'Delta', 'Ember', 'Fjord', 'Grove', 'Inlet', 'Juniper', 'Kestrel']
/** Six VPs; three of them lead a second project too (org_leads). */
const VPS: Array<{ project: string; leads?: string[] }> = [
  { project: 'Atlas', leads: ['Beacon'] }, { project: 'Cedar', leads: ['Delta'] }, { project: 'Ember' },
  { project: 'Fjord', leads: ['Grove'] }, { project: 'Inlet' }, { project: 'Juniper', leads: ['Kestrel'] },
]
const SIDE_TASK = 'pw-task-threads-ai'

type T = Record<string, unknown> & { id: string }

function orgTasks(): T[] {
  const at = new Date(Date.now() - 7 * 60_000).toISOString()
  const base = (id: string, title: string, project: string, phase: string): T => ({
    id, title, project, phase, status: phase === 'COMPLETE' ? 'done' : phase === 'TODO' ? 'todo' : 'in_progress',
    priority: 'none', source: 'local', created_at: at, updated_at: at,
    description: 'x'.repeat(80), summary: 's'.repeat(120), note: '', subtasks: [], tags: [], session_ids: [],
  })
  const out: T[] = [{ ...base('org-main', 'Main', 'Inbox', 'IN_PROGRESS'), org_role: 'main', session_id: DENSE_SESSION, session_ids: [DENSE_SESSION] }]
  for (const vp of VPS) out.push({ ...base(`org-vp-${vp.project}`, `${vp.project} VP`, vp.project, 'IN_PROGRESS'), org_role: 'lead', ...(vp.leads ? { org_leads: vp.leads } : {}) })
  out.push({ ...base(SIDE_TASK, 'Threads AI fixture session', 'Atlas', 'IN_PROGRESS'), session_id: AI_SESSION, session_ids: [AI_SESSION] })
  const left = TASKS - out.length
  const directors = new Map<string, string>()
  for (let i = 0; i < left; i++) {
    const project = PROJECTS[i % PROJECTS.length]!
    const done = i < left * 0.84
    const phase = done ? 'COMPLETE' : i % 4 === 0 ? 'TODO' : i % 9 === 0 ? 'AGENT_COMPLETE' : 'IN_PROGRESS'
    const t: T = base(`org-work-${i}`, `Work item ${i} of ${project}: ${'a task title '.repeat(i % 5 === 0 ? 4 : 1)}`, project, phase)
    if (!done && phase === 'IN_PROGRESS') t.user_status = { state: 'working', now: `Step ${i}`, at }
    // Every project's first open task is a Director with some of the open work under it.
    if (!done) {
      const head = directors.get(project)
      if (!head) directors.set(project, t.id)
      else if (i % 3 === 0) t.parent_task_id = head
    }
    out.push(t)
  }
  // One open Atlas task is due in 40 minutes: its row's due pill ("40m") moves every minute.
  const due = out.find((t) => t.project === 'Atlas' && t.id.startsWith('org-work-') && t.phase === 'TODO' && !t.parent_task_id)!
  due.due_date = new Date(Date.now() + 40 * 60_000).toISOString()
  return out
}

/** An open task under a VP whose agent reports a new step: what production sends most. */
function statusWrite(tasks: T[], n: number): Record<string, unknown> {
  const open = tasks.filter((t) => t.id.startsWith('org-work-') && t.phase === 'IN_PROGRESS' && !t.parent_task_id)
  const task = open[(n * 7) % open.length]!
  const at = new Date().toISOString()
  return { task: { ...task, updated_at: at, user_status: { state: 'working', now: `Reading the logs, step ${n}`, next: 'Fix it', at } } }
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    w.__walnutRenderCounts = {}
    const Native = window.WebSocket
    const socks: WebSocket[] = []
    w.__pwSocks = socks
    class Probe extends Native { constructor(u: string | URL, p?: string | string[]) { super(u, p); socks.push(this) } }
    window.WebSocket = Probe as unknown as typeof WebSocket
  })
}

/** Something drew since the counters were last emptied (they are not emptied here). */
const drew = (page: Page) => page.evaluate(() => Object.keys((window as unknown as { __walnutRenderCounts: Record<string, number> }).__walnutRenderCounts).length > 0)

const draws = (page: Page) => page.evaluate(() => { const w = window as unknown as { __walnutRenderCounts: Record<string, number> }; const c = { ...w.__walnutRenderCounts }; w.__walnutRenderCounts = {}; return c })

/** Until the page draws nothing for 800 ms (the counters are emptied). */
async function quiet(page: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await draws(page)
    await page.waitForTimeout(800)
    if (Object.keys(await draws(page)).length === 0) return
  }
  throw new Error('the page kept drawing with nothing happening')
}

interface Step { draws: Record<string, number>; cpuMs: number; longestMs: number; seen?: number }

/** Until the step's draws stop growing (read without emptying the counters): its follow-up passes
 *  (a fetch, a deferred render) land in it. */
async function settle(page: Page): Promise<void> {
  const total = () => page.evaluate(() => new Promise<number>((done) => {
    const w = window as unknown as { __walnutRenderCounts: Record<string, number> }
    const read = () => done(Object.values(w.__walnutRenderCounts).reduce((a, b) => a + b, 0))
    requestAnimationFrame(() => setTimeout(read, 250))
  }))
  let last = -1
  for (let i = 0; i < 20; i++) {
    const now = await total()
    if (now === last) return
    last = now
  }
}

/** One step's draws and main-thread CPU, at its cleanest of three tries (a stray draw on a busy
 *  runner lands in one try; a regression's draws land in every one). `took` is the step's own sign
 *  that it reached the page (a draw, a label that moved), waited for before it settles. `seen`,
 *  read once it settled, is what the page shows that the step may draw (rows of the task, labels
 *  that moved). */
async function measure(page: Page, act: (n: number) => Promise<void>, took: (n: number) => Promise<boolean>, clean: (c: Record<string, number>, seen: number) => boolean, seen: (n: number) => Promise<number> = async () => 0): Promise<Step> {
  let best: Step | null = null
  const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0)
  for (let n = 0; n < 3; n++) {
    await quiet(page)
    const stop = await traceTaskTimes(page, 0)
    await act(n)
    await expect.poll(() => took(n), { timeout: 10_000 }).toBe(true)
    await settle(page)
    const tasks = await stop()
    const c = await draws(page)
    const step = { draws: c, cpuMs: tasks.reduce((a, t) => a + t.cpu, 0), longestMs: Math.max(0, ...tasks.map((t) => t.cpu)), seen: await seen(n) }
    if (clean(c, step.seen)) return step
    if (!best || total(c) < total(best.draws)) best = step
  }
  return best!
}

/** One server event, as the socket hands it to the page. */
async function sendEvent(page: Page, name: string, data: Record<string, unknown>): Promise<void> {
  await page.evaluate(([n, d]) => {
    const sock = (window as unknown as { __pwSocks: WebSocket[] }).__pwSocks.find((s) => s.readyState === 1)!
    sock.onmessage!(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, seq: 1, data: d }) }))
  }, [name, data] as const)
}

const sendFrame = (page: Page, data: Record<string, unknown>) => sendEvent(page, 'task:updated', data)

/** Whether the page got a response whose URL matches `re` since `arm` was last called. */
function responses(page: Page, re: RegExp): { arm: () => void; seen: () => boolean } {
  let hit = true
  page.on('response', (r) => { if (re.test(r.url())) hit = true })
  return { arm: () => { hit = false }, seen: () => hit }
}

interface PanelSteps { poll: Step; focus: Step; config: Step; ownStatus: Step; processStatus: Step; experiment: Step }

/** What must draw no session panel and no chat (the panels' own pollers and re-reads), on the
 *  page as it is; `sid` is an open panel's session, written to by the last step. */
async function quietPanelSteps(page: Page, sid: string): Promise<PanelSteps> {
  const none = (c: Record<string, number>) => !c.SessionPanelBody && !c.SessionChatHistory
  // Cron recovery reads every open session every 15 s; the jump also lands the slash command
  // retries that are due (3 and 8 s). (The browser tabs' re-read, every 20 s and only for a task
  // with tabs, is not in it.)
  const supervision = responses(page, /\/api\/sessions\/[^/]+\/supervision/)
  const poll = await measure(page, async () => { supervision.arm(); await page.clock.fastForward(16_000) }, async () => supervision.seen(), none)
  // The window back in front: the inbox, the task list and more read again.
  const inbox = responses(page, /\/api\/v1\/human-inbox/)
  const focus = await measure(page, async () => {
    inbox.arm()
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
  }, async () => inbox.seen(), none)
  const configRead = responses(page, /\/api\/config(\?|$)/)
  const config = await measure(page, async () => { configRead.arm(); await sendEvent(page, 'config:changed', {}) }, async () => configRead.seen(), none)
  // A status write of the panel's own session that moves only its revision and time. (A try with
  // a draw of Home's list, from elsewhere now and then, is tried again.)
  const status = await page.evaluate(async (id) => (await (await fetch(`/api/sessions/status?ids=${encodeURIComponent(id)}`)).json()).statuses[id], sid)
  let revision = (status.statusRevision as number) + 100
  const ownStatus = await measure(page, async () => {
    revision += 1
    await sendEvent(page, 'session:status-changed', { sessionId: sid, status: { ...status, statusRevision: revision, statusUpdatedAt: new Date().toISOString() } })
  }, async () => true, (c) => !c.SessionChatHistory && !c.TaskRowBody)
  // The controls: what the panel and its chat show still draws them. A new process status draws
  // the chat (its stream follows it); it goes back after, so the page stays as it was.
  const processStatus = await measure(page, async () => {
    revision += 1
    await sendEvent(page, 'session:status-changed', { sessionId: sid, status: { ...status, process_status: 'running', statusRevision: revision, statusUpdatedAt: new Date().toISOString() } })
  }, async () => true, (c) => (c.SessionChatHistory ?? 0) >= 1)
  revision += 1
  await sendEvent(page, 'session:status-changed', { sessionId: sid, status: { ...status, statusRevision: revision, statusUpdatedAt: new Date().toISOString() } })
  await quiet(page)
  // An experiment the panel reads (voice_conversation), turned the other way on the server: the
  // panel draws for it. Answered here, and left so: the test ends with it.
  let flip = false
  await page.route(/\/api\/config(\?|$)/, async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { config?: { experimental?: Record<string, boolean> } }
    if (body.config) body.config.experimental = { ...body.config.experimental, voice_conversation: flip }
    await route.fulfill({ response: res, json: body })
  })
  const experiment = await measure(page, async (n) => { flip = n % 2 === 0; configRead.arm(); await sendEvent(page, 'config:changed', {}) },
    async () => configRead.seen(), (c) => (c.SessionPanelBody ?? 0) >= 1)
  return { poll, focus, config, ownStatus, processStatus, experiment }
}

function expectQuietPanels({ processStatus, experiment, ...steps }: PanelSteps): void {
  // The controls hold on every build: a test that drew nothing at all would pass the rest.
  expect(steps.ownStatus.draws.SessionPanelBody ?? 0, `ownStatus: ${JSON.stringify(steps.ownStatus)}`).toBeGreaterThanOrEqual(1)
  expect(processStatus.draws.SessionChatHistory ?? 0, `processStatus: ${JSON.stringify(processStatus)}`).toBeGreaterThanOrEqual(1)
  expect(experiment.draws.SessionPanelBody ?? 0, `experiment: ${JSON.stringify(experiment)}`).toBeGreaterThanOrEqual(1)
  // Before: a poll, a focus and a config change each drew every open panel (a config change
  // its chat too); a status write of a session drew its chat.
  for (const [name, step] of Object.entries(steps)) {
    expect(step.draws.SessionChatHistory ?? 0, `${name}: ${JSON.stringify(step)}`).toBe(0)
    if (name !== 'ownStatus') expect(step.draws.SessionPanelBody ?? 0, `${name}: ${JSON.stringify(step)}`).toBe(0)
  }
}

/** Draw counters a page's root, a list or a chat would raise; none may move on a minute. A chat's
 *  panel (SessionPanelBody) is in too: its pollers land inside the jump of the clock and, answering
 *  what it shows, draw nothing (before 2026-11-25 they drew every open panel, 4 draws here). */
const PAGE_LEVEL = ['OrgPage', 'OrgChannelList', 'OrgNodeDetail', 'OrgTaskRail', 'OrgTaskTabRow', 'OrgSidePanel', 'MainPage', 'TodoPanel', 'TaskRowBody', 'SessionChatHistory', 'SessionPanelBody']
const pageLevel = (c: Record<string, number>) => Object.fromEntries(PAGE_LEVEL.filter((k) => c[k]).map((k) => [k, c[k]]))

/** Home's rows' due pills ("40m"), by task. */
const duePills = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.todo-panel-item[data-task-id]')].map((el) => [el.getAttribute('data-task-id'), el.querySelector('.todo-item-due-pill:not(.todo-item-start-pill)')?.textContent ?? '']).filter(([, v]) => v)))
const changed = (a: Record<string, string>, b: Record<string, string>) => Object.keys(b).filter((k) => b[k] !== a[k]).length

/** The Org list's rows' hovers ("moved 5m ago"), by row. */
const rowTitles = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="org-channel"][data-key]')].map((el) => [el.getAttribute('data-key'), el.getAttribute('title') ?? ''])))

async function open(page: Page, tasks: T[], url: string): Promise<void> {
  await page.clock.install()
  await serveProductionBundle(page)
  await isolateUiPrefs(page)
  await instrument(page)
  await answerTaskList(page, () => tasks)
  await page.goto(url)
}

test('on /org a status write draws only its rows and no chat, a minute only the labels that moved, a poll, a focus or a config change no panel', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'traced on Chromium')
  const tasks = orgTasks()
  await open(page, tasks, `/org?node=main&open=task:${SIDE_TASK}`)
  await expect(page.getByTestId('org-detail')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="org-chat"] .markdown-body').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="org-side-strip"] .markdown-body').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid="org-channel"]')).toHaveCount(VPS.length + 4, { timeout: 30_000 }).catch(() => {})
  const boot = await draws(page)
  for (const name of ['OrgPage', 'OrgChannelList', 'OrgChannelRow', 'OrgNodeDetail', 'SessionChatHistory']) expect(boot[name] ?? 0, `${name} counts its draws: ${JSON.stringify(boot)}`).toBeGreaterThan(0)
  // The rows' hovers name a time ("moved 7m ago"): what a minute must move.
  expect(Object.values(await rowTitles(page)).some((t) => /\d+m ago/.test(t)), JSON.stringify(await rowTitles(page))).toBe(true)

  const update = await measure(page, (n) => sendFrame(page, statusWrite(tasks, n)), () => drew(page),
    (c) => !c.SessionChatHistory && !c.SessionPanelBody && !c.OrgSidePanel && (c.OrgChannelRow ?? 0) <= 2)
  let before: Record<string, string> = {}
  const moved = async () => changed(before, await rowTitles(page))
  const minute = await measure(page, async () => { before = await rowTitles(page); await page.clock.fastForward(60_000) },
    async () => (await moved()) > 0,
    (c, n) => Object.keys(pageLevel(c)).length === 0 && (c.OrgChannelRow ?? 0) <= n, moved)
  const panels = await quietPanelSteps(page, AI_SESSION)
  console.log('REDRAW org ' + JSON.stringify({ update, minute, panels }))
  expectQuietPanels(panels)

  // The chats, the one beside the page and the node's own, never draw for another task's status
  // (before: each drew its panel and its history, twice a write).
  expect(update.draws.SessionChatHistory ?? 0, JSON.stringify(update)).toBe(0)
  expect(update.draws.SessionPanelBody ?? 0, JSON.stringify(update)).toBe(0)
  expect(update.draws.OrgSidePanel ?? 0, JSON.stringify(update)).toBe(0)
  // At most the rows that show the task: its VP's row (and the CEO's, which sums every VP's), and
  // its row in the node's rail (before: every row of the list, 7 here).
  expect(update.draws.OrgChannelRow ?? 0, JSON.stringify(update)).toBeLessThanOrEqual(2)
  expect(update.draws.OrgTaskTabRow ?? 0, JSON.stringify(update)).toBeLessThanOrEqual(2)
  // The list and the node draw once, to hand on that row; the page itself holds the org built from
  // the task list, so it runs for it (twice: the list, then the session status it reads).
  expect(update.draws.OrgChannelList ?? 0, JSON.stringify(update)).toBeLessThanOrEqual(1)
  expect(update.draws.OrgNodeDetail ?? 0, JSON.stringify(update)).toBeLessThanOrEqual(1)
  expect(update.draws.OrgPage ?? 0, JSON.stringify(update)).toBeLessThanOrEqual(2)
  // A minute moved the hovers (the clock is alive: "moved 7m ago" became "8m"), drew no page, list,
  // node or chat history, and drew a row only when its hover changed (before: the page root and
  // everything under it).
  expect(minute.seen ?? 0, JSON.stringify(minute)).toBeGreaterThan(0)
  expect(pageLevel(minute.draws), JSON.stringify(minute)).toEqual({})
  expect(minute.draws.OrgChannelRow ?? 0, JSON.stringify(minute)).toBeLessThanOrEqual(minute.seen ?? 0)
})

test('on Home a minute draws no page, list or row; a status write, a poll, a focus or a config change draws no chat', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'traced on Chromium')
  const tasks = orgTasks()
  // Two long chats open, as the user keeps them (the second one 230 turns).
  await seedColumns(page, [DENSE_SESSION, NO_THREAD_SESSION])
  await open(page, tasks, '/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  // Three projects open, as the user keeps some: their rows are what a whole-list draw would redraw.
  for (const p of ['Atlas', 'Beacon', 'Cedar']) await page.locator('.todo-panel').getByText(p, { exact: true }).first().click()
  await expect(page.locator('.todo-panel-item').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`${REAL_PANEL} .markdown-body`).first()).toBeVisible({ timeout: 30_000 })
  const boot = await draws(page)
  for (const name of ['MainPage', 'TodoPanel', 'TaskRowBody', 'SessionChatHistory']) expect(boot[name] ?? 0, `${name} counts its draws: ${JSON.stringify(boot)}`).toBeGreaterThan(0)
  // The task due in 40 minutes shows its due pill: what a minute must move.
  await expect.poll(async () => Object.values(await duePills(page)).some((t) => /^\d+m$/.test(t)), { timeout: 10_000 }).toBe(true)

  // The rows a write may draw: the rows shown of the written task's project (a row that moves
  // with the task's new place draws to move).
  const projectRows = (n: number) => page.evaluate((ids) => ids.filter((id) => document.querySelector(`.todo-panel-item[data-task-id="${id}"]`)).length,
    tasks.filter((t) => t.project === (statusWrite(tasks, n).task as T).project).map((t) => t.id))
  const update = await measure(page, (n) => sendFrame(page, statusWrite(tasks, n)), () => drew(page),
    (c, rows) => !c.SessionChatHistory && !c.SessionPanelBody && (c.TaskRowBody ?? 0) <= rows, projectRows)
  const shownRows = await page.locator('.todo-panel-item').count()
  let pillsBefore: Record<string, string> = {}
  const pillsMoved = async () => changed(pillsBefore, await duePills(page))
  const minute = await measure(page, async () => { pillsBefore = await duePills(page); await page.clock.fastForward(60_000) },
    async () => (await pillsMoved()) > 0, (c) => Object.keys(pageLevel(c)).length === 0, pillsMoved)
  await expect(page.locator(REAL_PANEL)).toHaveCount(2, { timeout: 30_000 })
  const panels = await quietPanelSteps(page, DENSE_SESSION)
  console.log('REDRAW home ' + JSON.stringify({ update, minute, shownRows, panels }))
  expectQuietPanels(panels)

  expect(update.draws.SessionChatHistory ?? 0, JSON.stringify(update)).toBe(0)
  expect(update.draws.SessionPanelBody ?? 0, JSON.stringify(update)).toBe(0)
  // Only the rows of the written task's project (before: every row shown, 54 here, for four
  // handlers made again with each new task list).
  expect(update.draws.TaskRowBody ?? 0, JSON.stringify(update)).toBeLessThanOrEqual(update.seen ?? 0)
  expect(update.draws.TaskRowBody ?? 0, JSON.stringify(update)).toBeLessThan(shownRows)
  // A minute moved the due pill ("40m" became "39m": the clock is alive) and drew no page, list or
  // row (before: Home's whole task list, every minute).
  expect(minute.seen ?? 0, JSON.stringify(minute)).toBeGreaterThan(0)
  expect(pageLevel(minute.draws), JSON.stringify(minute)).toEqual({})
})
