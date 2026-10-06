/**
 * The kanban card's widgets on the real density team (board-kanban-fixture.ts):
 *
 *   C24  Message from the card reaches the worker's session; a sessionless card says why it cannot.
 *   C34  Edit summary: `n/300`, Enter saves (a reload keeps it), empty goes back to the task's, a failure restores.
 *   C35  Edit waiting on from `Waiting on: add who`; the text is searchable.
 *   C58  Layout C: a Bash prompt answered in the card (Allow, and Deny on another).
 *   C59  An AskUserQuestion answered with the shared form; a failure says so and Retry sends it.
 *   C60  A nested worker's prompt on its parent: `From <title>`, the answer reaches the nested session.
 *   C75  Start worker starts the card's task in the leader's folder; Tell the leader reaches the leader.
 *   C91  An edit raced by the leader asks Keep mine / Use theirs; a lane deleted mid rename closes the editor with a toast.
 *
 * Both engines share one fixture server, so every run seeds its own team.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import {
  call, getSession, kanbanApi, pollUntil, seedKanbanTeam, startSession, ticketOf, type KanbanApi, type KanbanTeam,
} from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const BASE = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/kanban/shots'

let api: KanbanApi
let team: KanbanTeam
const litter: string[] = []

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async ({ browserName }, info) => {
  info.setTimeout(600_000)
  void browserName
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  await fs.mkdir(SHOTS, { recursive: true })
  team = await seedKanbanTeam(api, { engine: info.project.name, litter })
  await handBackOnBoard()
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${BASE}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${BASE}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/**
 * The fixture hands its card back before the leader has a board file, and the
 * board's watch records a hand back only for an owner with a board (spec 4.2).
 * A leader with a board is the case under test: make the file (a no-op card
 * write), then let the worker hand the task back again.
 */
async function handBackOnBoard(): Promise<void> {
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.waiting}`, { waiting_on: '' })
  await call(api, 'PATCH', `/api/tasks/${team.handedBack}`, { phase: 'IN_PROGRESS' })
  await call(api, 'PATCH', `/api/v1/tasks/${team.handedBack}`, { phase: 'NEED_ACTION' }, { 'x-walnut-caller-sid': team.handedBackSid })
  await call(api, 'PATCH', `/api/tasks/${team.handedBack}`, { unread: true })
  await pollUntil('hand back recorded', async () => (await call<{ cards: Record<string, { handed_back_at?: string }> }>(
    api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1&fields=kanban`)).cards[team.handedBack]?.handed_back_at ?? '', (v) => !!v)
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${BASE}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

/** Home, the leader's row, its session column, the Board tab: the kanban on screen. */
async function openBoard(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: team.project })
  await openHome(page)
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  await expect(pane.getByTestId('kanban-rollup')).toContainText('open', { timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const chip = (pane: Locator, id: string) => pane.getByTestId(`kanban-chip-${id}`)
const chipCount = async (c: Locator) => Number(await c.locator('.kanban-chip-count').textContent())
const laneHead = (pane: Locator, laneId: string) => pane.locator(`[data-testid="kanban-lane-head"][data-lane-id="${laneId}"]`)
interface CardsPayload { cards: Record<string, { lane?: string; summary?: string; summary_at?: string; waiting_on?: string }> }
const boardKanban = () => call<CardsPayload>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1&fields=kanban`)

async function historyText(sid: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/sessions/${sid}/history?tail=80`)
  if (!res.ok) return ''
  const body = (await res.json()) as { messages?: Array<{ text?: string }> }
  return (body.messages ?? []).map((m) => m.text ?? '').join('\n')
}

/** Open a card's kebab and pick one of its rows. */
async function cardMenu(page: Page, c: Locator, row: string): Promise<void> {
  await c.hover()
  await c.getByTestId('kanban-card-more').click()
  await page.getByTestId(row).click()
}

test('C24: Message from a card reaches its worker; a sessionless card cannot message', async ({ page }) => {
  const pane = await openBoard(page)
  const id = team.all[10]
  const sid = team.sessions[id]
  const c = card(pane, id)
  await expect(c.getByTestId('kanban-card-status')).toContainText('Turn ended')
  await c.hover()
  await c.getByTestId('kanban-card-message').click()
  const input = c.getByTestId('kanban-card-composer-input')
  await expect(input).toBeFocused()
  await input.fill('Check the p99 dashboard again')
  await input.press('Shift+Enter')
  await input.type('and report back')
  await input.press('Enter')
  await expect(c.getByTestId('kanban-card-composer')).toHaveCount(0, { timeout: 20_000 })
  await expect(c.getByTestId('kanban-card-foot')).toContainText('Sent')
  await expect.poll(() => historyText(sid), { timeout: 60_000 }).toContain('Check the p99 dashboard again')
  const waiting = card(pane, team.waiting)
  await waiting.hover()
  await expect(waiting.getByTestId('kanban-card-message')).toHaveAttribute('aria-disabled', 'true')
  await expect(waiting.getByTestId('kanban-card-message')).toHaveAttribute('title', 'No session yet. Use Start worker.')
})

