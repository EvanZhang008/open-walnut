/**
 * Kanban cards in use (board-kanban-fixture.ts team): the leader's writes
 * arriving live with who and when, Add task with its tags and its failure,
 * the hover action bar, Open session and the peek, a turn end that leaves the
 * card where it is, the leader's suggestion after a 409, the newer summary
 * wins (C10 C17 C23 C25 C40 C56 C69 C70 C74). Chromium and WebKit, real clicks.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import {
  call, getTask, kanbanApi, pollUntil, seedKanbanTeam, startSession, type KanbanApi, type KanbanTeam,
} from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine: info.project.name, litter })
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Real navigation by link click (never page.goto), then the leader's Board tab. */
async function openBoard(page: Page, leader = team.leader, sid = team.leaderSid, project = team.project): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project })
  await page.route('https://tickets.example.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>ticket</p>' }))
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
  const row = page.locator(`.todo-panel-item[data-task-id="${leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  // The task summaries arrive in one read after the cards: wait so nothing grows under a measure.
  if (leader === team.leader) await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)

/** Pointer and focus away from the lanes, so nothing holds the layout (G9). */
async function letGo(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

const leaderHeaders = () => ({ 'x-walnut-caller-sid': team.leaderSid })
const clock = /\d{1,2}:\d{2}/

test('C10: the leader moves a card and rewrites its summary; the open pane follows with who and when', async ({ page }) => {
  test.setTimeout(240_000)
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/kanban-seen`, { cards: 'all' })
  const pane = await openBoard(page)
  const id = team.idle[4]
  await expect(card(pane, id)).toHaveAttribute('data-lane', 'investigating')
  await letGo(page)
  const navs: string[] = []
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()) })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: 'mitigating', summary: 'Mitigation in place: retry budget halved, p99 back under 300ms; watching for an hour.' }, leaderHeaders())
  await expect(card(pane, id)).toHaveAttribute('data-lane', 'mitigating', { timeout: 15_000 })
  await expect(card(pane, id).getByTestId('kanban-card-summary')).toHaveText(/^Mitigation in place/)
  const changed = card(pane, id).getByTestId('kanban-card-changed')
  await expect(changed).toHaveText(new RegExp(`^Moved by the leader ${clock.source}`))
  await expect(changed).toHaveAttribute('title', new RegExp(`^Moved from Investigating by the leader · ${clock.source}`))
  await expect(card(pane, id)).toHaveAttribute('data-changed', 'true')
  expect(navs).toEqual([])
})

test('C17 C74: Add task parses tags, lands at the bottom of its lane, a subtask of the owner, no session', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const body = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="investigating"]')
  await body.getByTestId('kanban-add-task').click()
  const input = body.getByTestId('kanban-add-task-input')
  await input.fill('V1000000140 ticket:V1000000140 sev:2 checkout latency')
  await expect(body.getByTestId('kanban-add-task-tags').locator('.tag-chip, [data-tag]')).toHaveCount(2)
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && /\/board\/cards$/.test(new URL(r.url()).pathname))
  await input.press('Enter')
  await expect(body.getByTestId('kanban-card-pending')).toHaveText(/Adding\.\.\./)
  await expect(input).toBeFocused()
  const res = await created
  expect(res.status()).toBe(201)
  const { task } = (await res.json()) as { task: { id: string } }
  litter.push(task.id)
  const c = card(pane, task.id)
  await expect(c).toHaveAttribute('data-lane', 'investigating', { timeout: 15_000 })
  await expect(body.getByTestId('kanban-card-pending')).toHaveCount(0)
  await expect(c.getByTestId('kanban-card-ticket')).toContainText('V1000000140')
  await expect(c.getByTestId('kanban-card-sev')).toHaveText('Sev 2')
  await expect(c.getByTestId('kanban-card-status')).toHaveText(/No session/)
  const last = await body.locator('[data-testid="kanban-card"]').last().getAttribute('data-task-id')
  expect(last).toBe(task.id)
  const t = await getTask(api, task.id)
  expect(t?.title).toBe('V1000000140 checkout latency')
  expect(t?.tags).toEqual(expect.arrayContaining(['ticket:V1000000140', 'sev:2']))
  expect(t?.parent_task_id).toBe(team.leader)
  const full = await call<{ task: { project?: string; session_ids?: string[]; session_id?: string } }>(api, 'GET', `/api/tasks/${task.id}`)
  expect(full.task.project).toBe(team.project)
  expect(full.task.session_id ?? '').toBe('')

  // C74: the chips are live, × drops one, the task takes only the rest.
  await input.fill('ticket:V1000000141 sev:2 refund retry')
  const chips = body.getByTestId('kanban-add-task-tags')
  await expect(chips).toContainText('V1000000141')
  await chips.locator('button').last().click()
  await expect(chips.locator('button')).toHaveCount(1)
  const created2 = page.waitForResponse((r) => r.request().method() === 'POST' && /\/board\/cards$/.test(new URL(r.url()).pathname))
  await input.press('Enter')
  const { task: t2 } = (await (await created2).json()) as { task: { id: string } }
  litter.push(t2.id)
  const t2v = await getTask(api, t2.id)
  expect(t2v?.tags).toEqual(['ticket:V1000000141'])
  expect(t2v?.title).toBe('refund retry')

  // Reload: still in Investigating.
  const pane2 = await openBoard(await page.context().newPage())
  await expect(card(pane2, task.id)).toHaveAttribute('data-lane', 'investigating')
})

