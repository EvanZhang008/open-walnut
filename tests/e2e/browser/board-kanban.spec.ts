/**
 * The Board tab's Cards view on the spec 12 team (board-kanban-fixture.ts), as
 * a user meets it on Home: the kanban replaces the old flat list, the lanes of
 * each template, where every card is placed with nobody having placed it, the
 * status words, the card content, the done lane's preview, unread dots,
 * loading and empty, the parked card, the neutral sev:2 chip (C1 C2 C3 C15
 * C21 C22 C30 C46 C47 C57 C66 C77 C84 C94). Chromium and WebKit, real clicks.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import {
  NON_LATIN_WORDS, call, kanbanApi, pollUntil, seedKanbanTeam, type KanbanApi, type KanbanTeam,
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
  await recordHandBack()
})

/**
 * The server's watch records a worker's own hand back only on a board that
 * exists (spec 4.2), and the seeded team has none yet: create it (the lanes
 * the template gives, one human lanes write) and let the worker hand back again.
 */
async function recordHandBack(): Promise<void> {
  const b = await call<{ lanes_effective: unknown[] }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/lanes`, { lanes: b.lanes_effective })
  await call(api, 'PATCH', `/api/tasks/${team.handedBack}`, { phase: 'IN_PROGRESS' })
  await call(api, 'PATCH', `/api/v1/tasks/${team.handedBack}`, { phase: 'NEED_ACTION' }, { 'x-walnut-caller-sid': team.handedBackSid })
  await pollUntil('handed back recorded', () => call<{ cards: Record<string, { handed_back_at?: string }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`),
    (v) => !!v.cards[team.handedBack]?.handed_back_at, 20_000)
}

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Real navigation by link click (never page.goto), then the leader's Board tab. */
async function openBoard(page: Page, leader = team.leader, sid = team.leaderSid, project = team.project, beforeBoard?: () => Promise<void>): Promise<Locator> {
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
  if (beforeBoard) await beforeBoard()
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  // The task summaries arrive in one read after the cards: wait so nothing grows under a measure.
  if (leader === team.leader) await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const laneCards = (pane: Locator, lane: string) => pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="${lane}"] [data-testid="kanban-card"]`)

async function openRail(pane: Locator): Promise<void> {
  const rail = pane.getByTestId('kanban-done-rail')
  if (await rail.count()) await rail.click()
  await expect(pane.locator('[data-testid="kanban-lane"][data-lane-id="resolved"]')).toBeVisible()
}

test('C1 C2 C3 C66: the kanban replaces the list; triage lanes; every card placed by its state; counts are the DOM', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await expect(pane.locator('[data-testid^="board-overview-group"]')).toHaveCount(0)
  await expect(pane.getByTestId('board-view-cards')).toHaveText(/^Cards/)
  await expect(pane.getByTestId('board-view-custom')).toHaveText(/^Page/)
  await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'wide')
  const order = await pane.locator('[data-testid="kanban-lane"], [data-testid="kanban-done-rail"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane-id')))
  expect(order).toEqual(['new', 'investigating', 'mitigating', 'waiting-others', 'waiting-cr', 'resolved'])
  const names = await pane.getByTestId('kanban-lane-name').allTextContents()
  expect(names.map((n) => n.trim())).toEqual(['New', 'Investigating', 'Mitigating', 'Waiting on others', 'Waiting on CR'])
  await expect(pane.getByTestId('kanban-done-rail')).toContainText('Resolved 23')

  // C3: nobody placed anything; the stateless rule did.
  for (const id of [...team.running, ...team.idle, team.perm, team.question]) await expect(card(pane, id)).toHaveAttribute('data-lane', 'investigating')
  await expect(card(pane, team.waiting)).toHaveAttribute('data-lane', 'waiting-others')
  await expect(card(pane, team.waiting).getByTestId('kanban-card-parked')).toHaveText(/Parked \(auto\)/)
  await expect(laneCards(pane, 'waiting-cr')).toHaveCount(0)
  for (const lane of ['new', 'investigating', 'mitigating', 'waiting-others', 'waiting-cr']) {
    const n = await laneCards(pane, lane).count()
    await expect(pane.locator(`[data-testid="kanban-lane-head"][data-lane-id="${lane}"] [data-testid="kanban-lane-count"]`)).toHaveText(new RegExp(`^${n}\\b`))
  }
  await openRail(pane)
  await pane.getByTestId('kanban-lane-show-all').click()
  await expect(laneCards(pane, 'resolved')).toHaveCount(23)
  for (const id of team.done) await expect(card(pane, id)).toHaveAttribute('data-lane', 'resolved')

  // C66: the payload's team counts all 37 (10 of them done more than 7 days ago), whatever the store holds.
  const board = await call<{ team: Array<{ id: string; phase: string; completed_at?: string }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)
  expect(board.team).toHaveLength(37)
  const weekAgo = Date.now() - 7 * 86_400_000
  expect(board.team.filter((e) => Date.parse(e.completed_at ?? '') < weekAgo).length).toBe(team.seeded.length ? 10 : 0)
  for (const id of team.oldDone) await expect(card(pane, id)).toBeVisible()
})

test('C2: a team with no ticket tag gets the general lanes', async ({ page }) => {
  test.setTimeout(180_000)
  const { task: lead } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', { title: `General leader ${team.stamp}`, source: 'local', pinned: false, project: `${team.project} general` })
  litter.push(lead.id)
  const { task: kid } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', { title: `General worker ${team.stamp}`, source: 'local', pinned: false, project: `${team.project} general`, parent_task_id: lead.id })
  litter.push(kid.id)
  const { sessionId } = await call<{ sessionId: string }>(api, 'POST', '/api/sessions/quick-start', {
    cwd: `${api.fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:General leader ready', taskId: lead.id,
  })
  const pane = await openBoard(page, lead.id, sessionId, `${team.project} general`)
  const order = await pane.locator('[data-testid="kanban-lane"], [data-testid="kanban-done-rail"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane-id')))
  expect(order).toEqual(['todo', 'in-progress', 'waiting', 'review', 'done'])
  await expect(card(pane, kid.id)).toHaveAttribute('data-lane', 'todo')
  await expect(card(pane, kid.id).getByTestId('kanban-card-status')).toHaveText(/No session/)
})

