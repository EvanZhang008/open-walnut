/**
 * The kanban's board level controls on the real density team (spec 12,
 * board-kanban-fixture.ts: a leader with 37 direct subtasks, 14 open across
 * every live state, 23 COMPLETE):
 *
 *   C31 C93  the rollup (`14 open · 23 done`, the progress bar) and the workers
 *            line add up to the open cards; its parts set the chips.
 *   C53      the lane strip names every lane in one line; a click brings the lane in.
 *   C32      the search: a ticket, a summary word, Escape, with a chip.
 *   C48      `/` focuses the search, `M` on a focused card opens its composer.
 *   C80      the Sev 1 chip (after Needs you) and the sev order in a lane.
 *   C14 C71  Needs you counts what only the user can do, once, the same number
 *            the Page view's Cards segment carries; an injected error joins it.
 *   C33 C72  filtered lane counts, grey chips, frozen membership (Handled) and
 *            the `Nothing needs you now` line.
 *   C39      the leader's own prompt: the rollup button, the count, the leader row.
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
const visibleCards = (pane: Locator) => pane.locator('[data-testid="kanban-card"]:visible')
const chip = (pane: Locator, id: string) => pane.getByTestId(`kanban-chip-${id}`)
const chipCount = async (c: Locator) => Number(await c.locator('.kanban-chip-count').textContent())
const laneHead = (pane: Locator, laneId: string) => pane.locator(`[data-testid="kanban-lane-head"][data-lane-id="${laneId}"]`)

async function shot(page: Page, name: string, info: { project: { name: string } }): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` })
}

test('C31 C93: the rollup and the workers add up to the team, and their parts set the chips', async ({ page }, info) => {
  const pane = await openBoard(page)
  const rollup = pane.getByTestId('kanban-rollup')
  await expect(rollup).toHaveText('14 open · 23 done')
  const progress = pane.getByTestId('kanban-progress')
  await expect(progress).toHaveAttribute('aria-valuenow', '62')
  await expect(progress).toHaveAttribute('title', '62% done')
  const workers = pane.getByTestId('kanban-workers')
  await expect(workers).toContainText('3 running · 2 waiting on your answer · 8 idle · 1 no session')
  // Every lane's count, summed, is the whole team (the done lane, a rail in wide mode, counts its folded cards too).
  const counts = await pane.getByTestId('kanban-lane-count').allTextContents()
  const rail = await pane.getByTestId('kanban-done-rail').allTextContents()
  const railCount = rail.reduce((a, t) => a + Number.parseInt(t.match(/(\d+)/)?.[1] ?? '0', 10), 0)
  expect(railCount).toBe(23)
  expect(counts.map((t) => Number.parseInt(t, 10)).reduce((a, b) => a + b, 0) + railCount).toBe(37)
  // G33: the running part is the Running chip's number and sets it; waiting on you sets Needs you.
  expect(await chipCount(chip(pane, 'running'))).toBe(3)
  await pane.getByTestId('kanban-workers-running').click()
  await expect(chip(pane, 'running')).toHaveAttribute('aria-pressed', 'true')
  await expect(visibleCards(pane)).toHaveCount(3)
  await pane.getByTestId('kanban-workers-waiting').click()
  await expect(chip(pane, 'needs')).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(pane, 'running')).toHaveAttribute('aria-pressed', 'false')
  await pane.getByTestId('kanban-workers-waiting').click()
  await expect(chip(pane, 'needs')).toHaveAttribute('aria-pressed', 'false')
  // The shot shows the cards as the user reads them: summaries in (the task store fills them a moment after the list).
  await expect(card(pane, team.all[0]).getByTestId('kanban-card-summary')).toBeVisible({ timeout: 15_000 })
  await shot(page, 'wide-light', info)
  await page.emulateMedia({ colorScheme: 'dark' })
  // Let the lane background transitions settle before the shot.
  await page.waitForTimeout(400)
  await shot(page, 'wide-dark', info)
  await page.emulateMedia({ colorScheme: 'light' })
})

test('C53: the lane strip names every lane in one line and a click brings the lane into view', async ({ page }) => {
  const pane = await openBoard(page)
  const strip = pane.getByTestId('kanban-lane-strip')
  await expect(strip).toBeVisible()
  const box = await strip.boundingBox()
  expect(box!.height).toBeLessThanOrEqual(26)
  const items = strip.getByTestId('kanban-lane-strip-item')
  await expect(items).toHaveCount(6)
  for (let i = 0; i < 6; i++) {
    const item = items.nth(i)
    const laneId = (await item.getAttribute('data-lane-id'))!
    const head = laneHead(pane, laneId)
    if (laneId === 'resolved' && !(await head.count())) {
      // Wide mode: the done lane is a 56px rail, `Resolved 23`.
      await expect(pane.locator('[data-testid="kanban-done-rail"][data-lane-id="resolved"]')).toContainText('Resolved 23')
      await expect(item).toHaveText('Resolved 23')
      continue
    }
    const name = (await head.getByTestId('kanban-lane-name').textContent())!.trim()
    const total = Number.parseInt((await head.getByTestId('kanban-lane-count').textContent())!, 10)
    await expect(item).toContainText(`${name} ${total}`)
    const needs = head.getByTestId('kanban-lane-needs')
    if (await needs.count()) await expect(item.locator('.kanban-lane-strip-needs')).toHaveText(`(${await needs.textContent()})`)
    else await expect(item.locator('.kanban-lane-strip-needs')).toHaveCount(0)
  }
  await expect(strip.locator('[data-testid="kanban-lane-strip-item"][data-lane-id="investigating"] .kanban-lane-strip-needs')).toHaveText(/^\(\d+\)$/)
  // Resolved sits past the right edge of a 1280 window: one click brings it (or its rail) in.
  await strip.locator('[data-testid="kanban-lane-strip-item"][data-lane-id="resolved"]').click()
  const target = pane.locator('[data-testid="kanban-lane"][data-lane-id="resolved"], [data-testid="kanban-done-rail"][data-lane-id="resolved"]').first()
  await expect.poll(async () => {
    const r = await target.boundingBox()
    const p = await pane.boundingBox()
    return !!r && !!p && r.x >= p.x - 1 && r.x + Math.min(r.width, 56) <= p.x + p.width + 1
  }, { timeout: 5_000 }).toBe(true)
})

test('C48: `/` focuses the search from the page, and M on a focused card opens its composer', async ({ page }) => {
  const pane = await openBoard(page)
  await pane.getByTestId('kanban-rollup').click()
  await page.keyboard.press('/')
  await expect(pane.getByTestId('kanban-search')).toBeFocused()
  await expect(pane.getByTestId('kanban-search')).toHaveValue('')
  // In a text field `/` is just a character.
  await page.keyboard.type('/x')
  await expect(pane.getByTestId('kanban-search')).toHaveValue('/x')
  await pane.getByTestId('kanban-search').fill('')
  const target = card(pane, team.all[10])
  await target.focus()
  await page.keyboard.press('m')
  const composer = target.getByTestId('kanban-card-composer')
  await expect(composer).toBeVisible()
  await expect(composer.getByTestId('kanban-card-composer-input')).toBeFocused()
  await expect(composer.getByTestId('kanban-card-composer-input')).toHaveAttribute('placeholder', /^Message V\d+/)
  await page.keyboard.press('Escape')
  await expect(composer).toHaveCount(0)
})

test('C80: the Sev 1 chip follows Needs you, shows the open sev:1 cards, and sev orders a lane', async ({ page }) => {
  const pane = await openBoard(page)
  const ids = await pane.locator('.kanban-chips [data-chip]').evaluateAll((els) => els.map((e) => e.getAttribute('data-chip')))
  expect(ids).toEqual(['needs', 'sev1', 'stale', 'changed', 'running'])
  // Round 3 N14: the count is the same badge as every chip's.
  await expect(chip(pane, 'sev')).toHaveText('Sev 1 2')
  await expect(chip(pane, 'sev').getByTestId('kanban-chip-count')).toHaveText('2')
  await chip(pane, 'sev').click()
  await expect(visibleCards(pane)).toHaveCount(2)
  for (const id of team.sev1) await expect(card(pane, id)).toBeVisible()
  await chip(pane, 'sev').click()
  // In Investigating the red cards come first, sev:1 before sev:2 among them.
  const order = await pane.locator('[data-testid="kanban-lane"][data-lane-id="investigating"] [data-testid="kanban-card"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  const red = order.slice(0, 4)
  expect(red.slice(0, 2).sort()).toEqual([...team.sev1].sort())

  // A team with one sev value has no Sev chip.
  const { task: lead } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
    title: `${info().engine} one sev leader ${team.stamp}`, source: 'local', pinned: false, project: team.project,
  })
  litter.push(lead.id)
  for (const k of [0, 1]) {
    const { task } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', {
      title: `${ticketOf(200 + k)} one sev card`, source: 'local', pinned: false, project: team.project, parent_task_id: lead.id,
    })
    litter.push(task.id)
    await call(api, 'PATCH', `/api/tasks/${task.id}`, { set_tags: [`ticket:${ticketOf(200 + k)}`, 'sev:2'] })
  }
  const sid = await startSession(api, lead.id, 'snapshot-clean-turn:one sev leader ready')
  await openHome(page)
  const row = page.locator(`.todo-panel-item[data-task-id="${lead.id}"]`)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const other = panel.getByTestId('task-board-pane')
  await expect(other.getByTestId('kanban-chip-needs')).toBeVisible({ timeout: 30_000 })
  await expect(other.getByTestId('kanban-chip-sev')).toHaveCount(0)
})

/** The run's engine, for titles made inside a test. */
function info(): { engine: string } { return { engine: team.engine } }

