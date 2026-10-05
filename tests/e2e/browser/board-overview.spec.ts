/**
 * The Board's default view, Walnut's Overview of the team
 * (web/src/components/board/BoardOverview.tsx), as a user meets it on Home:
 *
 *   A. A leader with 40 subtasks over three levels in every state (a running
 *      turn, a permission prompt, a session error, NEED_ACTION, unread, WAITING
 *      with a wait-until, done, nested leaders): grouped Needs you / Running /
 *      Open / Done in attention order with counts, Done folded, a child under
 *      its parent, a row moving live when its state changes (a phase edit and a
 *      turn that ends), a click opening the task beside the board, the keyboard.
 *   B. Custom is the leader's page: disabled until one exists, then on live; the
 *      pick is remembered per board owner; while on Custom, Overview carries a
 *      red count of what needs the user; the page's own signals (an unanswered
 *      choice, a thread with a new message) file under their task and clear when
 *      the user acts on the page; the hidden page never marks a thread read.
 *   C. An empty team (the leader alone, "Ask for a board" as a small link), long
 *      and Unicode titles, and a narrow pane (the "now" line moves to the tooltip).
 *   D. A board with projects is a project board: the status strip (counts, a
 *      click filters, again shows all), one card per project in the page's order
 *      (status pill, waiting tag, count line, task chips, the leader's overview,
 *      latest and next, the choices inside the project, its Questions thread),
 *      a General card for the page's loose threads, the other tasks last; "Show:"
 *      hides a part on every card and is remembered; the user changes a status,
 *      answers a choice, reads a thread and asks questions from a card, every
 *      write landing on the server; a failed send keeps the words and a retry
 *      sends them; the leader's text and tasks move live; projects deleted, the
 *      state groups come back.
 *   E. 21 projects over a 42-member team with long and Unicode card text: every
 *      card inside the pane, wide and narrow, light and dark.
 *
 * The chromium and webkit projects share ONE fixture board, so every task is
 * named `${engine}-overview-…` with a stamp, in a project of its own.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = '/tmp/board-overview'

let fixtureRoot = ''
const litter: string[] = []

// deviceScaleFactor 1: evidence shots stay at CSS pixels in WebKit too (Desktop Safari is 2x).
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
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, source: 'local', pinned: false, ...opts })
  litter.push(task.id)
  return task.id
}

const patch = (id: string, body: Record<string, unknown>) => api('PATCH', `/api/tasks/${id}`, body)
const historyText = async (sid: string) => {
  const res = await fetch(`${API}/api/v1/sessions/${sid}/history?tail=50`)
  return res.ok ? res.text() : ''
}

interface SessionView { process_status?: string; pendingPermission?: { toolName?: string } | null; errorMessage?: string }
async function sessionOf(sid: string): Promise<SessionView> {
  const res = await fetch(`${API}/api/sessions/${sid}`)
  if (!res.ok) return {}
  return ((await res.json()) as { session?: SessionView }).session ?? {}
}

/** A mock-CLI session on an existing task (the fixture's MockDaemon runs tests/providers/mock-claude.mjs). */
async function startSession(taskId: string, message: string, mode?: string): Promise<string> {
  const { sessionId } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd: `${fixtureRoot}/projects/walnut`, message, taskId, ...(mode ? { mode } : {}),
  })
  return sessionId
}

/** Real navigation by link click (never page.goto), then the home page. */
async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

/** Open a task's session column from its row, then its Board tab. */
async function openBoardTab(page: Page, taskId: string, sid: string): Promise<{ panel: Locator; pane: Locator }> {
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  return { panel, pane: page.getByTestId('task-board-pane') }
}

/**
 * Back from a task opened beside the board to the panel's own chat. The chat
 * column's tab bar (PeekTabBar, "Chat" first) replaced the peek's own Back
 * button; both shapes are handled while that change lands.
 */
async function backToChat(panel: Locator): Promise<void> {
  const tabs = panel.locator(':scope > .session-panel-split > .session-panel-chat-col > .peek-tab-bar')
  if (await tabs.count()) {
    await tabs.getByRole('tab', { name: 'Chat', exact: true }).click()
    return
  }
  await panel.getByTestId('board-peek-back').click()
}

const rowOf = (pane: Locator, id: string) => pane.locator(`[data-testid="board-overview-row"][data-task-id="${id}"]`)
const groupOf = (pane: Locator, g: string) => pane.getByTestId(`board-overview-group-${g}`)
const rowsIn = (pane: Locator, g: string) => groupOf(pane, g).getByTestId('board-overview-row')
const groupIds = (pane: Locator) => pane.locator('.bo-group').evaluateAll((els) => els.map((el) => el.getAttribute('data-group')))
const idsIn = (pane: Locator, g: string) => rowsIn(pane, g).evaluateAll((els) => els.map((el) => el.getAttribute('data-task-id')))

