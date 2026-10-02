/**
 * The task Board (web/src/components/board/TaskBoardPane.tsx + the frame
 * runtime board-runtime.frame.js / board-elements.frame.js), the Worker pill and
 * the Adopt picker, as a user meets them on Home.
 *
 *   1. A leader's session header has a Board chip; with no board, the tab offers
 *      "Ask for a board", which goes to the session through the composer's send.
 *   2. A board written through the API renders in the sandboxed frame: a live
 *      task chip (the store's phase, updated without a reload), the status strip
 *      (counts, filtering), the unread total, an unknown id, external and `#`
 *      links.
 *   3. The user's thread message: optimistic row, stored with author `user`, never
 *      unread. A leader answer (posted with the leader session's caller id) is
 *      unread while its section is filtered out, and read once it has been on
 *      screen; the read state is this browser's (localStorage).
 *   4. An html edit re-renders the frame without a page reload: the new title,
 *      the old thread rows, and an unsent draft all survive.
 *   5. A mark saves state and note.
 *   6. A chip leads to the task on the home board.
 *   7. Worker pill text; adopt from the kebab and from the Leader pill; leave.
 *
 * The chromium and webkit projects share ONE fixture board, so every task is
 * named `${engine}-board-…` with a stamp and nothing counts across the board.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOT_DIR = '/tmp/leader-board'

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
  board: { html: string; version: number; updated_by: string } | null
  threads: Record<string, Array<{ id: string; author: string; text: string; ts: string }>>
  marks: Record<string, { state?: string; note?: string }>
}
const getBoard = (taskId: string) => api<BoardGet>('GET', `/api/v1/tasks/${taskId}/board`)

/** Real navigation by link click (never page.goto), then the home page. */
async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

