/**
 * "Changed since you last looked" and staleness on the real density team
 * (board-kanban-fixture.ts):
 *
 *   C28  After a baseline, the leader's two moves and one summary show as `Changed 3`
 *        with who and when; opening a card clears it; Mark all seen clears all; the
 *        user's own move never counts.
 *   C29  A card with no progress for 3 days says `Stale 3d`; done, running and parked
 *        cards never do; the leader rewriting its summary does not refresh it.
 *   C87  In a wait lane the same card says `Waiting 3d` and still counts as stale.
 *   C61  A message the user sends is not `New output`; the turn's output shows once.
 *   C62  Two windows count the same; one's Mark all seen reaches the other; a session
 *        cannot write the baseline (403 human_only).
 *   C63  A visit's end (the Page view, or 5 minutes hidden on a controlled clock)
 *        makes what was on screen the baseline; the chip's tooltip names that time.
 *   C88  What changed lists the changes in time order, inside the viewport, a row
 *        reveals its card; a non leader writer is named by its task.
 *
 * Both engines share one fixture server, so every run seeds its own team.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import {
  call, getSession, kanbanApi, pollUntil, seedKanbanTeam, type KanbanApi, type KanbanTeam,
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
const asLeader = { 'x-walnut-caller-sid': '' }
const leaderSet = (task: string, body: Record<string, unknown>) =>
  call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${task}`, body, { ...asLeader, 'x-walnut-caller-sid': team.leaderSid })
const seenAll = () => call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/kanban-seen`, { cards: 'all' })
interface SeenPayload { kanban_seen: { at: string; previous_at?: string } | null }
const seenNow = () => call<SeenPayload>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1&fields=kanban`)
const CLOCK = '\\d{2}:\\d{2}'

async function cardMenu(page: Page, c: Locator, row: string): Promise<void> {
  await c.hover()
  await c.getByTestId('kanban-card-more').click()
  await page.getByTestId(row).click()
}

test('C28: the leader moves and rewrites show as Changed with who and when; opening one and Mark all seen clear them', async ({ page }) => {
  await seenAll()
  const [m1, m2, s1] = [team.all[10], team.all[11], team.all[12]]
  await leaderSet(m1, { lane: 'mitigating' })
  await leaderSet(m2, { lane: 'mitigating' })
  await leaderSet(s1, { summary: 'Leader note: the retry storm is contained, waiting for the p99 to settle.' })
  const pane = await openBoard(page)
  const changed = chip(pane, 'changed')
  await expect.poll(() => chipCount(changed), { timeout: 30_000 }).toBe(3)
  await expect(changed).toHaveAttribute('title', new RegExp(`^Changed since you last looked \\(${CLOCK}\\)$`))
  for (const id of [m1, m2]) {
    await expect(card(pane, id).getByTestId('kanban-card-changed')).toHaveText(new RegExp(`^Moved by the leader ${CLOCK}$`))
    await expect(card(pane, id).getByTestId('kanban-card-changed')).toHaveAttribute('title', new RegExp(`^Moved from Investigating by the leader · ${CLOCK}$`))
  }
  await expect(card(pane, s1).getByTestId('kanban-card-changed')).toHaveText(new RegExp(`^Summary by the leader ${CLOCK}$`))
  // Opening a card clears its mark.
  await card(pane, m1).getByTestId('kanban-card-title').click()
  await expect.poll(() => chipCount(changed), { timeout: 15_000 }).toBe(2)
  await expect(card(pane, m1).getByTestId('kanban-card-changed')).toHaveCount(0)
  // The user's own move never counts, here or in another window.
  await cardMenu(page, card(pane, team.all[8]), 'kanban-card-menu-move')
  await page.locator('[data-testid="kanban-card-move-lane"][data-lane-id="mitigating"]').click()
  await expect(card(pane, team.all[8])).toHaveAttribute('data-lane', 'mitigating', { timeout: 15_000 })
  await page.waitForTimeout(1_000)
  expect(await chipCount(changed)).toBe(2)
  await changed.click()
  await expect(pane.getByTestId('kanban-mark-seen')).toBeVisible()
  await pane.getByTestId('kanban-mark-seen').click()
  await expect.poll(() => chipCount(changed), { timeout: 15_000 }).toBe(0)
  await expect(changed).toHaveAttribute('aria-pressed', 'false')
  await expect(pane.getByTestId('kanban-mark-seen')).toHaveCount(0)
})

test('C61: the user message is not New output; the turn output shows once, as the unread dot', async ({ page }) => {
  await seenAll()
  const id = team.all[9 + 3]
  const sid = team.sessions[id]
  const pane = await openBoard(page)
  const c = card(pane, id)
  await expect(c.getByTestId('kanban-card-changed')).toHaveCount(0)
  await call(api, 'PATCH', `/api/tasks/${id}`, { unread: false })
  await expect(c.getByTestId('kanban-card-unread')).toHaveCount(0, { timeout: 15_000 })
  await c.hover()
  await c.getByTestId('kanban-card-message').click()
  await c.getByTestId('kanban-card-composer-input').fill('slow:4000 snapshot-clean-turn:fresh findings on the ledger')
  await c.getByTestId('kanban-card-composer-input').press('Enter')
  await expect(c.getByTestId('kanban-card-composer')).toHaveCount(0, { timeout: 20_000 })
  // The user's own message is not New output (the mock turn is short, so this
  // reads the card right after the send rather than waiting for Running).
  await expect(c.getByTestId('kanban-card-changed')).toHaveCount(0)
  await pollUntil('turn end', async () => (await getSession(api, sid)).process_status ?? '', (s) => s !== 'running', 90_000)
  // The output: one signal per card. The unread dot; the foot never repeats `New output` beside a summary change.
  // A hovered or focused card shows its actions over the foot: point and focus elsewhere first.
  await pane.getByTestId('kanban-rollup').click()
  await expect(c.getByTestId('kanban-card-unread')).toBeVisible({ timeout: 30_000 })
  await expect(c.getByTestId('kanban-card-unread')).toHaveAttribute('aria-label', 'New output you have not seen')
  // The change label has its own line above the foot (N3): read both.
  const foot = (await c.locator('[data-testid="kanban-card-changed"], [data-testid="kanban-card-foot"]').allTextContents()).join(' ')
  if (/Summary updated|Moved from/.test(foot ?? '')) expect(foot).not.toContain('New output')
  // Round 3 C61: `New output` is a turn end WITH a summary change (output_at moved); the unread flip alone is the dot.
  const board = await call(api, 'GET', `/api/v1/tasks/${team.leader}/board`) as { cards?: Record<string, { output_at?: string }> }
  if (!board.cards?.[id]?.output_at) expect(foot).not.toContain('New output')
})

test('C62: two windows count the same, one window marking all seen reaches the other, a session cannot write it', async ({ page, browser }) => {
  await seenAll()
  await leaderSet(team.all[10], { lane: 'investigating' })
  await leaderSet(team.all[11], { summary: 'Leader note two: refunds drained, closing after one more check.' })
  const a = await openBoard(page)
  const otherCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const other = await otherCtx.newPage()
  const b = await openBoard(other)
  await expect.poll(() => chipCount(chip(a, 'changed')), { timeout: 30_000 }).toBeGreaterThan(0)
  const n = await chipCount(chip(a, 'changed'))
  await expect.poll(() => chipCount(chip(b, 'changed')), { timeout: 15_000 }).toBe(n)
  // A's human move: not a change in B either.
  await cardMenu(page, card(a, team.all[12]), 'kanban-card-menu-move')
  await page.locator('[data-testid="kanban-card-move-lane"][data-lane-id="waiting-cr"]').click()
  await expect(card(b, team.all[12])).toHaveAttribute('data-lane', 'waiting-cr', { timeout: 15_000 })
  expect(await chipCount(chip(b, 'changed'))).toBe(n)
  await chip(a, 'changed').click()
  await a.getByTestId('kanban-mark-seen').click()
  await expect.poll(() => chipCount(chip(a, 'changed')), { timeout: 5_000 }).toBe(0)
  await expect.poll(() => chipCount(chip(b, 'changed')), { timeout: 2_500 }).toBe(0)
  await otherCtx.close()
  const res = await fetch(`${BASE}/api/v1/tasks/${team.leader}/board/kanban-seen`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': team.leaderSid }, body: JSON.stringify({ cards: 'all' }),
  })
  expect(res.status).toBe(403)
  expect(JSON.stringify(await res.json())).toContain('human_only')
})

test('C63: a visit that ends (the Page view) makes what was shown the baseline; later changes still count', async ({ page }) => {
  await seenAll()
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board`, { html: '<h1>Triage page</h1><p>For what a card cannot say.</p>' })
  await leaderSet(team.all[10], { lane: 'mitigating' })
  const pane = await openBoard(page)
  const changed = chip(pane, 'changed')
  await expect.poll(() => chipCount(changed), { timeout: 30_000 }).toBeGreaterThan(0)
  const before = (await seenNow()).kanban_seen!.at
  // The visit ends: the Page view.
  await pane.getByTestId('board-view-custom').click()
  const after = await pollUntil('visit end baseline', async () => (await seenNow()).kanban_seen, (s) => !!s && s.at !== before)
  expect(after!.previous_at).toBe(before)
  await pane.getByTestId('board-view-cards').click()
  await expect.poll(() => chipCount(changed), { timeout: 15_000 }).toBe(0)
  const hm = new Date(after!.at)
  const clock = `${String(hm.getHours()).padStart(2, '0')}:${String(hm.getMinutes()).padStart(2, '0')}`
  await expect(changed).toHaveAttribute('title', `Nothing changed since you last looked (${clock})`)
  // A change after the visit counts again (C28 left this card in Mitigating).
  await leaderSet(team.all[11], { lane: 'investigating' })
  await expect.poll(() => chipCount(changed), { timeout: 15_000 }).toBe(1)
  await expect(changed).toHaveAttribute('title', `Changed since you last looked (${clock})`)
})

test('C63: 5 minutes hidden on a controlled clock ends the visit too', async ({ page }) => {
  await page.clock.install()
  const pane = await openBoard(page)
  await expect(pane.getByTestId('kanban-chip-changed')).toBeVisible()
  const before = (await seenNow()).kanban_seen!.at
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward('04:00')
  await page.waitForTimeout(1_000)
  expect((await seenNow()).kanban_seen!.at).toBe(before)
  await page.clock.fastForward('01:30')
  await pollUntil('away visit end', async () => (await seenNow()).kanban_seen?.at ?? '', (at) => at !== before, 15_000)
})

test('C88: What changed lists the changes in time order inside the viewport, and a row reveals its card', async ({ page }) => {
  await seenAll()
  // C62 left all[12] where the user put it (a leader move there is a 409); C63 left all[10] in Mitigating.
  await leaderSet(team.all[10], { lane: 'investigating' })
  const worker = team.all[8]
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.all[11]}`,
    { summary: 'Worker note: the ledger export is caught up, verifying totals.' }, { 'x-walnut-caller-sid': team.sessions[worker] })
  const pane = await openBoard(page)
  const changed = chip(pane, 'changed')
  await expect.poll(() => chipCount(changed), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  await changed.click()
  await pane.getByTestId('kanban-changes-open').click()
  const pop = page.getByTestId('kanban-changes')
  await expect(pop).toBeVisible()
  const box = (await pop.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  expect(box.height).toBeLessThanOrEqual(vp.height * 0.6 + 1)
  const rows = await pop.getByTestId('kanban-changes-row').allTextContents()
  const moved = rows.find((r) => r.includes(`the leader moved ${team.tickets[team.all[10]]} from Mitigating to Investigating`))
  expect(moved, rows.join(' | ')).toMatch(new RegExp(`^${CLOCK} `))
  const writer = (team.titles[worker] ?? '').slice(0, 24).trimEnd()
  expect(rows.some((r) => r.includes(`${writer}`) && r.includes(`updated the summary of ${team.tickets[team.all[11]]}`)), rows.join(' | ')).toBe(true)
  const times = rows.map((r) => r.slice(0, 5))
  expect([...times].sort()).toEqual(times)
  await pop.locator(`[data-testid="kanban-changes-row"][data-task-id="${team.all[11]}"]`).first().click()
  await expect(pop).toHaveCount(0)
  await expect(card(pane, team.all[11])).toBeInViewport()
  await expect(card(pane, team.all[11])).toHaveAttribute('data-flash', 'true', { timeout: 3_000 })
})

// Last: it needs the boot seed (test-server.ts kanbanSeedTasks) and must not block the others.
test('C29 C87: a card with no progress for 3 days is stale, and Waiting 3d in a wait lane', async ({ page }) => {
  expect(team.seeded, 'test-server.ts must seed kanbanSeedTasks (the 3 day stall)').toContain(team.stale)
  const pane = await openBoard(page)
  const stale = card(pane, team.stale)
  await expect(stale.getByTestId('kanban-card-stale')).toHaveText('Stale 3d')
  expect(await chipCount(chip(pane, 'stale'))).toBe(1)
  // Done, running and a parked WAITING card with a future wait_until are never stale.
  for (const id of [...team.running, team.waiting, team.done[0], team.oldDone[0]]) await expect(card(pane, id).getByTestId('kanban-card-stale')).toHaveCount(0)
  // A board edit is not progress: the leader rewriting its summary leaves it stale.
  await leaderSet(team.stale, { summary: 'Card reader timeouts: still waiting on the vendor, no change since Thursday.' })
  await expect(stale.getByTestId('kanban-card-summary')).toHaveText(/^Card reader timeouts: still waiting/, { timeout: 15_000 })
  await expect(stale.getByTestId('kanban-card-stale')).toHaveText('Stale 3d')
  // In a wait lane it says Waiting 3d, and still counts.
  await cardMenu(page, stale, 'kanban-card-menu-move')
  await page.locator('[data-testid="kanban-card-move-lane"][data-lane-id="waiting-cr"]').click()
  await expect(stale).toHaveAttribute('data-lane', 'waiting-cr', { timeout: 15_000 })
  await expect(stale.getByTestId('kanban-card-stale')).toHaveText('Waiting 3d')
  expect(await chipCount(chip(pane, 'stale'))).toBe(1)
  await chip(pane, 'stale').click()
  await expect(pane.locator('[data-testid="kanban-card"]:visible')).toHaveCount(1)
  await expect(stale).toBeVisible()
  await chip(pane, 'stale').click()
})