test('C34: Edit summary counts, saves on Enter, survives a reload, clears back to the task summary, restores on failure', async ({ page }) => {
  const id = team.all[11]
  let pane = await openBoard(page)
  await cardMenu(page, card(pane, id), 'kanban-card-menu-summary')
  const box = card(pane, id).getByTestId('kanban-card-summary-input')
  await expect(box).toBeFocused()
  await expect(box).toHaveValue(team.summaries[id])
  await box.fill('Retry storm traced to the gateway; budget rolled back, watching p99.')
  await expect(card(pane, id).getByTestId('kanban-card-summary-count')).toHaveText('68/300')
  await box.press('Enter')
  await expect(card(pane, id).getByTestId('kanban-card-summary')).toHaveText('Retry storm traced to the gateway; budget rolled back, watching p99.')
  await expect.poll(async () => (await boardKanban()).cards[id]?.summary).toBe('Retry storm traced to the gateway; budget rolled back, watching p99.')
  pane = await openBoard(page)
  await expect(card(pane, id).getByTestId('kanban-card-summary')).toHaveText('Retry storm traced to the gateway; budget rolled back, watching p99.')
  // A failed save puts the old text back and says why.
  await page.route('**/board/cards/**', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disk full"}' }) : r.fallback()))
  await cardMenu(page, card(pane, id), 'kanban-card-menu-summary')
  await card(pane, id).getByTestId('kanban-card-summary-input').fill('This one will not land')
  await card(pane, id).getByTestId('kanban-card-summary-input').press('Enter')
  await expect(card(pane, id).getByTestId('kanban-editor-error')).toContainText("Couldn't save:")
  await expect(card(pane, id).getByTestId('kanban-card-summary-input')).toHaveValue('Retry storm traced to the gateway; budget rolled back, watching p99.')
  await card(pane, id).getByTestId('kanban-card-summary-input').press('Escape')
  await page.unroute('**/board/cards/**')
  // Empty saves clear the card's own: the task's summary shows again.
  await cardMenu(page, card(pane, id), 'kanban-card-menu-summary')
  await card(pane, id).getByTestId('kanban-card-summary-input').fill('')
  await expect(card(pane, id).getByTestId('kanban-card-summary-count')).toHaveText('0/300')
  await card(pane, id).getByTestId('kanban-card-summary-input').press('Enter')
  await expect(card(pane, id).getByTestId('kanban-card-summary')).toHaveText(team.summaries[id], { timeout: 15_000 })
})

test('C35: Edit waiting on from `Waiting on: add who`, and the search finds it', async ({ page }) => {
  const id = team.all[12]
  const pane = await openBoard(page)
  await cardMenu(page, card(pane, id), 'kanban-card-menu-move')
  await page.locator('[data-testid="kanban-card-move-lane"][data-lane-id="waiting-cr"]').click()
  const c = card(pane, id)
  await expect(c).toHaveAttribute('data-lane', 'waiting-cr', { timeout: 15_000 })
  await expect(c.getByTestId('kanban-card-waiting')).toHaveText('Waiting on: add who')
  await c.getByTestId('kanban-card-waiting').click()
  const input = c.getByTestId('kanban-card-waiting-input')
  await expect(input).toHaveAttribute('placeholder', 'A CR, a team, a person')
  await expect(input).toHaveAttribute('maxlength', '80')
  await input.fill('CR-48213')
  await input.press('Enter')
  await expect(c.getByTestId('kanban-card-waiting')).toHaveText('Waiting on CR-48213')
  await expect.poll(async () => (await boardKanban()).cards[id]?.waiting_on).toBe('CR-48213')
  await pane.getByTestId('kanban-search').fill('cr-48213')
  await expect(pane.locator('[data-testid="kanban-card"]:visible')).toHaveCount(1)
  await expect(c).toBeVisible()
  await pane.getByTestId('kanban-search').fill('')
})

test('C59: an AskUserQuestion answers through the shared form; a failure says so and Retry sends it', async ({ page }) => {
  const pane = await openBoard(page)
  const c = card(pane, team.question)
  await expect(c.getByTestId('kanban-card-status')).toHaveText('Needs you: question')
  await c.getByTestId('kanban-card-prompt-toggle').click()
  const body = c.getByTestId('kanban-card-prompt-body')
  await expect(body.locator('.nfc-answer')).toBeVisible()
  await expect(body).toContainText('Which validation target?')
  await page.route('**/api/sessions/*/permission', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }))
  await body.locator('.nfc-answer-opt', { hasText: 'Staging' }).click()
  await body.getByRole('button', { name: 'Submit' }).click()
  await expect(body.getByTestId('kanban-prompt-error')).toContainText("Couldn't answer:")
  await page.unroute('**/api/sessions/*/permission')
  await body.getByTestId('kanban-prompt-retry').click()
  await expect.poll(() => historyText(team.questionSid), { timeout: 60_000 }).toContain('AskUserQuestion decision received: Staging')
  await expect(c.getByTestId('kanban-card-status')).not.toHaveAttribute('data-tone', 'red', { timeout: 30_000 })
})