async function quickStart(page: Page, composer: Locator, prompt: string): Promise<{ taskId: string; sessionId: string }> {
  const response = page.waitForResponse((r) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(prompt)
  await composer.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const out = (await res.json()) as { taskId: string; sessionId: string }
  litter.push(out.taskId)
  return out
}

function boardHtml(engine: string, stamp: string, worker: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Board</title>
<style>
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; background: #f3f4f7; color: #1f2430; }
  header { padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e8ee; }
  header h1 { margin: 0 0 4px; font-size: 17px; }
  main { padding: 6px 16px 40px; }
  details { background: #fff; border: 1px solid #e5e8ee; border-radius: 10px; margin: 8px 0; padding: 0 12px 10px; }
  summary { cursor: pointer; padding: 8px 0; }
  summary h3 { display: inline; margin: 0; font-size: 14px; }
</style></head>
<body>
<header>
  <h1>${engine} board ${stamp}</h1>
  <div class="sub">Checked just now · <walnut-unread></walnut-unread></div>
  <walnut-strip></walnut-strip>
</header>
<main>
<details id="sec-a" data-status="decide" open>
  <summary><h3 class="area-a-title">Area A: probe is red</h3></summary>
  <p>Owner: <walnut-task id="${worker}"></walnut-task> runs the probe. See <a class="ext" href="https://example.com/runbook">the runbook</a> or <a class="jump" href="#sec-b">Area B</a>.</p>
  <walnut-thread id="area-a" title="Area A" task="${worker}"></walnut-thread>
  <walnut-mark id="area-a"></walnut-mark>
</details>
<details id="sec-b" data-status="wip" open>
  <summary><h3>Area B: rollout</h3></summary>
  <p>In flight: <walnut-task id="${worker}" compact></walnut-task> and <walnut-task id="nosuchtask0000"></walnut-task>.</p>
</details>
</main>
</body></html>`
}

test('the Board tab: ask, live components, threads, re-render, marks and locate', async ({ page }) => {
  test.setTimeout(300_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // example.com never leaves the machine: the popup lands on a stub.
  await page.context().route('https://example.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub</p>' }))
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  // ── The leader: a task with a live mock-CLI session; its worker by API ──
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const { taskId: leader, sessionId } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Board leader ready')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Board leader ready', { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  const leaderTitle = `${engine}-board-leader ${stamp}`
  await api('PATCH', `/api/tasks/${leader}`, { title: leaderTitle })
  const { task: leaderTask } = await api<{ task: { project?: string } }>('GET', `/api/tasks/${leader}`)
  const workerTitle = `${engine}-board-worker ${stamp}`
  const worker = await createTask(workerTitle, { project: leaderTask.project ?? '', pinned: false, parent_task_id: leader })

  // ── 1. The chip, the empty state, "Ask for a board" ──
  const chip = panel.getByTestId('session-board-chip')
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(chip).toHaveClass(/session-action-chip-active/)
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-empty')).toBeVisible({ timeout: 15_000 })
  await expect(pane.getByTestId('board-empty')).toContainText('No board yet.')
  const ask = pane.getByTestId('board-ask-button')
  await expect(ask).toHaveText('Ask for a board')
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-1-empty.png` })
  await ask.click()
  await expect(ask).toHaveText('Asked.')
  await expect(panel.getByText(/Please start a Board for this task: read the walnut-board skill/).first()).toBeVisible({ timeout: 15_000 })
  await expect(ask).toHaveText('Ask for a board', { timeout: 8_000 })

  // ── 2. A board arrives: the frame renders it live, no click needed ──
  await api('PUT', `/api/v1/tasks/${leader}/board`, { html: boardHtml(engine, stamp, worker) })
  const frame = page.frameLocator('.task-board-frame')
  const workerChip = frame.locator(`#sec-a walnut-task[id="${worker}"] .wn-task`)
  await expect(workerChip.locator('.wn-title')).toHaveText(workerTitle, { timeout: 15_000 })
  await expect(workerChip.locator('.wn-phase')).toHaveText('To do')
  await expect(workerChip).toHaveAttribute('data-phase', 'TODO')
  await expect(frame.locator(`#sec-b walnut-task[id="${worker}"] .wn-phase`)).toHaveCount(0) // compact
  const unknown = frame.locator('walnut-task[id="nosuchtask0000"] .wn-task')
  await expect(unknown).toHaveClass(/wn-unknown/)
  await expect(unknown.locator('.wn-title')).toHaveText('nosuchtask0000')
  await expect(frame.locator('.wn-box[data-f="decide"] b')).toHaveText('1')
  await expect(frame.locator('.wn-box[data-f="wip"] b')).toHaveText('1')
  await expect(frame.locator('.wn-box[data-f="wait"] b')).toHaveText('0')
  await expect(frame.locator('.wn-box[data-f=""] b')).toHaveText('2')
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages')
  await expect(pane.getByTestId('board-meta')).toHaveText(/^v\d+ · updated .+ by you$/)
  // The frame is sandboxed without same-origin: it cannot touch the app.
  await expect(page.locator('.task-board-frame')).toHaveAttribute('sandbox', 'allow-scripts')
  await frame.locator('body').evaluate(() => { (window as unknown as { __sameDoc?: number }).__sameDoc = 1 })

  // The chip follows the store: a phase change lands without re-rendering the frame.
  await api('PATCH', `/api/tasks/${worker}`, { phase: 'IN_PROGRESS' })
  await expect(workerChip.locator('.wn-phase')).toHaveText('In progress', { timeout: 15_000 })
  await expect(workerChip).toHaveAttribute('data-phase', 'IN_PROGRESS')
  expect(await frame.locator('body').evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)).toBe(1)

  // An external link opens a tab; a `#` link scrolls inside the frame without navigating it.
  const popup = page.context().waitForEvent('page')
  await frame.locator('a.ext').click()
  const tab = await popup
  await expect.poll(() => tab.url()).toContain('https://example.com/runbook')
  await tab.close()
  await frame.locator('a.jump').click()
  expect(await frame.locator('body').evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)).toBe(1)

  // ── 3. The user's message: first row, "You", stored as `user`, never unread ──
  const thread = frame.locator('walnut-thread[id="area-a"]')
  await expect(thread.locator('.wn-thread-title')).toHaveText('Area A')
  await thread.locator('.wn-input').fill('Why is this red?')
  await thread.locator('.wn-send').click()
  const firstRow = thread.locator('.wn-msg').first()
  await expect(firstRow.locator('.wn-who')).toHaveText('You')
  await expect(firstRow.locator('.wn-text')).toHaveText('Why is this red?')
  await expect(firstRow).not.toHaveClass(/wn-pending|wn-failed/, { timeout: 15_000 })
  await expect(thread.locator('.wn-input')).toHaveValue('')
  let stored = await getBoard(leader)
  expect(stored.threads['area-a'].map((m) => [m.author, m.text])).toContainEqual(['user', 'Why is this red?'])
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages')
  // Cmd/Ctrl+Enter sends too; an empty composer sends nothing.
  await thread.locator('.wn-input').fill('Second note')
  await thread.locator('.wn-input').press('ControlOrMeta+Enter')
  await expect(thread.locator('.wn-msg').first().locator('.wn-text')).toHaveText('Second note')
  await thread.locator('.wn-send').click()
  await expect(thread.locator('.wn-msg')).toHaveCount(2)

  // ── A leader answer while its section is filtered out: unread until seen ──
  await frame.locator('.wn-box[data-f="wip"]').click()
  await expect(frame.locator('#sec-a')).toBeHidden()
  await expect(frame.locator('.wn-box[data-f="wip"]')).toHaveAttribute('aria-pressed', 'true')
  const answer = await fetch(`${API}/api/v1/tasks/${leader}/board/threads/area-a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': sessionId },
    body: JSON.stringify({ text: 'Red because the probe timed out.\nRun: https://example.com/run/1.' }),
  })
  expect(answer.status).toBe(201)
  await expect(frame.locator('.wn-unread-n')).toHaveText('1 new message', { timeout: 15_000 })
  await expect(thread.locator('.wn-badge')).toHaveText('1 new')
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-2-filtered-unread.png` })
  // The unread total jumps to it: the filter clears, and 1.5 s on screen reads it.
  await frame.locator('walnut-unread').click()
  await expect(frame.locator('#sec-a')).toBeVisible()
  const leaderRow = thread.locator('.wn-msg').first()
  await expect(leaderRow.locator('.wn-who')).toHaveText('Leader')
  await expect(leaderRow.locator('a.wn-link')).toHaveAttribute('href', 'https://example.com/run/1')
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages', { timeout: 10_000 })
  await expect(leaderRow).not.toHaveAttribute('data-unread')
  const seen = await page.evaluate((id) => localStorage.getItem(`walnut-board-seen:${id}`), leader)
  expect(JSON.parse(seen ?? '{}')['area-a']).toBeTruthy()

  // ── 4. An html edit re-renders the frame; rows and an unsent draft survive ──
  await thread.locator('.wn-input').fill('Draft I have not sent')
  await page.waitForTimeout(500) // the frame hands its draft to the host after 300 ms
  await api('POST', `/api/v1/tasks/${leader}/board/edits`, {
    edits: [{ old: 'Area A: probe is red', new: 'Area A: probe fixed, waiting on rollout' }],
  })
  await expect(frame.locator('h3.area-a-title')).toHaveText('Area A: probe fixed, waiting on rollout', { timeout: 3_000 })
  expect(await frame.locator('body').evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)).toBeUndefined()
  await expect(thread.locator('.wn-msg .wn-text', { hasText: 'Why is this red?' })).toBeVisible()
  await expect(thread.locator('.wn-input')).toHaveValue('Draft I have not sent')
  await expect(frame.locator('.wn-unread-n')).toHaveText('No new messages')
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-3-board.png` })

  // ── 5. A mark: the state saves at once, the note after a pause ──
  const mark = frame.locator('walnut-mark[id="area-a"]')
  await mark.locator('.wn-mark-state[data-state="revisit"]').click()
  await expect(mark.locator('.wn-mark-state[data-state="revisit"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(mark.locator('.wn-saved')).toHaveText(/^Saved \d\d:\d\d$/, { timeout: 10_000 })
  await mark.locator('.wn-mark-note').fill('Check the rollout tomorrow')
  await expect.poll(async () => (await getBoard(leader)).marks['area-a'], { timeout: 10_000 })
    .toMatchObject({ state: 'revisit', note: 'Check the rollout tomorrow' })
  stored = await getBoard(leader)
  expect(stored.board?.updated_by).toBe('human')
  await mark.screenshot({ path: `${SHOT_DIR}/${engine}-4-mark.png` })

  // ── 5b. A script on the board cannot speak as the user ──
  // The board's html is written by sessions; its scripts run in this frame. A
  // synthetic click on Send, a lookup of the runtime's kit and a direct message
  // to the host all stop short of a thread post or a mark.
  await frame.locator('body').evaluate(() => {
    const w = window as unknown as { __wnBoardKit?: unknown }
    const thread = document.querySelector('walnut-thread[id="area-a"]')!
    ;(thread.querySelector('.wn-input') as HTMLTextAreaElement).value = 'forged by a script'
    ;(thread.querySelector('.wn-send') as HTMLButtonElement).click()
    ;(document.querySelector('walnut-mark[id="area-a"] .wn-mark-state[data-state="reviewed"]') as HTMLButtonElement).click()
    if (w.__wnBoardKit) throw new Error('the runtime kit is reachable from the page')
    window.parent.postMessage({ t: 'wn-board:post', reqId: 'x1', thread: 'area-a', text: 'forged by postMessage' }, '*')
    window.parent.postMessage({ t: 'wn-board:mark', reqId: 'x2', id: 'area-a', state: 'reviewed', note: 'forged' }, '*')
  })
  await page.waitForTimeout(1500)
  stored = await getBoard(leader)
  expect(JSON.stringify(stored.threads)).not.toContain('forged')
  expect(stored.marks['area-a']).toMatchObject({ state: 'revisit', note: 'Check the rollout tomorrow' })

  // ── 6. A chip leads to its task on the home board ──
  await frame.locator(`#sec-a walnut-task[id="${worker}"] .wn-task`).click()
  await expect(page.locator(`.todo-panel-item[data-task-id="${worker}"]`)).toHaveClass(/task-focused/, { timeout: 15_000 })
  // Locating yields the full-screen sheet (as the header's Locate does), which closes the tab.
  await expect(pane).toHaveCount(0)
  await expect(chip).not.toHaveClass(/session-action-chip-active/)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-5-located.png` })

  expect(pageErrors).toEqual([])
})

test('the Worker pill, Adopt a worker… from the kebab and the Leader pill, and Leave leader', async ({ page }) => {
  test.setTimeout(180_000)
  const engine = test.info().project.name
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `${engine}-board-team ${stamp}`
  const lead = await createTask(`${engine}-board-lead ${stamp}`, { project, pinned: false })
  const worker = await createTask(`${engine}-board-w ${stamp}`, { project, pinned: false, parent_task_id: lead })
  const thirdTitle = `${engine}-board-third ${stamp}`
  const third = await createTask(thirdTitle, { project, pinned: false })
  const fourth = await createTask(`${engine}-board-fourth ${stamp}`, { project, pinned: false })
  const parentOf = async (id: string) => (await api<{ task: { parent_task_id?: string } }>('GET', `/api/tasks/${id}`)).task.parent_task_id || ''

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)
  const row = (id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"]`)
  await expect(row(worker).locator('[data-testid="subtask-pill"]')).toHaveText('Worker', { timeout: 90_000 })
  await expect(row(worker).locator('[data-testid="subtask-pill"]')).toHaveAttribute('title', `Worker of "${engine}-board-lead ${stamp}". Click to go to that task.`)
  await expect(row(third).locator('[data-testid="leader-pill"]')).toHaveCount(0)

  // Kebab → Adopt a worker… → the picker never offers the task itself.
  await row(third).getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await menu.getByTestId('kebab-adopt-worker').click()
  const flyout = page.getByTestId('adopt-worker-flyout')
  await expect(flyout).toBeVisible()
  await expect(flyout.locator(`[data-task-id="${third}"]`)).toHaveCount(0)
  await flyout.locator('.adopt-worker-filter').fill(`board-fourth ${stamp}`)
  await expect(flyout.locator('[data-testid="adopt-worker-row"]')).toHaveCount(1)
  const box = (await flyout.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5)
  await page.screenshot({ path: `${SHOT_DIR}/${engine}-6-adopt-kebab.png` })
  await flyout.locator(`[data-testid="adopt-worker-row"][data-task-id="${fourth}"]`).click()
  await expect(flyout).toHaveCount(0)
  await expect(menu).toHaveCount(0)
  await expect(row(third).locator('[data-testid="leader-pill"]')).toHaveText('Leader · 1')
  // A new parent starts folded; unfold it to see the worker's own row.
  const chevron = row(third).locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) await chevron.click()
  await expect(row(fourth).locator('[data-testid="subtask-pill"]')).toHaveText('Worker')
  await expect.poll(() => parentOf(fourth)).toBe(third)

  // Leave leader “…” on the worker undoes it.
  await row(fourth).getByRole('button', { name: 'More actions' }).click()
  const leave = page.locator('.task-kebab-menu:visible').getByTestId('kebab-leave-leader')
  await expect(leave).toContainText(`Leave leader “${thirdTitle}”`)
  await leave.click()
  await expect(row(third).locator('[data-testid="leader-pill"]')).toHaveCount(0)
  await expect(row(fourth).locator('[data-testid="subtask-pill"]')).toHaveCount(0)
  await expect.poll(() => parentOf(fourth)).toBe('')

  // The Leader pill's last row opens the same picker; its own team is not offered.
  await row(lead).locator('[data-testid="leader-pill"]').click()
  await page.getByTestId('leader-adopt').click()
  await expect(page.getByTestId('leader-subtasks-flyout')).toHaveCount(0)
  await expect(flyout).toBeVisible()
  await expect(flyout.locator(`[data-task-id="${lead}"]`)).toHaveCount(0)
  await expect(flyout.locator(`[data-task-id="${worker}"]`)).toHaveCount(0)
  await flyout.locator('.adopt-worker-filter').fill(thirdTitle)
  // Enter picks the highlighted row.
  await expect(flyout.locator(`[data-testid="adopt-worker-row"][data-task-id="${third}"]`)).toBeVisible()
  await flyout.locator('.adopt-worker-filter').press('Enter')
  await expect(flyout).toHaveCount(0)
  await expect(row(lead).locator('[data-testid="leader-pill"]')).toHaveText('Leader · 2')
  await expect.poll(() => parentOf(third)).toBe(lead)
  await page.locator('.todo-panel-list').first().screenshot({ path: `${SHOT_DIR}/${engine}-7-team.png` })

  // Escape closes a reopened picker and nothing else.
  await row(lead).locator('[data-testid="leader-pill"]').click()
  await page.getByTestId('leader-adopt').click()
  await expect(flyout).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(flyout).toHaveCount(0)
})