test('C15 C57: the status line says why, in the right tone; only the real asks need you', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const status = (id: string) => card(pane, id).getByTestId('kanban-card-status')
  await expect(status(team.perm)).toHaveText(/^Needs you: approve Bash/)
  await expect(status(team.perm)).toHaveAttribute('data-tone', 'red')
  await expect(status(team.question)).toHaveText(/^Needs you: question/)
  await expect(status(team.handedBack)).toHaveText(/^Needs you: handed back/)
  await expect(status(team.handedBack)).toHaveAttribute('data-tone', 'red')
  for (const id of team.running) await expect(status(id)).toHaveText(/^Running(: \S.*)?$/)
  await call(api, 'PATCH', `/api/sessions/${team.runningSids[0]}`, { activity: 'Reading logs' })
  await expect(status(team.running[0])).toHaveText('Running: Reading logs', { timeout: 10_000 })
  await expect(status(team.waiting)).toHaveText(/^Waiting until /)
  await expect(status(team.waiting)).toHaveAttribute('data-tone', 'violet')
  const plain = team.idle.filter((id) => id !== team.handedBack && id !== team.stale && id !== team.all[9])
  for (const id of plain) {
    await expect(status(id)).toHaveText(/^Turn ended (\d+(m|h|d)|just now)( ago)?$/)
    await expect(status(id)).toHaveAttribute('data-tone', 'amber')
  }
  // The nested worker's prompt rolls into its parent's card.
  await expect(status(team.all[9])).toHaveText(/^Needs you: worker below/)
  // C57: perm + question + handed back + the nested roll up = 4, never the 8 turn ends.
  await expect(pane.getByTestId('kanban-chip-needs')).toContainText('4')
  const reds = await pane.locator('[data-testid="kanban-card-status"][data-tone="red"]').count()
  expect(reds).toBe(4)
})