test('C60: a nested worker prompt on its parent names the worker and answers the nested session', async ({ page }) => {
  const pane = await openBoard(page)
  const parent = card(pane, team.all[9])
  await expect(parent.getByTestId('kanban-card-status')).toHaveText('Needs you: worker below')
  await parent.getByTestId('kanban-card-prompt-toggle').click()
  const body = parent.getByTestId('kanban-card-prompt-body')
  await expect(body.getByTestId('kanban-prompt-from')).toHaveText(`From ${team.titles[team.nested]}`)
  await expect(body).toHaveAttribute('data-session-id', team.nestedSid)
  await body.getByTestId('kanban-prompt-allow').click()
  await expect.poll(() => historyText(team.nestedSid), { timeout: 60_000 }).toContain('Bash decision received: allow')
  await expect(parent.getByTestId('kanban-card-status')).not.toHaveAttribute('data-tone', 'red', { timeout: 30_000 })
})

test.describe('layout C, a 520px window', () => {
  test.use({ viewport: { width: 520, height: 800 } })

  test('C58: a Bash prompt answered in the card: Allow, and Deny on another', async ({ page }, info) => {
    // A second Bash prompt for the Deny path, on an idle card.
    const denyCard = team.all[8]
    const denySid = await startSession(api, denyCard, 'status-permission-test:Bash', 'default')
    await pollUntil('second prompt', async () => (await getSession(api, denySid)).pendingPermission?.toolName ?? '', (t) => t === 'Bash')
    const pane = await openBoard(page)
    await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
    const needs = chip(pane, 'needs')
    await needs.click()
    const before = await chipCount(needs)
    const c = card(pane, team.perm)
    await expect(c.getByTestId('kanban-card-status')).toHaveText('Needs you: approve Bash')
    await expect(c.getByTestId('kanban-card-status')).toHaveAttribute('title', /^Bash: /)
    await c.getByTestId('kanban-card-prompt-toggle').click()
    await expect(c.getByTestId('kanban-card-prompt-toggle')).toHaveAttribute('aria-expanded', 'true')
    const cmd = c.getByTestId('permission-detail-command')
    await expect(cmd).toHaveText('pwd')
    await expect(cmd).toHaveAttribute('title', 'pwd')
    expect(await cmd.evaluate((e) => getComputedStyle(e).webkitLineClamp)).toBe('2')
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-narrow-prompt.png` })
    await c.getByTestId('kanban-prompt-allow').click()
    await expect.poll(() => historyText(team.permSid), { timeout: 60_000 }).toContain('Bash decision received: allow')
    await expect(c.getByTestId('kanban-card-status')).not.toHaveAttribute('data-tone', 'red', { timeout: 30_000 })
    await expect.poll(() => chipCount(needs), { timeout: 30_000 }).toBe(before - 1)
    const d = card(pane, denyCard)
    await d.getByTestId('kanban-card-prompt-toggle').click()
    await d.getByTestId('kanban-prompt-deny').click()
    await expect.poll(() => historyText(denySid), { timeout: 60_000 }).toContain('Bash decision received: deny')
    await expect.poll(() => chipCount(needs), { timeout: 30_000 }).toBe(before - 2)
  })
})

test('C75: Start worker runs the card in the leader folder; Tell the leader reaches the leader', async ({ page }) => {
  const add = async (title: string) => {
    const res = await call<{ task: { id: string } }>(api, 'POST', `/api/v1/tasks/${team.leader}/board/cards`, { title, lane: 'new' })
    litter.push(res.task.id)
    return res.task.id
  }
  const startId = await add(`${ticketOf(140)} checkout latency start`)
  const tellId = await add(`${ticketOf(141)} refund backlog tell`)
  const pane = await openBoard(page)
  const s = card(pane, startId)
  await expect(s.getByTestId('kanban-card-status')).toHaveText('No session')
  await s.getByTestId('kanban-card-start').click()
  const sid = await pollUntil('worker session', async () => ((await call<{ task: { session_id?: string } }>(api, 'GET', `/api/tasks/${startId}`)).task.session_id ?? ''), (v) => !!v)
  await expect.poll(() => historyText(sid), { timeout: 60_000 }).toContain(`Work on this task: ${ticketOf(140)} checkout latency start`)
  const lead = await call<{ session: { cwd?: string; host?: string } }>(api, 'GET', `/api/sessions/${team.leaderSid}`)
  const worker = await call<{ session: { cwd?: string; host?: string } }>(api, 'GET', `/api/sessions/${sid}`)
  expect(worker.session.cwd).toBe(lead.session.cwd)
  expect(worker.session.host ?? '').toBe(lead.session.host ?? '')
  await expect(s.getByTestId('kanban-card-status')).not.toHaveText('No session', { timeout: 30_000 })
  await expect(s.getByTestId('kanban-card-start')).toHaveCount(0)

  const t = card(pane, tellId)
  await t.getByTestId('kanban-card-tell-leader').click()
  await expect.poll(() => historyText(team.leaderSid), { timeout: 60_000 })
    .toContain(`New ticket card ${tellId} "${ticketOf(141)} refund backlog tell" in New. Pick it up or start a worker.`)

  // A leader with no session: Tell the leader is aria-disabled and says why (seen from a worker's Board).
  const { task: lone } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
    title: `${team.engine} lone leader ${team.stamp}`, source: 'local', pinned: false, project: team.project,
  })
  litter.push(lone.id)
  const kids: string[] = []
  for (const k of [0, 1]) {
    const { task } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
      title: `${ticketOf(150 + k)} lone card`, source: 'local', pinned: false, project: team.project, parent_task_id: lone.id,
    })
    litter.push(task.id)
    kids.push(task.id)
  }
  const kidSid = await startSession(api, kids[0], 'snapshot-clean-turn:lone worker ready')
  await openHome(page)
  const row = page.locator(`.todo-panel-item[data-task-id="${kids[0]}"]`)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${kidSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const other = panel.getByTestId('task-board-pane')
  const tell = card(other, kids[1]).getByTestId('kanban-card-tell-leader')
  await expect(tell).toHaveAttribute('aria-disabled', 'true', { timeout: 30_000 })
  await expect(tell).toHaveAttribute('title', 'The leader has no session')
})

test('C91: an edit the leader raced asks Keep mine or Use theirs; a lane deleted mid rename closes it with a toast', async ({ page }) => {
  const id = team.all[10]
  const leaderWrite = (summary: string) => call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { summary }, { 'x-walnut-caller-sid': team.leaderSid })
  const pane = await openBoard(page)
  await cardMenu(page, card(pane, id), 'kanban-card-menu-summary')
  const box = card(pane, id).getByTestId('kanban-card-summary-input')
  await box.fill('My own words on the ticket')
  await leaderWrite('The leader rewrote this while you typed')
  await page.waitForTimeout(1_500)
  await expect(box).toHaveValue('My own words on the ticket')
  await box.press('Enter')
  const conflict = card(pane, id).getByTestId('kanban-editor-conflict')
  await expect(conflict).toContainText('The leader changed this while you were editing.')
  await conflict.getByTestId('kanban-editor-keep-mine').click()
  await expect.poll(async () => (await boardKanban()).cards[id]?.summary).toBe('My own words on the ticket')
  await expect(card(pane, id).getByTestId('kanban-card-summary')).toHaveText('My own words on the ticket')
  // Use theirs drops the draft and shows the leader's.
  await cardMenu(page, card(pane, id), 'kanban-card-menu-summary')
  await card(pane, id).getByTestId('kanban-card-summary-input').fill('A draft to drop')
  await leaderWrite('The leader has the final word')
  await page.waitForTimeout(1_500)
  await card(pane, id).getByTestId('kanban-card-summary-input').press('Enter')
  await card(pane, id).getByTestId('kanban-editor-use-theirs').click()
  await expect(card(pane, id).getByTestId('kanban-card-summary')).toHaveText('The leader has the final word')
  expect((await boardKanban()).cards[id]?.summary).toBe('The leader has the final word')
  // A lane deleted (another window) while its rename is open: the editor closes and a toast says so.
  const lanes = (await call<{ lanes_effective: Array<{ id: string; name: string; kind: string }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1&fields=kanban`)).lanes_effective
  await laneHead(pane, 'mitigating').getByTestId('kanban-lane-name').dblclick()
  await expect(laneHead(pane, 'mitigating').getByTestId('kanban-lane-rename-input')).toBeFocused()
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/lanes`, { lanes: lanes.filter((l) => l.id !== 'mitigating') })
  await expect(laneHead(pane, 'mitigating')).toHaveCount(0, { timeout: 15_000 })
  await expect(pane.getByTestId('kanban-toast').filter({ hasText: '"Mitigating" was deleted while you were renaming it.' })).toBeVisible()
})