test('A. a 40-task team, in attention order, live', async ({ page }) => {
  test.setTimeout(480_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-overview-A ${stamp}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const t = (name: string) => `${engine}-overview ${name} ${stamp}`

  // ── The leader, with an idle session of its own ──
  const leader = await createTask(t('leader'), { project })
  const leaderSid = await startSession(leader, 'snapshot-clean-turn:Overview leader ready')
  const sub = (name: string, parent = leader) => createTask(t(name), { project, parent_task_id: parent })

  // ── Live sessions: a permission prompt, a session error, two running turns ──
  const perm = await sub('perm')
  const permSid = await startSession(perm, 'status-permission-test:Bash', 'default') // `default`: the fixture's mode would approve it
  const err = await sub('err')
  const errSid = await startSession(err, 'error')
  const run1 = await sub('run1')
  const run1Sid = await startSession(run1, 'slow:240000 Overview long probe')
  const run2 = await sub('run2')

  // ── Phase-only workers ──
  const need: string[] = []
  for (let i = 1; i <= 3; i++) { const id = await sub(`need${i}`); await patch(id, { phase: 'NEED_ACTION' }); need.push(id) }
  const unread: string[] = []
  for (let i = 1; i <= 2; i++) {
    const id = await sub(`unread${i}`)
    await patch(id, { phase: 'IN_PROGRESS' })
    await patch(id, { unread: true })
    unread.push(id)
  }
  const waitUntil = new Date(Date.now() + 2 * 24 * 3600_000).toISOString()
  const wait: string[] = []
  for (let i = 1; i <= 2; i++) { const id = await sub(`wait${i}`); await patch(id, { phase: 'WAITING', wait_until: waitUntil }); wait.push(id) }
  const todo: string[] = []
  for (let i = 1; i <= 12; i++) todo.push(await sub(`todo${String(i).padStart(2, '0')}`))
  // A nested leader: n1 → n1a (→ n1ax, n1ay), n1b (NEED_ACTION), n1c (done), n1d (WAITING).
  const n1 = await sub('n1 nested lead')
  const n1a = await sub('n1a', n1)
  const n1ax = await sub('n1ax', n1a)
  const n1ay = await sub('n1ay', n1a)
  const n1b = await sub('n1b', n1)
  await patch(n1b, { phase: 'NEED_ACTION' })
  const n1c = await sub('n1c', n1)
  await patch(n1c, { phase: 'COMPLETE' })
  const n1d = await sub('n1d', n1)
  await patch(n1d, { phase: 'WAITING', wait_until: waitUntil })
  const done: string[] = []
  for (let i = 1; i <= 10; i++) { const id = await sub(`done${i}`); await patch(id, { phase: 'COMPLETE' }); done.push(id) }

  // Started last, so it is still running when the page opens; it ends while the test watches.
  const run2Sid = await startSession(run2, 'slow:90000 snapshot-clean-turn:Overview short probe done')
  await expect.poll(async () => (await sessionOf(permSid)).pendingPermission?.toolName ?? '', { timeout: 60_000 }).toBe('Bash')
  await expect.poll(async () => (await sessionOf(errSid)).process_status ?? '', { timeout: 60_000 }).toBe('error')
  await expect.poll(async () => (await sessionOf(run1Sid)).process_status ?? '', { timeout: 60_000 }).toBe('running')
  await expect.poll(async () => (await sessionOf(run2Sid)).process_status ?? '', { timeout: 60_000 }).toBe('running')
  await expect.poll(() => historyText(leaderSid), { timeout: 60_000 }).toContain('Overview leader ready')

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { panel, pane } = await openBoardTab(page, leader, leaderSid)
  await page.evaluate(() => { (window as unknown as { __sameDoc?: number }).__sameDoc = 1 })

  // ── The default view, with no page yet ──
  const overview = pane.getByTestId('board-overview')
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await expect(pane.getByTestId('board-view-overview')).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.getByTestId('board-view-custom')).toHaveAttribute('aria-disabled', 'true')
  await expect(pane.locator('.task-board-frame')).toHaveCount(0)
  const lead = pane.getByTestId('board-overview-leader')
  await expect(lead).toHaveAttribute('data-task-id', leader)
  await expect(lead.getByTestId('board-overview-title')).toHaveText(t('leader'))

  // 40 members: 8 need you, 2 running, 19 open, 11 done.
  await expect(pane.getByTestId('board-overview-rollup')).toContainText('29 open · 11 done', { timeout: 30_000 })
  await expect.poll(() => groupIds(pane)).toEqual(['needs', 'running', 'open', 'done'])
  const count = (g: string) => groupOf(pane, g).getByTestId('board-overview-count')
  await expect(count('needs')).toHaveText('8')
  await expect(count('running')).toHaveText('2')
  await expect(count('open')).toHaveText('19')
  await expect(count('done')).toHaveText('11')
  // Done starts folded: the count only.
  await expect(rowsIn(pane, 'done')).toHaveCount(0)

  // Needs you: the prompt first, then the error, then NEED_ACTION newest first, then unread.
  const needIds = await idsIn(pane, 'needs')
  expect(needIds[0]).toBe(perm)
  expect(needIds[1]).toBe(err)
  // NEED_ACTION newest first, by the phase change the server recorded.
  const changedAt = async (id: string) => (await api<{ task: { phase_changed_at?: string } }>('GET', `/api/tasks/${id}`)).task.phase_changed_at ?? ''
  const handedBack = await Promise.all([...need, n1b].map(async (id) => ({ id, at: await changedAt(id) })))
  expect(handedBack.every((h) => h.at)).toBe(true)
  expect(needIds.slice(2, 6)).toEqual(handedBack.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((h) => h.id))
  expect(needIds.slice(6).sort()).toEqual([...unread].sort())
  const permRow = rowOf(pane, perm)
  await expect(permRow).toHaveAttribute('data-reason', 'permission')
  await expect(permRow.getByTestId('board-overview-badge')).toHaveText('Waiting')
  await expect(permRow.getByTestId('board-overview-badge')).toHaveAttribute('data-tone', 'red')
  await expect(permRow.getByTestId('board-overview-now')).toHaveText('Waiting for approval: Bash')
  await expect(rowOf(pane, err)).toHaveAttribute('data-reason', 'error')
  await expect(rowOf(pane, err).getByTestId('board-overview-badge')).toHaveText('Error')
  await expect(rowOf(pane, need[0]).getByTestId('board-overview-now')).toHaveText('Handed back to you')
  await expect(rowOf(pane, unread[0]).getByTestId('board-overview-now')).toHaveText('New output you have not read')
  await expect(rowOf(pane, unread[0]).locator('.task-unread-dot')).toHaveCount(1)
  // n1b's parent is Open: it says whom it is under.
  await expect(rowOf(pane, n1b).getByTestId('board-overview-now')).toHaveText(`Handed back to you · under ${t('n1 nested lead')}`)

  // Running: both turns, green, pulsing circles.
  expect((await idsIn(pane, 'running')).sort()).toEqual([run1, run2].sort())
  await expect(rowOf(pane, run1).getByTestId('board-overview-badge')).toHaveText('Running')
  await expect(rowOf(pane, run1).locator('.bo-circle')).toHaveClass(/task-circle-running/)

  // Open: WAITING with its wait-until; the nested leader with its children under it.
  await expect(rowOf(pane, wait[0]).getByTestId('board-overview-badge')).toHaveText('Waiting')
  await expect(rowOf(pane, wait[0]).getByTestId('board-overview-badge')).toHaveAttribute('data-tone', 'violet')
  await expect(rowOf(pane, wait[0]).getByTestId('board-overview-now')).toHaveText(/^Until /)
  await expect(rowOf(pane, todo[0]).getByTestId('board-overview-now')).toHaveText('Not started')
  await expect(rowOf(pane, n1).getByTestId('board-overview-leader-pill')).toHaveText('Leader · 3')
  const openIds = await idsIn(pane, 'open')
  const at = openIds.indexOf(n1)
  expect(at).toBeGreaterThanOrEqual(0)
  // n1's open subtree follows it as one block, and n1a's two children right under n1a.
  expect([...openIds.slice(at + 1, at + 5)].sort()).toEqual([n1a, n1ax, n1ay, n1d].sort())
  const ia = openIds.indexOf(n1a)
  expect([...openIds.slice(ia + 1, ia + 3)].sort()).toEqual([n1ax, n1ay].sort())
  await expect(rowOf(pane, n1a)).toHaveAttribute('data-indent', '1')
  await expect(rowOf(pane, n1ax)).toHaveAttribute('data-indent', '2')
  await expect(rowOf(pane, n1d)).toHaveAttribute('data-indent', '1')
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-A1-overview.png` })

  // Done unfolds on a click.
  await groupOf(pane, 'done').locator('.bo-group-head').click()
  await expect(rowsIn(pane, 'done')).toHaveCount(11)
  await expect(rowOf(pane, done[0]).getByTestId('board-overview-badge')).toHaveText('Done')
  await groupOf(pane, 'done').locator('.bo-group-head').click()
  await expect(rowsIn(pane, 'done')).toHaveCount(0)

  // ── Live: a phase edit moves its row, no reload ──
  await patch(todo[0], { phase: 'NEED_ACTION' })
  await expect(rowOf(pane, todo[0])).toHaveAttribute('data-group', 'needs', { timeout: 15_000 })
  await expect(count('needs')).toHaveText('9')
  await expect(count('open')).toHaveText('18')
  await expect(rowsIn(pane, 'needs').first()).toHaveAttribute('data-task-id', perm) // a newer NEED_ACTION never outranks a prompt
  // A turn that ends leaves Running by itself (to Open, or Needs you if it handed back).
  await expect(rowOf(pane, run2)).not.toHaveAttribute('data-group', 'running', { timeout: 150_000 })
  await expect(count('running')).toHaveText('1')
  expect(await page.evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)).toBe(1)

  // ── A row opens its task beside the board ──
  await rowOf(pane, run1).click()
  const peek = panel.getByTestId('board-task-peek')
  await expect(peek).toHaveAttribute('data-task-id', run1)
  await expect(peek.getByTestId('board-peek-title')).toHaveText(t('run1'))
  await expect(pane).toBeVisible()
  await backToChat(panel)
  await expect(peek).toBeHidden()

  // ── The keyboard: Down from the leader reaches the Needs you head, then its first row ──
  await lead.focus()
  await page.keyboard.press('ArrowDown')
  await expect(groupOf(pane, 'needs').locator('.bo-group-head')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(permRow).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(peek).toHaveAttribute('data-task-id', perm)
  await backToChat(panel)
  await expect(peek).toBeHidden()

  await overview.evaluate((el) => el.scrollTo(0, 0))
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-A2-after-live.png` })
  expect(pageErrors).toEqual([])
})