test('C21 C46 C94: title, ticket link, Sev chip, 3 line summary, plain text, expand in place', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const perm = card(pane, team.perm)
  const link = perm.locator('[data-testid="kanban-card-ticket"] a[target="_blank"]')
  await expect(link).toHaveText(/V1000000101/)
  await expect(perm.getByTestId('kanban-card-sev')).toHaveText('Sev 1')
  await expect(card(pane, team.idle[1]).getByTestId('kanban-card-sev')).toHaveText('Sev 2')
  // A click on the ticket link opens the ticket, never the card, never a drag.
  const popup = page.waitForEvent('popup')
  await link.click()
  await (await popup).close()
  await expect(page.getByTestId('board-task-peek')).toHaveCount(0)
  await expect(perm).not.toHaveClass(/is-placeholder/)
  // Summary: at most 3 lines wide, the tooltip is the whole text.
  const sum = card(pane, team.idle[1]).getByTestId('kanban-card-summary')
  const box = await sum.evaluate((el) => ({ h: el.clientHeight, lh: parseFloat(getComputedStyle(el).lineHeight), title: el.getAttribute('title') ?? '', text: el.textContent ?? '' }))
  expect(box.h).toBeLessThanOrEqual(3 * box.lh + 2)
  expect(box.title.startsWith(box.text)).toBe(true)
  expect(box.text).toBe(team.summaries[team.idle[1]])
  // C46: the long title clamps to 2 lines with its full name in the tooltip; the non Latin one shows whole.
  const long = card(pane, team.longTitle).getByTestId('kanban-card-title')
  const lt = await long.evaluate((el) => ({ h: el.clientHeight, lh: parseFloat(getComputedStyle(el).lineHeight), title: el.getAttribute('title') }))
  expect(lt.h).toBeLessThanOrEqual(2 * lt.lh + 2)
  expect(lt.title).toBe(team.titles[team.longTitle])
  await expect(card(pane, team.nonLatin).getByTestId('kanban-card-title')).toContainText(NON_LATIN_WORDS)
  // C94: markdown in a summary shows as plain text; a click expands it, Escape folds it, no peek.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[2]}`, { summary: 'Root cause is **the retry budget** in `ledger-sync`; rollback is out.' })
  const md = card(pane, team.idle[2]).getByTestId('kanban-card-summary')
  await expect(md).toHaveText('Root cause is the retry budget in ledger-sync; rollback is out.', { timeout: 15_000 })
  expect(await md.locator('strong, code, b, em').count()).toBe(0)
  await md.click()
  await expect(md).toHaveAttribute('data-expanded', 'true')
  await card(pane, team.idle[2]).focus()
  await page.keyboard.press('Escape')
  await expect(md).not.toHaveAttribute('data-expanded', 'true')
  await expect(page.getByTestId('board-task-peek')).toHaveCount(0)
})

test('C22: the done lane shows its 5 newest, then all 23, then fewer; the count stays 23', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  await openRail(pane)
  await expect(laneCards(pane, 'resolved')).toHaveCount(5)
  const more = pane.getByTestId('kanban-lane-show-all')
  await expect(more).toHaveText('Show all 23')
  await more.click()
  await expect(laneCards(pane, 'resolved')).toHaveCount(23)
  await expect(more).toHaveText('Show fewer')
  await expect(pane.locator('[data-testid="kanban-lane-head"][data-lane-id="resolved"] [data-testid="kanban-lane-count"]')).toHaveText(/^23/)
  await more.click()
  await expect(laneCards(pane, 'resolved')).toHaveCount(5)
})

test('C30: unread output is a dot; opening the card clears it', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const id = team.idle[3]
  const dot = card(pane, id).getByTestId('kanban-card-unread')
  await expect(dot).toHaveAttribute('aria-label', 'New output you have not seen')
  await card(pane, id).getByTestId('kanban-card-foot').click({ position: { x: 4, y: 12 } })
  await expect(page.getByTestId('board-task-peek')).toBeVisible({ timeout: 15_000 })
  await expect(dot).toHaveCount(0, { timeout: 15_000 })
})