const RED_TEXTS = ['Needs you: approve Bash', 'Needs you: question', 'Needs you: handed back', 'Needs you: worker below']
const ERROR_CARD = () => team.all[12]

test('C14 C71: Needs you counts only what the user must do, once, and the Page view says the same number', async ({ page }) => {
  const pane = await openBoard(page)
  const needs = chip(pane, 'needs')
  // Bash prompt, question, handed back, the nested worker's prompt on its parent; never the 8 turn ends.
  await expect.poll(() => chipCount(needs), { timeout: 30_000 }).toBe(4)
  await needs.click()
  await expect(visibleCards(pane)).toHaveCount(4)
  const statuses = await visibleCards(pane).getByTestId('kanban-card-status').allTextContents()
  expect(statuses.map((s) => s.trim()).sort()).toEqual([...RED_TEXTS].sort())
  for (const tone of await visibleCards(pane).getByTestId('kanban-card-status').evaluateAll((els) => els.map((e) => e.getAttribute('data-tone')))) {
    expect(tone).toBe('red')
  }
  for (const id of team.idle.filter((x) => x !== team.handedBack && x !== team.all[9])) await expect(card(pane, id)).toBeHidden()
  await needs.click()

  // A page exists: the Page view's Cards segment carries the same number.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board`, { html: '<h1>Triage notes</h1><p>Read the cards.</p>' })
  const pageSeg = pane.getByTestId('board-view-custom')
  await expect(pageSeg).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  await expect(pageSeg).toHaveText('Page')
  await expect(pane.getByTestId('board-view-cards')).toHaveText('Cards')
  await pageSeg.click()
  await expect(pane.getByTestId('board-view-attention')).toHaveText('4')
  await expect(pane.getByTestId('board-view-cards')).toHaveAttribute('title', "The team's cards by lane: 4 need you")
  await pane.getByTestId('board-view-cards').click()

  // An error, injected on an idle card, joins the count (the spec's runtime error).
  await startSession(api, ERROR_CARD(), 'error')
  await expect(card(pane, ERROR_CARD()).getByTestId('kanban-card-status')).toContainText('Error:', { timeout: 60_000 })
  await expect.poll(() => chipCount(needs), { timeout: 15_000 }).toBe(5)
  await expect(pane.getByTestId('kanban-workers-error')).toHaveText('1 error')
})