test('C40: a failed add gives the title back with the reason; no card stays', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  await page.route('**/board/cards', (r) => (r.request().method() === 'POST'
    ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Disk is full' } }) })
    : r.continue()))
  const body = pane.locator('[data-testid="kanban-lane-body"][data-lane-id="new"]')
  await body.getByTestId('kanban-add-task').click()
  const input = body.getByTestId('kanban-add-task-input')
  await input.fill('V1000000150 payout check')
  await input.press('Enter')
  await expect(body.getByTestId('kanban-add-task-error')).toHaveText("Couldn't add: Disk is full")
  await expect(input).toHaveValue('V1000000150 payout check')
  await expect(body.getByTestId('kanban-card-pending')).toHaveCount(0)
})

const boxOf = (l: Locator) => l.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const apart = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y

test('C23: the action bar shows in the foot on hover and on focus, never moving the card or covering the title', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const c = card(pane, team.idle[5])
  await letGo(page)
  const before = await boxOf(c)
  const bar = c.getByTestId('kanban-card-actions')
  await expect(bar).toBeHidden()
  await c.getByTestId('kanban-card-title').hover()
  await expect(bar).toBeVisible()
  for (const t of ['kanban-card-open', 'kanban-card-message', 'kanban-card-complete', 'kanban-card-more']) await expect(bar.getByTestId(t)).toBeVisible()
  const after = await boxOf(c)
  expect(after.h).toBe(before.h)
  expect(apart(await boxOf(c.getByTestId('kanban-card-title')), await boxOf(bar))).toBe(true)
  const foot = await boxOf(c.getByTestId('kanban-card-foot'))
  const b = await boxOf(bar)
  expect(b.y).toBeGreaterThanOrEqual(foot.y - 1)
  expect(b.y + b.h).toBeLessThanOrEqual(foot.y + foot.h + 1)
  await letGo(page)
  await expect(bar).toBeHidden()
  await c.focus()
  await expect(bar).toBeVisible()
})

test('C25: Open session opens its column on Home; a click on the card opens the task beside the board', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const id = team.idle[6]
  await card(pane, id).getByTestId('kanban-card-foot').click({ position: { x: 4, y: 12 } })
  await expect(page.getByTestId('board-task-peek')).toBeVisible({ timeout: 15_000 })
  await card(pane, id).hover()
  await card(pane, id).getByTestId('kanban-card-open').click()
  await expect(page.locator(`${REAL_PANEL}[data-session-id="${team.sessions[id]}"]`)).toBeVisible({ timeout: 30_000 })
})