test('C47 C66: no Empty flash while loading; a task the store lacks is a loading card in its lane; an empty team', async ({ page }) => {
  test.setTimeout(180_000)
  // Record every Empty card and every loading card the board ever drew.
  await page.addInitScript(() => {
    const seen = { empty: 0, loading: 0 }
    ;(window as unknown as { __kanbanSeen: typeof seen }).__kanbanSeen = seen
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="kanban-empty"]')) seen.empty++
      if (document.querySelector('[data-testid="kanban-card-loading"], [data-testid="kanban-skeleton"]')) seen.loading++
    }).observe(document, { subtree: true, childList: true })
  })
  // The whole archive (ensureAllTasks: no completedWithinDays) answers late, so old done cards wait as loading cards.
  // Held from the moment the Board opens (Home's own loads before it are not).
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => { release = r })
  let held = 0
  const hold = async () => {
    await page.route('**/api/tasks?**', async (route) => {
      const u = new URL(route.request().url())
      if (u.searchParams.get('fields') === 'list' && !u.searchParams.has('completedWithinDays') && !u.searchParams.has('ids')) { held++; await gate }
      await route.continue()
    })
  }
  const pane = await openBoard(page, team.leader, team.leaderSid, team.project, hold)
  await openRail(pane)
  await pane.getByTestId('kanban-lane-show-all').click()
  if (team.seeded.length) {
    await expect.poll(() => held, { timeout: 15_000 }).toBeGreaterThan(0)
    await expect(pane.locator(`[data-testid="kanban-card-loading"][data-task-id="${team.oldDone[0]}"]`)).toHaveAttribute('data-lane', 'resolved')
  }
  release()
  for (const id of team.oldDone) await expect(card(pane, id)).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(() => (window as unknown as { __kanbanSeen: { empty: number } }).__kanbanSeen.empty)).toBe(0)

  // An empty team: the empty card, the first todo lane's Add task focused, the ask for a page.
  const { task: lead } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', { title: `Empty leader ${team.stamp}`, source: 'local', pinned: false, project: `${team.project} empty` })
  litter.push(lead.id)
  const { sessionId } = await call<{ sessionId: string }>(api, 'POST', '/api/sessions/quick-start', {
    cwd: `${api.fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Empty leader ready', taskId: lead.id,
  })
  const page2 = await page.context().newPage()
  const pane2 = await openBoard(page2, lead.id, sessionId, `${team.project} empty`)
  await expect(pane2.getByTestId('kanban-empty')).toContainText('No tasks on this board yet.', { timeout: 20_000 })
  await expect(pane2.getByTestId('kanban-empty')).toContainText('Add a task to a lane, or ask the leader to split the work.')
  await expect(pane2.locator('[data-testid="kanban-lane-body"][data-lane-id="todo"] [data-testid="kanban-add-task-input"]')).toBeFocused()
  await expect(pane2.getByTestId('board-ask-button')).toHaveText('Ask the leader for a page')
  await page2.close()
})

test('C77: a task that parked itself is Parked (auto) in Waiting on others, even after a rename', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const c = card(pane, team.waiting)
  await expect(c).toHaveAttribute('data-lane', 'waiting-others')
  await expect(c.getByTestId('kanban-card-parked')).toHaveAttribute('title', 'The task parked itself. Nobody placed it in this lane.')
  await expect(c.getByTestId('kanban-card-waiting')).toHaveCount(0)
  const board = await call<{ lanes_effective: Array<{ id: string; name: string; kind: string }> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)
  const lanes = board.lanes_effective.map((l) => (l.id === 'waiting-others' ? { ...l, name: 'Waiting on partner team' } : l))
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/lanes`, { lanes })
  await expect(pane.locator('[data-testid="kanban-lane-head"][data-lane-id="waiting-others"] [data-testid="kanban-lane-name"]')).toHaveText('Waiting on partner team', { timeout: 15_000 })
  await expect(c.getByTestId('kanban-card-parked')).toHaveText(/Parked \(auto\)/)
})

test('C84: the sev:2 chip is neutral; amber is only idle, stale, turn ended, still open', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  const sev2 = card(pane, team.idle[1]).getByTestId('kanban-card-sev')
  const style = await sev2.evaluate((el) => {
    const cs = getComputedStyle(el)
    const root = el.closest('.board-kanban') as HTMLElement
    const probe = document.createElement('span')
    probe.style.color = 'var(--kb-amber)'
    root.appendChild(probe)
    const amber = getComputedStyle(probe).color
    probe.remove()
    return { border: cs.borderTopColor, color: cs.color, bg: cs.backgroundColor, amber }
  })
  expect(style.border).not.toBe(style.amber)
  expect(style.color).not.toBe(style.amber)
  // Every amber status line is one of the four meanings.
  const ambers = await pane.locator('[data-testid="kanban-card-status"][data-tone="amber"]').allTextContents()
  for (const t of ambers) expect(t).toMatch(/^(Handled\. )?(Idle|Turn ended|Task still open)/)
})