test('B. Custom is the leader\'s page: off until one exists, remembered per owner, Overview keeps the count', async ({ page }) => {
  test.setTimeout(360_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-overview-B ${stamp}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const t = (name: string) => `${engine}-overview ${name} ${stamp}`

  // The leader has no session, so nothing the page delivers starts a turn that moves it;
  // the user reads the team's board from a worker's panel (a worker's Board is its leader's).
  const leadA = await createTask(t('lead A'), { project })
  const viewer = await createTask(t('viewer'), { project, parent_task_id: leadA })
  const viewerSid = await startSession(viewer, 'snapshot-clean-turn:Viewer ready')
  const handed = await createTask(t('handed back'), { project, parent_task_id: leadA })
  await patch(handed, { phase: 'NEED_ACTION' })
  const probe = await createTask(t('probe'), { project, parent_task_id: leadA })
  const leadB = await createTask(t('lead B'), { project })
  const sidB = await startSession(leadB, 'snapshot-clean-turn:Lead B ready')
  await createTask(t('B worker'), { project, parent_task_id: leadB })
  await api('PUT', `/api/v1/tasks/${leadB}/board`, { html: `<h1 class="b-page">${engine} page B ${stamp}</h1>` })
  await expect.poll(() => historyText(viewerSid), { timeout: 60_000 }).toContain('Viewer ready')
  await expect.poll(async () => (await sessionOf(viewerSid)).process_status ?? '', { timeout: 60_000 }).not.toBe('running')
  await expect.poll(() => historyText(sidB), { timeout: 60_000 }).toContain('Lead B ready')

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  // A new parent starts folded: unfold it to reach the worker's own row.
  const leadRow = page.locator(`.todo-panel-item[data-task-id="${leadA}"]`)
  await expect(leadRow).toBeVisible({ timeout: 90_000 })
  const chevron = leadRow.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) await chevron.click()
  const { panel, pane } = await openBoardTab(page, viewer, viewerSid)
  const overview = pane.getByTestId('board-overview')
  const overviewSeg = pane.getByTestId('board-view-overview')
  const customSeg = pane.getByTestId('board-view-custom')
  const frame = page.frameLocator('.task-board-frame')

  // ── The team's board, under its keeper; no page: Custom is off and says why ──
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await expect(pane.getByTestId('board-title')).toHaveText(`Board · ${t('lead A')}`)
  await expect(pane.getByTestId('board-overview-leader')).toHaveAttribute('data-task-id', leadA)
  await expect(customSeg).toHaveAttribute('aria-disabled', 'true')
  await expect(customSeg).toHaveAttribute('title', 'No custom page yet: the leader has not written one')
  // A real click on the off segment (force: Playwright treats aria-disabled as not clickable) does nothing.
  await customSeg.click({ force: true })
  await expect(overview).toBeVisible()
  await expect(overviewSeg).toHaveAttribute('aria-pressed', 'true')
  await expect(rowOf(pane, handed)).toHaveAttribute('data-group', 'needs')
  await expect(rowOf(pane, probe)).toHaveAttribute('data-group', 'open')
  await expect(pane.getByTestId('board-overview-no-page')).toContainText('No custom page yet.')
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-B1-no-page.png` })

  // ── The leader writes a page: Custom turns on live; its choice and thread file under `probe` ──
  await api('PUT', `/api/v1/tasks/${leadA}/board`, {
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:14px sans-serif;padding:12px">
<h1 class="a-page" style="font-size:17px">${engine} page A ${stamp}</h1>
<walnut-choice id="scope" title="Probe scope" task="${probe}" options="small:Only the cold path,full:Every path" recommended="small"></walnut-choice>
<walnut-thread id="probe-talk" title="Probe talk" task="${probe}"></walnut-thread>
</body></html>`,
  })
  await expect(customSeg).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  await expect(pane.getByTestId('board-overview-no-page')).toHaveCount(0)
  await expect(rowOf(pane, probe)).toHaveAttribute('data-reason', 'board', { timeout: 15_000 })
  await expect(rowOf(pane, probe).getByTestId('board-overview-now')).toHaveText('Choice on the page: Probe scope')
  // A team member's message in the probe's thread joins it.
  const post = (text: string) => fetch(`${API}/api/v1/tasks/${leadA}/board/threads/probe-talk`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': viewerSid },
    body: JSON.stringify({ text }),
  })
  expect((await post('Which scope should the probe cover?')).status).toBe(201)
  await expect(rowOf(pane, probe).getByTestId('board-overview-now')).toHaveText('Choice on the page: Probe scope (+1 more)', { timeout: 15_000 })
  await expect(rowOf(pane, probe)).toHaveAttribute('title', /1 new message in Probe talk/)
  // Still the Overview: a page arriving never switches the view.
  await expect(overviewSeg).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.locator('.task-board-frame')).toHaveCount(0)
  // What the Overview shows as needing the user (the viewer too, if its turn handed back).
  const needing = await rowsIn(pane, 'needs').count()
  expect(needing).toBeGreaterThanOrEqual(2)

  // ── Custom: the page; Overview carries the red count ──
  await customSeg.click()
  await expect(customSeg).toHaveAttribute('aria-pressed', 'true')
  await expect(frame.locator('h1.a-page')).toHaveText(`${engine} page A ${stamp}`, { timeout: 15_000 })
  await expect(overview).toHaveCount(0)
  await expect(pane.getByTestId('board-meta')).toHaveText(/^v\d+ · updated .+ by you$/)
  const attention = pane.getByTestId('board-view-attention')
  await expect(attention).toHaveText(String(needing))
  await pane.locator('.task-board-bar').screenshot({ path: `${SHOT_DIR}/${engine}-B2-custom-bar.png` })
  // The user acts on the page: answers the choice, and reads the thread (on screen 1.5 s).
  await frame.locator('walnut-choice[id="scope"] .wn-choice-opt').first().click()
  await expect(frame.locator('walnut-choice[id="scope"]')).toHaveAttribute('data-answered', '', { timeout: 15_000 })
  await expect(attention).toHaveText(String(needing - 1), { timeout: 20_000 })
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-B3-custom.png` })

  // ── Back on the Overview: probe is Open again ──
  await overviewSeg.click()
  await expect(overview).toBeVisible()
  await expect(attention).toHaveCount(0)
  await expect(rowOf(pane, probe)).toHaveAttribute('data-group', 'open')
  // The page stays loaded, hidden: a new message while on the Overview stays unread.
  await expect(pane.locator('.task-board-frame')).toHaveCount(1)
  await expect(pane.locator('.task-board-frame')).toBeHidden()
  const seenBefore = await page.evaluate((id) => localStorage.getItem(`walnut-board-seen:${id}`), leadA)
  expect(seenBefore).toContain('probe-talk')
  expect((await post('Started on the cold path.')).status).toBe(201)
  await expect(rowOf(pane, probe).getByTestId('board-overview-now')).toHaveText('1 new message in Probe talk', { timeout: 15_000 })
  await page.waitForTimeout(3000)
  await expect(rowOf(pane, probe)).toHaveAttribute('data-reason', 'board')
  expect(await page.evaluate((id) => localStorage.getItem(`walnut-board-seen:${id}`), leadA)).toBe(seenBefore)

  // ── Remembered per owner: Custom comes back for A after Files ──
  await customSeg.click()
  await expect(frame.locator('h1.a-page')).toBeVisible()
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(pane).toHaveCount(0)
  await panel.getByTestId('session-board-chip').click()
  await expect(customSeg).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(frame.locator('h1.a-page')).toBeVisible({ timeout: 15_000 })
  // B (another owner, with a page of its own) opens on the Overview. A board opens full
  // screen, over the task list: collapse it first. Two columns then: every locator below
  // is scoped to B's panel.
  await panel.getByRole('button', { name: 'Collapse session', exact: true }).click()
  await openBoardTab(page, leadB, sidB)
  const paneOfB = page.locator(`${REAL_PANEL}[data-session-id="${sidB}"]`).getByTestId('task-board-pane')
  await expect(paneOfB.getByTestId('board-overview')).toBeVisible({ timeout: 15_000 })
  await expect(paneOfB.getByTestId('board-view-overview')).toHaveAttribute('aria-pressed', 'true')
  await expect(paneOfB.getByTestId('board-view-custom')).not.toHaveAttribute('aria-disabled', 'true')
  expect(await page.evaluate((ids) => ids.map((id) => localStorage.getItem(`walnut:board-view.v1:${id}`)), [leadA, leadB]))
    .toEqual(['custom', null])
  expect(pageErrors).toEqual([])
})

test('C. an empty team, long and Unicode titles, a narrow pane', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-overview-C ${stamp}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  const solo = await createTask(`${engine}-overview solo ${stamp}`, { project })
  const sid = await startSession(solo, 'snapshot-clean-turn:Solo ready')
  await expect.poll(() => historyText(sid), { timeout: 60_000 }).toContain('Solo ready')

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const { panel, pane } = await openBoardTab(page, solo, sid)
  const overview = pane.getByTestId('board-overview')

  // ── The leader alone: its row, "No workers yet", the ask as a small link ──
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await expect(pane.getByTestId('board-overview-leader')).toHaveAttribute('data-task-id', solo)
  // No rollup for an empty team: the body says it once.
  await expect(pane.getByTestId('board-overview-rollup')).toHaveCount(0)
  await expect(overview.locator('.bo-meter')).toHaveCount(0)
  await expect(pane.getByTestId('board-overview-empty')).toContainText('No workers yet.')
  await expect(overview.getByText('No workers yet', { exact: false })).toHaveCount(1)
  await expect(pane.getByTestId('board-empty')).toHaveCount(0) // the old full-pane card is gone
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-C1-empty.png` })
  // The ask is a small link, sent through this session's own composer.
  const ask = pane.getByTestId('board-ask-button')
  await expect(ask).toHaveText('Ask for a board')
  await ask.click()
  await expect(ask).toHaveText('Asked.')
  await expect(panel.getByText(/Please start a Board for this task: read the walnut-board skill/).first()).toBeVisible({ timeout: 15_000 })
  await expect(ask).toHaveText('Ask for a board', { timeout: 8_000 })

  // ── Workers arrive live: a very long title and a Unicode one ──
  const long = `${engine}-overview long ${stamp} `
    + 'Reconcile the rollout plan with every regional dependency, then confirm the cache purge window with the on-call before the deploy train leaves '.repeat(2)
  // Test data: Japanese, an emoji and accented Latin, as escapes.
  const unicode = `${engine}-overview \u65e5\u672c\u8a9e\u306e\u30bf\u30a4\u30c8\u30eb\u3092\u78ba\u8a8d\u3059\u308b \u{1F680} caf\u00e9 r\u00e9sum\u00e9 ${stamp}`
  const longId = await createTask(long, { project, parent_task_id: solo })
  const uniId = await createTask(unicode, { project, parent_task_id: solo })
  await patch(uniId, { phase: 'WAITING', wait_until: new Date(Date.now() + 86400_000).toISOString() })
  await expect(rowOf(pane, longId)).toBeVisible({ timeout: 15_000 })
  await expect(rowOf(pane, uniId).getByTestId('board-overview-title')).toHaveText(unicode)
  await expect(pane.getByTestId('board-overview-empty')).toHaveCount(0)
  await expect(pane.getByTestId('board-overview-rollup')).toContainText('2 open · 0 done')
  // One line each, the long title cut with an ellipsis inside its row.
  for (const id of [longId, uniId]) {
    const box = (await rowOf(pane, id).boundingBox())!
    expect(box.height).toBeLessThanOrEqual(32)
  }
  const cut = await rowOf(pane, longId).getByTestId('board-overview-title').evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow,
  }))
  expect(cut).toEqual({ clipped: true, overflow: 'ellipsis' })
  const rowBox = (await rowOf(pane, longId).boundingBox())!
  const paneBox = (await overview.boundingBox())!
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1)
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-C2-titles-wide.png` })

  // ── A narrow pane (about 400px): the user widens the chat by its handle; the now-line moves into the tooltip ──
  const wide = (await overview.boundingBox())!.width
  const handle = panel.locator(':scope > .session-panel-split > .session-panel-chat-resize')
  // The handle is a 1px line whose grab zone (::before) hangs over both neighbours; the chat
  // column, later in the DOM, paints over its right half. Grab at a point that hits the handle.
  const grab = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    for (const dx of [-2, -1, 0.5, 0, 1]) {
      const hit = document.elementFromPoint(r.left + dx, y)
      if (hit === el) return { x: r.left + dx, y }
    }
    return null
  })
  expect(grab).not.toBeNull()
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x - (wide - 400), grab!.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await overview.boundingBox())!.width).toBeLessThanOrEqual(420)
  const width = (await overview.boundingBox())!.width
  test.info().annotations.push({ type: 'narrow-pane-width', description: `${Math.round(wide)} -> ${Math.round(width)}` })
  expect(width).toBeGreaterThanOrEqual(340)
  const uniRow = rowOf(pane, uniId)
  await expect(uniRow.getByTestId('board-overview-now')).toBeHidden()
  await expect(uniRow).toHaveAttribute('title', /Waiting · Until /)
  for (const id of [longId, uniId]) {
    const box = (await rowOf(pane, id).boundingBox())!
    expect(box.height).toBeLessThanOrEqual(32)
    expect(box.x + box.width).toBeLessThanOrEqual((await overview.boundingBox())!.x + width + 1)
  }
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-C3-narrow.png` })

  // ── Dark theme, same pane ──
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(200)
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-C4-narrow-dark.png` })
  expect(pageErrors).toEqual([])
})


const cardOf = (pane: Locator, id: string) => pane.locator(`[data-testid="board-card"][data-card-id="${id}"]`)
const cardIds = (pane: Locator) => pane.getByTestId('board-card').evaluateAll((els) => els.map((el) => el.getAttribute('data-card-id')))
const chipIds = (card: Locator) => card.getByTestId('board-card-chip').evaluateAll((els) => els.map((el) => el.getAttribute('data-task-id')))
const tileOf = (pane: Locator, f: string) => pane.getByTestId(`board-strip-${f}`)
const tileCount = async (pane: Locator, f: string) => (await tileOf(pane, f).locator('.bpb-n').textContent())?.trim() ?? ''

interface BoardRead {
  projects: Record<string, { status?: string; status_by?: string }>
  choices: Record<string, { option?: string; text?: string }>
  threads: Record<string, Array<{ author: string; text: string }>>
}

test('D. a board with projects is a project board: strip, cards, the user\'s writes, live', async ({ page }) => {
  test.setTimeout(420_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-overview-D ${stamp}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const t = (name: string) => `${engine}-overview ${name} ${stamp}`

  // The leader has no session (a user's write would start its turn); the user reads the
  // team's board from a worker's panel, and that worker writes the projects as the leader
  // would (board_project_set: a session's write, nothing delivered).
  const lead = await createTask(t('lead D'), { project })
  const viewer = await createTask(t('viewer'), { project, parent_task_id: lead })
  const viewerSid = await startSession(viewer, 'snapshot-clean-turn:Viewer D ready')
  const sub = (name: string) => createTask(t(name), { project, parent_task_id: lead })
  const aNeed = await sub('A handed back')
  await patch(aNeed, { phase: 'NEED_ACTION' })
  const aDone = await sub('A finished')
  await patch(aDone, { phase: 'COMPLETE' })
  // The worker's own subtask: the leader's list does not name it, it follows its parent.
  const aSub = await createTask(t('A probe'), { project, parent_task_id: aNeed })
  const bOpen = await sub('B open')
  const loose = await sub('loose')
  const looseDone = await sub('loose finished')
  await patch(looseDone, { phase: 'COMPLETE' })
  // A ticket filed elsewhere that B's area tracks: on B's card, never in the team's counts.
  const ext = await createTask(t('ext ticket'), { project: `${project} ext` })
  // The page shows B before A, a choice and a thread inside A, a loose thread at the end; C is recorded only.
  await api('PUT', `/api/v1/tasks/${lead}/board`, {
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:14px sans-serif;padding:12px">
<h1 style="font-size:17px">${engine} page D ${stamp}</h1>
<section data-project="area-b"><h2>B <walnut-project id="area-b"></walnut-project></h2></section>
<section data-project="area-a"><h2>A <walnut-project id="area-a"></walnut-project></h2>
<walnut-choice id="pick-a" title="Ship the fix?" options="now:Ship now,wait:Wait for the review" recommended="wait">The review is half done.</walnut-choice>
<walnut-thread id="area-a" title="A talk"></walnut-thread>
</section>
<walnut-thread id="overall" title="Overall"></walnut-thread>
</body></html>`,
  })
  const asLeader = { 'x-walnut-caller-sid': viewerSid }
  const setProject = (id: string, body: Record<string, unknown>) => api('PUT', `/api/v1/tasks/${lead}/board/projects/${id}`, body, asLeader)
  const readBoard = () => api<BoardRead>('GET', `/api/v1/tasks/${lead}/board`)
  await setProject('area-a', {
    title: 'A bus race', status: 'decide', tasks: [aNeed, aDone],
    summary: 'Two deploys rolled the cell; the **watcher** deleted its own bus.',
    latest: 'Fix in review, one more check `kube-401` to go.', next: 'Ship Monday after the review.',
    waiting: '3 CRs to deploy', meta: '12 tickets',
  })
  await setProject('area-b', { title: 'B leader handover', status: 'done', tasks: [bOpen, ext], summary: 'Handed over.' })
  await setProject('area-c', { title: 'C image CVE', status: 'wait' })
  await api('POST', `/api/v1/tasks/${lead}/board/threads/area-a`, { text: 'Found the cause: the watcher.' }, asLeader)
  await expect.poll(() => historyText(viewerSid), { timeout: 60_000 }).toContain('Viewer D ready')
  await expect.poll(async () => (await sessionOf(viewerSid)).process_status ?? '', { timeout: 60_000 }).not.toBe('running')

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const leadRow = page.locator(`.todo-panel-item[data-task-id="${lead}"]`)
  await expect(leadRow).toBeVisible({ timeout: 90_000 })
  const chevron = leadRow.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) await chevron.click()
  const { panel, pane } = await openBoardTab(page, viewer, viewerSid)
  const overview = pane.getByTestId('board-overview')
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await expect(pane.getByTestId('board-overview-leader')).toHaveAttribute('data-task-id', lead)
  await expect(pane.getByTestId('board-project-board')).toBeVisible({ timeout: 15_000 })

  // ── The strip and the cards, in the page's order ──
  await expect.poll(() => cardIds(pane), { timeout: 15_000 }).toEqual(['_general', 'area-b', 'area-a', 'area-c', '_rest', '_rest-done'])
  await expect(pane.locator('.bo-group[data-group]')).toHaveCount(0) // no state groups beside the cards
  expect([await tileCount(pane, 'decide'), await tileCount(pane, 'wip'), await tileCount(pane, 'wait'), await tileCount(pane, 'done'), await tileCount(pane, 'all')])
    .toEqual(['1', '0', '1', '1', '3'])
  await expect(tileOf(pane, 'none')).toHaveCount(0)
  await expect(tileOf(pane, 'all')).toHaveAttribute('aria-pressed', 'true')

  const a = cardOf(pane, 'area-a')
  await expect(a.getByTestId('board-card-title')).toHaveText('A bus race')
  await expect(a.getByTestId('board-card-status')).toContainText('Needs you')
  await expect(a.getByTestId('board-card-status')).toHaveAttribute('data-tone', 'red')
  await expect(a.getByTestId('board-card-waiting')).toHaveText('3 CRs to deploy')
  await expect(a.getByTestId('board-card-meta')).toHaveText('12 tickets')
  await expect(a.getByTestId('board-card-attention')).toHaveText('1 needs you')
  expect(await chipIds(a)).toEqual([aNeed, aSub, aDone]) // open first (the subtask after its parent), done after
  await expect(a.locator(`[data-testid="board-card-chip"][data-task-id="${aNeed}"]`)).toHaveAttribute('data-group', 'needs')
  await expect(a.locator('.bpc-summary strong')).toHaveText('watcher') // light markdown
  await expect(a.getByTestId('board-card-latest')).toContainText('Fix in review')
  await expect(a.getByTestId('board-card-latest').locator('code')).toHaveText('kube-401')
  await expect(a.getByTestId('board-card-next')).toContainText('Ship Monday after the review.')
  const choice = a.getByTestId('board-card-choice')
  await expect(choice).toHaveAttribute('data-answered', 'false')
  await expect(choice).toContainText('Ship the fix?')
  await expect(choice).toContainText('The review is half done.')
  await expect(choice.getByTestId('board-card-option')).toHaveText([/Ship now/, /Wait for the review.*Recommended/])
  const aThread = a.getByTestId('board-card-thread')
  await expect(aThread).toHaveCount(1)
  await expect(aThread.getByTestId('board-card-thread-unread')).toHaveText('1 new')
  await expect(aThread.locator('.bpc-thread-peek')).toContainText('Found the cause: the watcher.')
  // A done card starts folded; a click opens it.
  const b = cardOf(pane, 'area-b')
  await expect(b.getByTestId('board-card-fold')).toHaveAttribute('aria-expanded', 'false')
  await expect(b.getByTestId('board-card-chip')).toHaveCount(0)
  await b.getByTestId('board-card-fold').click()
  expect((await chipIds(b)).sort()).toEqual([bOpen, ext].sort())
  // A project with no task and no text: its own Questions thread, a quiet "not written yet".
  const c = cardOf(pane, 'area-c')
  await expect(c.getByTestId('board-card-status')).toContainText('Waiting on others')
  await expect(c.getByTestId('board-card-chip')).toHaveCount(0)
  await expect(c.locator('.bpc-none')).toBeVisible()
  await expect(c.getByTestId('board-card-thread')).toHaveAttribute('data-thread-id', 'area-c')
  // The loose thread is General's; the other tasks close the board (the done ones folded).
  await expect(cardOf(pane, '_general').getByTestId('board-card-thread')).toHaveAttribute('data-thread-id', 'overall')
  expect((await chipIds(cardOf(pane, '_rest'))).sort()).toEqual([loose, viewer].sort())
  await expect(cardOf(pane, '_rest-done').getByTestId('board-card-fold')).toHaveAttribute('aria-expanded', 'false')
  await expect(pane.getByTestId('board-overview-rollup')).toContainText('5 open · 2 done')
  await overview.evaluate((el) => { el.scrollTop = 0 })
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-D1-cards.png` })

  // ── A chip opens its task beside the board ──
  await a.locator(`[data-testid="board-card-chip"][data-task-id="${aNeed}"]`).click()
  const peek = panel.getByTestId('board-task-peek')
  await expect(peek).toHaveAttribute('data-task-id', aNeed)
  await backToChat(panel)
  await expect(peek).toBeHidden()

  // ── The strip filters; the same tile again shows all ──
  await tileOf(pane, 'decide').click()
  await expect(tileOf(pane, 'decide')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => cardIds(pane)).toEqual(['area-a'])
  await tileOf(pane, 'done').click()
  await expect.poll(() => cardIds(pane)).toEqual(['area-b'])
  await tileOf(pane, 'done').click()
  await expect.poll(() => cardIds(pane)).toEqual(['_general', 'area-b', 'area-a', 'area-c', '_rest', '_rest-done'])
  await expect(tileOf(pane, 'all')).toHaveAttribute('aria-pressed', 'true')

  // ── "Show:" hides a part on every card, and the pick outlives the view ──
  await pane.getByTestId('board-part-latest').click()
  await expect(pane.getByTestId('board-part-latest')).toHaveAttribute('aria-pressed', 'false')
  await expect(pane.getByTestId('board-card-latest')).toHaveCount(0)
  await expect(a.getByTestId('board-card-next')).toBeVisible()
  await pane.getByTestId('board-view-custom').click()
  await expect(pane.locator('iframe.task-board-frame')).toBeVisible()
  await pane.getByTestId('board-view-overview').click()
  await expect(pane.getByTestId('board-part-latest')).toHaveAttribute('aria-pressed', 'false')
  await expect(pane.getByTestId('board-card-latest')).toHaveCount(0)
  await pane.getByTestId('board-part-latest').click()
  await expect(cardOf(pane, 'area-a').getByTestId('board-card-latest')).toBeVisible()

  // ── The user changes a status from the card: theirs, on the server, the strip recounted ──
  await c.getByTestId('board-card-status').click()
  await expect(c.getByTestId('board-card-picker')).toBeVisible()
  await c.getByTestId('board-card-pick-wip').click()
  await expect(c.getByTestId('board-card-status')).toContainText('In progress · yours', { timeout: 15_000 })
  await expect(c).toHaveAttribute('data-tone', 'blue')
  await expect.poll(async () => (await readBoard()).projects['area-c']).toMatchObject({ status: 'wip', status_by: 'human' })
  await expect.poll(() => tileCount(pane, 'wait')).toBe('0')
  expect(await tileCount(pane, 'wip')).toBe('1')

  // ── The user answers the choice: stored, folded to one line, the project counts as answered ──
  await choice.getByTestId('board-card-option').filter({ hasText: 'Ship now' }).click()
  await expect.poll(async () => (await readBoard()).choices['pick-a']?.option, { timeout: 15_000 }).toBe('now')
  await expect(choice).toHaveAttribute('data-answered', 'true')
  // The leader has no session: the answer waits on the board, and the card says so.
  await expect(choice.locator('.bpc-ok')).toHaveText('Saved. The leader sees it on the board.')
  await expect(a.locator('.bpc-tag-answered')).toBeVisible()
  await expect.poll(() => tileCount(pane, 'decide')).toBe('0')

  // ── Reading the thread clears its "new"; a reply goes to the server (Shift+Enter is a new line) ──
  await aThread.getByTestId('board-card-thread-toggle').click()
  await expect(aThread.getByTestId('board-card-thread-unread')).toHaveCount(0)
  await expect(aThread.getByTestId('board-card-message')).toHaveCount(1)
  const reply = aThread.getByTestId('board-card-composer').locator('textarea')
  await reply.click()
  await page.keyboard.type('Why wait')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('for the review?')
  await page.keyboard.press('Enter')
  await expect(aThread.getByTestId('board-card-message')).toHaveCount(2, { timeout: 15_000 })
  await expect(reply).toHaveValue('')
  await expect.poll(async () => (await readBoard()).threads['area-a']?.map((m) => [m.author, m.text]))
    .toEqual([[`task:${viewer}`, 'Found the cause: the watcher.'], ['user', 'Why wait\nfor the review?']])

  await a.screenshot({ path: `${SHOT_DIR}/${engine}-D1b-card-answered.png` })

  // ── Asking on a card whose page shows no thread; the first send fails and keeps the words ──
  let failOnce = true
  await page.route(`**/api/v1/tasks/${lead}/board/threads/area-c`, async (route) => {
    if (failOnce && route.request().method() === 'POST') {
      failOnce = false
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'boom', message: 'Disk full' } }) })
      return
    }
    await route.continue()
  })
  await c.getByTestId('board-card-ask').click()
  const ask = c.getByTestId('board-card-composer').locator('textarea')
  await expect(ask).toBeFocused()
  await page.keyboard.type('Is the image rebuilt yet?')
  await page.keyboard.press('Enter')
  await expect(c.getByTestId('board-card-composer-error')).toContainText('Disk full', { timeout: 15_000 })
  await expect(ask).toHaveValue('Is the image rebuilt yet?')
  await c.screenshot({ path: `${SHOT_DIR}/${engine}-D1c-send-failed.png` })
  await c.getByTestId('board-card-send').click()
  await expect(c.getByTestId('board-card-message')).toHaveCount(1, { timeout: 15_000 })
  await expect(c.getByTestId('board-card-composer-error')).toHaveCount(0)
  await expect.poll(async () => (await readBoard()).threads['area-c']?.map((m) => m.text)).toEqual(['Is the image rebuilt yet?'])
  await page.unroute(`**/api/v1/tasks/${lead}/board/threads/area-c`)

  // ── Live: the leader's text and tasks move on the card ──
  await setProject('area-a', { latest: 'Deployed to staging.' })
  await expect(a.getByTestId('board-card-latest')).toContainText('Deployed to staging.', { timeout: 15_000 })
  await setProject('area-c', { tasks: [loose] })
  await expect.poll(() => chipIds(c), { timeout: 15_000 }).toEqual([loose])
  expect(await chipIds(cardOf(pane, '_rest'))).toEqual([viewer])
  await patch(bOpen, { phase: 'NEED_ACTION' })
  await expect(b.getByTestId('board-card-attention')).toHaveText('1 needs you', { timeout: 15_000 })

  // Every card stays inside the pane.
  const paneBox = (await overview.boundingBox())!
  for (const card of await pane.getByTestId('board-card').all()) {
    const box = (await card.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1)
  }
  await overview.evaluate((el) => { el.scrollTop = 0 })
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-D2-cards-after.png` })

  // ── Dark theme, same pane ──
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(200)
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-D3-cards-dark.png` })
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))

  // ── The projects gone: the state groups are back ──
  for (const id of ['area-a', 'area-b', 'area-c']) await setProject(id, { delete: true, override_user: true })
  await expect(pane.getByTestId('board-project-board')).toHaveCount(0, { timeout: 15_000 })
  expect(await groupIds(pane)).toEqual(['needs', 'open', 'done'])
  expect(await idsIn(pane, 'needs')).toEqual(expect.arrayContaining([aNeed, bOpen])) // the viewer may be handed back too
  expect(pageErrors).toEqual([])
})

test('E. 21 projects over a 42-member team with long card text: every card inside the pane, wide and narrow', async ({ page }) => {
  test.setTimeout(420_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-overview-E ${stamp}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const t = (name: string) => `${engine}-overview ${name} ${stamp}`

  const lead = await createTask(t('lead E'), { project })
  const viewer = await createTask(t('viewer'), { project, parent_task_id: lead })
  const viewerSid = await startSession(viewer, 'snapshot-clean-turn:Viewer E ready')
  // 21 areas, A..U: 13 hold two tasks each (some done, some handed back), 8 hold none; the
  // rest of the team is 15 done tickets. Titles and text are long, some in Japanese with an
  // emoji (as escapes), as a real board's are.
  const letters = 'ABCDEFGHIJKLMNOPQRSTU'.split('')
  const statuses = ['wait', 'decide', 'done', 'wait', 'wait', 'wip', 'wip', 'done', 'wait', 'wait', 'wait', 'decide', 'done', 'done', 'wait', 'decide', 'done', 'decide', 'wip', 'decide', 'decide']
  const longTail = ' after the regional rollout, with the on-call confirming the purge window and the deploy train held until the cache is warm'
  const jp = '\u30ea\u30fc\u30c0\u30fc\u5207\u308a\u66ff\u3048\u3067\u30a4\u30d9\u30f3\u30c8\u6d88\u5931 \u{1F6A8}'
  const sectionTasks: Record<string, string[]> = {}
  for (const [i, letter] of letters.entries()) {
    if (i >= 13) continue
    const ids: string[] = []
    for (const k of [1, 2]) {
      const title = i % 4 === 2 ? `${letter}${k} ${jp} ${stamp}` : `${t(`area ${letter}${k} probe`)}${i % 3 === 0 ? longTail : ''}`
      const id = await createTask(title, { project, parent_task_id: lead })
      ids.push(id)
      if (statuses[i] === 'done') await patch(id, { phase: 'COMPLETE' })
      else if (statuses[i] === 'decide' && k === 1) await patch(id, { phase: 'NEED_ACTION' })
    }
    sectionTasks[`sec-${letter.toLowerCase()}`] = ids
  }
  for (let i = 1; i <= 15; i++) {
    const id = await createTask(t(`merged ticket ${i}`), { project, parent_task_id: lead })
    await patch(id, { phase: 'COMPLETE' })
  }
  // The page shows 20 of the areas, not alphabetically (U is recorded only), each with its thread.
  const pageOrder = ['a', 'b', 'c', 'd', 'e', 'f', 'h', 'i', 'j', 'l', 'n', 'q', 'r', 's', 't', 'k', 'o', 'g', 'm', 'p']
  await api('PUT', `/api/v1/tasks/${lead}/board`, {
    html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="font:14px sans-serif;padding:12px">
<h1 style="font-size:17px">${engine} page E ${stamp}</h1>
${pageOrder.map((l) => `<section data-project="sec-${l}"><h2>${l.toUpperCase()}</h2><walnut-thread id="sec-${l}"></walnut-thread></section>`).join('\n')}
</body></html>`,
  })
  const asLeader = { 'x-walnut-caller-sid': viewerSid }
  for (const [i, letter] of letters.entries()) {
    const id = `sec-${letter.toLowerCase()}`
    const title = i % 5 === 1
      ? `${letter} \u30ce\u30fc\u30c9\u30e1\u30e2\u30ea\u56de\u53ce\u30da\u30fc\u30b8 (D${100 + i}, 09-10 \u5fa9\u65e7\u6e08\u307f)`
      : `${letter} ${['Bus race', 'Memory reclaim page', 'Grey failure', 'Alert family', 'Dropped events'][i % 5]}${i % 3 === 0 ? longTail : ''}`
    await api('PUT', `/api/v1/tasks/${lead}/board/projects/${id}`, {
      title, status: statuses[i], ...(sectionTasks[id] ? { tasks: sectionTasks[id] } : {}),
      summary: `${i % 2 ? jp : 'Two deploys rolled every cell'}${longTail}.${longTail}`,
      latest: `Checked https://example.com/tickets/${1000 + i} again;${longTail}`,
      next: i % 3 ? `Deploy ${letter} on Monday` : '',
      waiting: i % 4 === 0 ? `Waiting on ${i + 1} CRs to deploy across the regions` : '',
      meta: `${i + 2} tickets (${i} Sev2 + 2 Sev2.5)`,
    }, asLeader)
  }
  await expect.poll(() => historyText(viewerSid), { timeout: 60_000 }).toContain('Viewer E ready')
  await expect.poll(async () => (await sessionOf(viewerSid)).process_status ?? '', { timeout: 60_000 }).not.toBe('running')

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const leadRow = page.locator(`.todo-panel-item[data-task-id="${lead}"]`)
  await expect(leadRow).toBeVisible({ timeout: 90_000 })
  const chevron = leadRow.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) await chevron.click()
  const { panel, pane } = await openBoardTab(page, viewer, viewerSid)
  const overview = pane.getByTestId('board-overview')
  await expect(overview).toBeVisible({ timeout: 15_000 })
  await expect(cardOf(pane, 'sec-u')).toBeVisible({ timeout: 20_000 })

  // ── 21 cards in the page's order, U after them, then the other tasks ──
  await expect.poll(() => cardIds(pane), { timeout: 15_000 }).toEqual([...pageOrder.map((l) => `sec-${l}`), 'sec-u', '_rest', '_rest-done'])
  expect([await tileCount(pane, 'decide'), await tileCount(pane, 'wip'), await tileCount(pane, 'wait'), await tileCount(pane, 'done'), await tileCount(pane, 'all')])
    .toEqual(['6', '3', '7', '5', '21'])
  await expect(pane.getByTestId('board-overview-rollup')).toContainText('21 open · 21 done')
  for (const [i, letter] of letters.entries()) {
    const card = cardOf(pane, `sec-${letter.toLowerCase()}`)
    await expect(card.getByTestId('board-card-status')).toContainText(
      { wait: 'Waiting on others', decide: 'Needs you', wip: 'In progress', done: 'Done' }[statuses[i]]!)
    await expect(card.getByTestId('board-card-fold')).toHaveAttribute('aria-expanded', statuses[i] === 'done' ? 'false' : 'true')
    if (i < 13 && statuses[i] === 'decide') await expect(card.getByTestId('board-card-attention')).toHaveText('1 needs you')
    else await expect(card.getByTestId('board-card-attention')).toHaveCount(0)
  }
  const fits = async () => {
    const paneBox = (await overview.boundingBox())!
    for (const card of await pane.getByTestId('board-card').all()) {
      await card.scrollIntoViewIfNeeded()
      const box = (await card.boundingBox())!
      expect(box.x, 'inside the pane').toBeGreaterThanOrEqual(paneBox.x - 1)
      expect(box.x + box.width, 'inside the pane').toBeLessThanOrEqual(paneBox.x + paneBox.width + 1)
      // Nothing inside a card is wider than the card.
      const overflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow, 'no horizontal overflow').toBeLessThanOrEqual(1)
    }
    const strip = (await pane.getByTestId('board-strip').boundingBox())!
    expect(strip.x + strip.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1)
  }
  await fits()
  await overview.evaluate((el) => { el.scrollTop = 0 })
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-E1-dense-wide.png` })

  // ── A narrow pane (about 400px): still inside, long titles cut ──
  const wide = (await overview.boundingBox())!.width
  const handle = panel.locator(':scope > .session-panel-split > .session-panel-chat-resize')
  const grab = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    for (const dx of [-2, -1, 0.5, 0, 1]) {
      const hit = document.elementFromPoint(r.left + dx, y)
      if (hit === el) return { x: r.left + dx, y }
    }
    return null
  })
  expect(grab).not.toBeNull()
  await page.mouse.move(grab!.x, grab!.y)
  await page.mouse.down()
  await page.mouse.move(grab!.x - (wide - 400), grab!.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await overview.boundingBox())!.width).toBeLessThanOrEqual(420)
  await fits()
  const cut = await cardOf(pane, 'sec-a').getByTestId('board-card-title').evaluate((el) => ({
    clipped: el.scrollWidth > el.clientWidth, overflow: getComputedStyle(el).textOverflow,
  }))
  expect(cut).toEqual({ clipped: true, overflow: 'ellipsis' })
  await overview.evaluate((el) => { el.scrollTop = 0 })
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-E2-dense-narrow.png` })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(200)
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-E3-dense-narrow-dark.png` })
  expect(pageErrors).toEqual([])
})