test('C56: a turn that ends leaves the card where it was; the sticky auto lane is recorded', async ({ page }) => {
  test.setTimeout(240_000)
  const { task } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
    title: 'V1000000160 short probe', source: 'local', pinned: false, project: team.project, parent_task_id: team.leader,
  })
  litter.push(task.id)
  const sid = await startSession(api, task.id, 'slow:12000 V1000000160 short probe')
  await pollUntil('running', () => call<{ session?: { process_status?: string } }>(api, 'GET', `/api/sessions/${sid}`), (v) => v.session?.process_status === 'running', 60_000)
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/kanban-seen`, { cards: 'all' })
  const pane = await openBoard(page)
  const c = card(pane, task.id)
  await expect(c).toHaveAttribute('data-lane', 'investigating')
  await expect(c.getByTestId('kanban-card-status')).toHaveText(/^Running/)
  await letGo(page)
  const before = await boxOf(c)
  await pollUntil('turn end', async () => (await getTask(api, task.id))?.phase ?? '', (p) => p === 'NEED_ACTION', 90_000)
  await expect(c.getByTestId('kanban-card-status')).toHaveText(/^Turn ended/, { timeout: 15_000 })
  await expect(c).toHaveAttribute('data-lane', 'investigating')
  const after = await boxOf(c)
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
  // Round 3 C61: a turn end alone may leave no change label at all (the unread dot says it); never a Moved one.
  await expect(c.getByTestId('kanban-card-changed').filter({ hasText: /^Moved/ })).toHaveCount(0)
  const b = await call<{ cards: Record<string, { lane_auto?: { lane: string } }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)
  expect(b.cards[task.id]?.lane_auto?.lane).toBe('investigating')
})

test('C69: a refused leader move becomes a suggestion; Accept moves it, Dismiss only clears it', async ({ page }) => {
  test.setTimeout(240_000)
  const [a, d] = [team.idle[0], team.idle[7] ?? team.idle[1]]
  for (const id of [a, d]) await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: 'waiting-others' })
  for (const id of [a, d]) {
    const res = await fetch(`${api.base}/api/v1/tasks/${team.leader}/board/cards/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...leaderHeaders() }, body: JSON.stringify({ lane: 'mitigating' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('status_set_by_user')
  }
  const pane = await openBoard(page)
  const sug = card(pane, a).getByTestId('kanban-card-suggested')
  await expect(sug).toContainText('Leader suggests Mitigating')
  await expect(card(pane, a)).toHaveAttribute('data-changed', 'true')
  await sug.getByTestId('kanban-card-suggest-accept').click()
  await letGo(page)
  await expect(card(pane, a)).toHaveAttribute('data-lane', 'mitigating', { timeout: 15_000 })
  await expect(card(pane, a).getByTestId('kanban-card-suggested')).toHaveCount(0)
  const b = await call<{ cards: Record<string, { lane?: string; lane_by?: string; lane_suggested?: unknown }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)
  expect(b.cards[a]).toMatchObject({ lane: 'mitigating', lane_by: 'human' })
  expect(b.cards[a].lane_suggested).toBeUndefined()
  await card(pane, d).getByTestId('kanban-card-suggest-dismiss').click()
  await expect(card(pane, d).getByTestId('kanban-card-suggested')).toHaveCount(0)
  await expect(card(pane, d)).toHaveAttribute('data-lane', 'waiting-others')
  const s = await fetch(`${api.base}/api/v1/tasks/${team.leader}/board/cards/${d}/suggestion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...leaderHeaders() }, body: JSON.stringify({ action: 'dismiss' }),
  })
  expect(s.status).toBe(403)
})

test('C70: the newer summary shows, the tooltip says whose', async ({ page }) => {
  test.setTimeout(180_000)
  const id = team.idle[2]
  const pane = await openBoard(page)
  const sum = card(pane, id).getByTestId('kanban-card-summary')
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { summary: 'Leader view: waiting on the ledger team to confirm the fix.' }, leaderHeaders())
  await expect(sum).toHaveText(/^Leader view/, { timeout: 15_000 })
  await expect(sum).toHaveAttribute('title', new RegExp(`From the leader, ${clock.source}`))
  await new Promise((r) => setTimeout(r, 1100))
  await call(api, 'PUT', `/api/tasks/${id}/summary`, { content: 'Worker view: the fix is deployed and the error rate is flat for twenty minutes now.' })
  await expect(sum).toHaveText(/^Worker view/, { timeout: 15_000 })
  await expect(sum).toHaveAttribute('title', new RegExp(`From the worker, ${clock.source}`))
  await new Promise((r) => setTimeout(r, 1100))
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { summary: 'Leader view again: closing after one more hour of clean metrics.' }, leaderHeaders())
  await expect(sum).toHaveText(/^Leader view again/, { timeout: 15_000 })
  await expect(sum).toHaveAttribute('title', new RegExp(`From the leader, ${clock.source}`))
})