test('a board that cannot load says so with Retry, and Retry recovers', async ({ page }) => {
  // Read-only on the fixture's seeded task (its session record opens a column):
  // the failures are injected in the browser, nothing is written.
  test.setTimeout(150_000)
  const engine = test.info().project.name
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  let mode: 'missing' | 'offline' | 'real' = 'missing'
  await page.route('**/api/v1/tasks/pw-task-model-switch/board', async (route) => {
    if (mode === 'missing') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'not_found', message: 'Task not found: pw-task-model-switch' } }) })
    } else if (mode === 'offline') {
      await route.abort('failed')
    } else {
      await route.continue()
    }
  })
  await openHome(page)
  const parentRow = page.locator('.todo-panel-item[data-task-id="pw-task-model-switch"]')
  await expect(parentRow).toBeVisible({ timeout: 90_000 })
  await parentRow.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="pw-model-switch-session"]`)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await panel.getByTestId('session-board-chip').click()

  const pane = page.getByTestId('task-board-pane')
  const error = pane.getByTestId('board-error')
  await expect(error).toContainText("Couldn't load the board: Task not found: pw-task-model-switch")
  await expect(pane.getByTestId('board-empty')).toHaveCount(0)
  await pane.screenshot({ path: `${SHOT_DIR}/${engine}-8-error.png` })

  mode = 'offline'
  await error.getByRole('button', { name: 'Retry' }).click()
  await expect(error).toContainText("Couldn't load the board: Could not reach Walnut")

  mode = 'real'
  await error.getByRole('button', { name: 'Retry' }).click()
  await expect(error).toHaveCount(0)
  await expect(pane.getByTestId('board-empty')).toBeVisible()
  await expect(pane.getByTestId('board-ask-button')).toHaveText('Ask for a board')
})