test('C33 C72: a filter counts lanes, grey chips do nothing, handled cards stay until the chip changes', async ({ page }) => {
  const pane = await openBoard(page)
  // Nothing changed since the first look: Changed is grey, focusable, and its click does nothing.
  const changed = chip(pane, 'changed')
  await expect(changed).toHaveAttribute('aria-disabled', 'true')
  // aria-disabled keeps it focusable; Playwright counts it as disabled, so the click is forced.
  await changed.click({ force: true })
  await expect(changed).toHaveAttribute('aria-pressed', 'false')
  await changed.focus()
  await expect(changed).toBeFocused()

  const needs = chip(pane, 'needs')
  await needs.click()
  // R3-08: a lane with no cards at all says 0 under a filter, never `0 / 0`.
  for (const t of await pane.getByTestId('kanban-lane-count').allTextContents()) expect(t).toMatch(/^(\d+ \/ \d+|0)$/)
  await expect(laneHead(pane, 'investigating').getByTestId('kanban-lane-count')).toHaveText(new RegExp(`^${await chipCount(needs)} / 13$`))
  await expect(pane.locator('[data-testid="kanban-lane"][data-lane-id="mitigating"]')).toContainText('No matching cards')

  // Allow the Bash prompt in place: the card stays, at 50%, `Handled`.
  const perm = card(pane, team.perm)
  await perm.getByTestId('kanban-card-prompt-toggle').click()
  await perm.getByTestId('kanban-prompt-allow').click()
  await expect(perm).toHaveAttribute('data-handled', 'true', { timeout: 60_000 })
  await expect(perm.getByTestId('kanban-card-status')).toContainText('Handled')
  expect(Number(await perm.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.75)
  await expect.poll(() => chipCount(needs)).toBe(4)

  // The question, the nested worker below its parent, the hand back and the error: all handled.
  const question = card(pane, team.question)
  await question.getByTestId('kanban-card-prompt-toggle').click()
  await question.locator('.nfc-answer-opt', { hasText: 'Staging' }).click()
  await question.getByRole('button', { name: 'Submit' }).click()
  const parent = card(pane, team.all[9])
  await parent.getByTestId('kanban-card-prompt-toggle').click()
  await expect(parent.getByTestId('kanban-prompt-from')).toHaveText(`From ${team.titles[team.nested]}`)
  await parent.getByTestId('kanban-prompt-allow').click()
  await call(api, 'PATCH', `/api/tasks/${team.handedBack}`, { phase: 'IN_PROGRESS' })
  await startSession(api, ERROR_CARD(), 'snapshot-clean-turn:error card recovered')
  await expect.poll(() => chipCount(needs), { timeout: 90_000 }).toBe(0)
  await expect(pane.getByTestId('kanban-filter-empty')).toContainText('Nothing needs you now')
  await expect(visibleCards(pane)).toHaveCount(5)
  // An active grey chip still clears, and so does Show all cards.
  await expect(needs).toHaveClass(/is-zero/)
  await pane.getByTestId('kanban-show-all-cards').click()
  await expect(needs).toHaveAttribute('aria-pressed', 'false')
  await expect(pane.getByTestId('kanban-filter-empty')).toHaveCount(0)
  await expect(visibleCards(pane)).not.toHaveCount(5)
})

test('C39: the leader needing the user shows in the rollup, the count and its own row', async ({ page }) => {
  const pane = await openBoard(page)
  const before = await chipCount(chip(pane, 'needs'))
  const leadSid = await startSession(api, team.leader, 'status-permission-test:Bash', 'default')
  // The leader's panel now shows this session.
  team.leaderSid = leadSid
  await pollUntil('leader prompt', async () => (await getSession(api, leadSid)).pendingPermission?.toolName ?? '', (t) => t === 'Bash')
  const lead = pane.getByTestId('kanban-rollup-leader')
  await expect(lead).toHaveText('The leader needs you: approve Bash', { timeout: 30_000 })
  await expect.poll(() => chipCount(chip(pane, 'needs'))).toBe(before + 1)
  await chip(pane, 'needs').click()
  await expect(pane.getByTestId('kanban-leader-row')).toContainText('The leader: approve Bash')
  await pane.getByTestId('kanban-leader-row-toggle').click()
  await expect(pane.getByTestId('kanban-leader-row').getByTestId('kanban-prompt-allow')).toBeVisible()
  await pane.getByTestId('board-view-custom').click()
  await expect(pane.getByTestId('board-view-attention')).toHaveText(String(before + 1))
  await pane.getByTestId('board-view-cards').click()
  // The leader is this panel's own task: its button brings the leader's chat (the Chat tab) beside the board.
  await lead.click()
  await expect(page.locator('.session-panel-split.is-changed-open .session-panel-chat-col').first()).toBeVisible({ timeout: 15_000 })
  await expect(pane.getByTestId('board-kanban')).toBeVisible()
  // Allow from the leader row: the leader stops needing the user.
  const row = pane.getByTestId('kanban-leader-row')
  if (!(await row.isVisible())) await chip(pane, 'needs').click()
  if (!(await row.getByTestId('kanban-prompt-allow').isVisible())) await row.getByTestId('kanban-leader-row-toggle').click()
  await row.getByTestId('kanban-prompt-allow').click()
  await expect(lead).toHaveCount(0, { timeout: 60_000 })
  await expect.poll(() => chipCount(chip(pane, 'needs')), { timeout: 30_000 }).toBe(before)
})

test('C32: the search finds a ticket and a summary word, Escape empties it, and it intersects the chip', async ({ page }) => {
  const pane = await openBoard(page)
  const search = pane.getByTestId('kanban-search')
  const idle = team.all[11]
  await search.fill(team.tickets[idle])
  await expect(visibleCards(pane)).toHaveCount(1)
  await expect(card(pane, idle)).toBeVisible()
  await expect(pane.getByTestId('kanban-search-clear')).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(pane.getByTestId('kanban-search-clear')).toHaveCount(0)
  // A word only that card's summary has (`Step 12 of the runbook`).
  await search.fill('step 12 of the RUNBOOK')
  await expect(card(pane, idle)).toBeVisible()
  await expect(visibleCards(pane)).toHaveCount(1)
  await search.fill('')
  await chip(pane, 'running').click()
  await search.fill(team.tickets[team.running[0]])
  await expect(visibleCards(pane)).toHaveCount(1)
  await expect(card(pane, team.running[0])).toBeVisible()
  await search.fill(team.tickets[idle])
  await expect(visibleCards(pane)).toHaveCount(0)
  await pane.getByTestId('kanban-search-clear').click()
  await expect(search).toBeFocused()
  await chip(pane, 'running').click()
})
