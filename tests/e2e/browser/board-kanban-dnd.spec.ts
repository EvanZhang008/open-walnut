/**
 * Dragging cards (spec 8.1, 8.2, 8.3): a mouse drop lands where its line was
 * (another lane, the same lane, the done lane's top), the keyboard drag, a
 * failed write puts the card back, Escape or a drop outside cancels with no
 * request, a second window follows within seconds, and a write overwritten at
 * once by another window never pins the card (C4 C5 C6 C8 C9 C36 C86 C92).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

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
  // Two cards the user already put in Waiting on others, one in Waiting on CR (drag sources and targets next to each other).
  for (const [id, lane] of [[team.idle[0], 'waiting-others'], [team.idle[1], 'waiting-others'], [team.idle[2], 'waiting-cr'], [team.idle[3], 'waiting-cr']] as const) {
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane })
  }
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

const laneIds = (pane: Locator, lane: string) => pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="${lane}"] [data-testid="kanban-card"]`)
  .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? ''))
const laneBody = (pane: Locator, lane: string) => pane.locator(`[data-testid="kanban-lane-body"][data-lane-id="${lane}"]`)

/** Mouse drag: down on the card's title, 10 steps to the point, `whileOver` with the button still down, then up. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }, whileOver?: () => Promise<void>): Promise<void> {
  const b = (await from.getByTestId('kanban-card-title').boundingBox())!
  await page.mouse.move(b.x + Math.min(40, b.width / 2), b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 50, b.y + b.height / 2 + 8, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps: 10 })
  await page.waitForTimeout(150)
  if (whileOver) await whileOver()
  await page.mouse.up()
}

/** A point in the bottom (after) or top (before) half of a card. */
async function pointOn(l: Locator, half: 'top' | 'bottom'): Promise<{ x: number; y: number }> {
  const b = (await l.boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height * (half === 'top' ? 0.25 : 0.75) }
}

async function showLanes(pane: Locator, ...lanes: string[]): Promise<void> {
  const host = pane.getByTestId('kanban-lanes')
  const first = pane.locator(`[data-testid="kanban-lane"][data-lane-id="${lanes[0]}"], [data-testid="kanban-done-rail"][data-lane-id="${lanes[0]}"]`)
  const left = await first.evaluate((el) => (el as HTMLElement).offsetLeft)
  await host.evaluate((el, x) => { el.scrollLeft = Math.max(0, x - 12) }, left)
  await pane.page().waitForTimeout(100)
}

const moves = (page: Page) => {
  const seen: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && /\/board\/cards\/[^/]+\/move$/.test(new URL(r.url()).pathname)) seen.push(r.url()) })
  return seen
}

interface CardRow { lane?: string; lane_by?: string; rank?: number }
const cardsOf = async () => (await call<{ cards: Record<string, CardRow> }>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1`)).cards

test('C4: a mouse drop into Waiting on CR at position 2 lands where its line was, and stays there', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const src = team.idle[0]
  await showLanes(pane, 'waiting-others', 'waiting-cr')
  const target = await laneIds(pane, 'waiting-cr')
  expect(target.length).toBe(2)
  let lineBefore = ''
  await drag(page, card(pane, src), await pointOn(card(pane, target[0]), 'bottom'), async () => {
    lineBefore = await laneBody(pane, 'waiting-cr').locator('[data-testid="kanban-drop-line"] + [data-testid="kanban-card"]').getAttribute('data-task-id') ?? ''
  })
  expect(lineBefore).toBe(target[1])
  await expect.poll(() => laneIds(pane, 'waiting-cr')).toEqual([target[0], src, target[1]])
  await expect.poll(async () => (await cardsOf())[src]).toMatchObject({ lane: 'waiting-cr', lane_by: 'human' })
  const pane2 = await openBoard(await page.context().newPage())
  await expect.poll(() => laneIds(pane2, 'waiting-cr')).toEqual([target[0], src, target[1]])
})

test('C5: a reorder in the same lane (third to first) holds after a reload', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await showLanes(pane, 'investigating')
  const before = await laneIds(pane, 'investigating')
  const third = before[2]
  await drag(page, card(pane, third), await pointOn(card(pane, before[0]), 'top'))
  await expect.poll(async () => (await laneIds(pane, 'investigating'))[0]).toBe(third)
  const after = await laneIds(pane, 'investigating')
  const pane2 = await openBoard(await page.context().newPage())
  await expect.poll(() => laneIds(pane2, 'investigating')).toEqual(after)
  // Rank only: an automatic card is still automatic (G10).
  const c = (await cardsOf())[third]
  expect(c?.lane).toBeUndefined()
})

test('C6: the keyboard drag: Space, Right twice, Down, Space lands at the announced place', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const src = (await laneIds(pane, 'investigating'))[0]
  await showLanes(pane, 'investigating')
  await card(pane, src).focus()
  await page.keyboard.press('Space')
  await expect(pane.getByTestId('kanban-live')).toHaveText(/^Picked up /)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(pane.getByTestId('kanban-live')).toHaveText(/ is over Waiting on others, position 2 of \d+\.$/)
  const others = await laneIds(pane, 'waiting-others')
  await page.keyboard.press('Space')
  await expect(pane.getByTestId('kanban-live')).toHaveText(/ dropped in Waiting on others, position 2\.$/)
  await expect.poll(async () => (await laneIds(pane, 'waiting-others'))[1]).toBe(src)
  expect((await laneIds(pane, 'waiting-others')).length).toBe(others.length + 1)
  const pane2 = await openBoard(await page.context().newPage())
  await expect.poll(async () => (await laneIds(pane2, 'waiting-others'))[1]).toBe(src)
})

test('C8: a move the server refuses puts the card back in its place and says so', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await page.route('**/board/cards/*/move', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'Board store is locked' } }) }))
  await showLanes(pane, 'waiting-others', 'waiting-cr')
  const from = await laneIds(pane, 'waiting-others')
  const src = from[0]
  const title = (await card(pane, src).getByTestId('kanban-card-title').getAttribute('title')) ?? ''
  // The last card's lower half, kept inside the lane's visible box: a tall card runs under the lane's bottom edge.
  const to = await pointOn(laneBody(pane, 'waiting-cr').locator('[data-testid="kanban-card"]').last(), 'bottom')
  const lane = (await pane.locator('[data-testid="kanban-lane"][data-lane-id="waiting-cr"]').boundingBox())!
  await drag(page, card(pane, src), { x: to.x, y: Math.min(to.y, lane.y + lane.height - 40) })
  await expect(pane.getByTestId('kanban-toasts')).toContainText(`Couldn't move "${title.slice(0, 20)}`, { timeout: 15_000 })
  await expect.poll(() => laneIds(pane, 'waiting-others')).toEqual(from)
})

test('C36: Escape mid drag, or a drop outside the lanes, cancels with no request', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const sent = moves(page)
  await showLanes(pane, 'waiting-others', 'waiting-cr')
  const from = await laneIds(pane, 'waiting-others')
  await drag(page, card(pane, from[0]), await pointOn(laneBody(pane, 'waiting-cr').locator('[data-testid="kanban-card"]').first(), 'top'), async () => {
    await page.keyboard.press('Escape')
  })
  const header = (await pane.getByTestId('kanban-header').boundingBox())!
  await drag(page, card(pane, from[0]), { x: header.x + header.width / 2, y: header.y + 6 })
  await page.waitForTimeout(800)
  expect(sent).toEqual([])
  expect(await laneIds(pane, 'waiting-others')).toEqual(from)
})

test('C9: a second window follows a drag within 3s, with no reload', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const page2 = await page.context().newPage()
  const pane2 = await openBoard(page2)
  // A reload drops this marker; the Home URL's own replaceState (the open column, `s1=`) does not.
  await page2.evaluate(() => { (window as unknown as { __c9: boolean }).__c9 = true })
  await showLanes(pane, 'waiting-others', 'waiting-cr')
  const src = (await laneIds(pane, 'waiting-cr'))[0]
  const others = await laneIds(pane, 'waiting-others')
  await drag(page, card(pane, src), await pointOn(card(pane, others[0]), 'top'))
  await expect.poll(async () => (await laneIds(pane, 'waiting-others'))[0]).toBe(src)
  const t0 = Date.now()
  await page2.mouse.move(2, 2)
  await expect.poll(async () => (await laneIds(pane2, 'waiting-others'))[0], { timeout: 3_000, intervals: [100] }).toBe(src)
  expect(Date.now() - t0).toBeLessThan(3_000)
  expect(await page2.evaluate(() => (window as unknown as { __c9?: boolean }).__c9)).toBe(true)
  await page2.close()
})

test('C86: anywhere in the done lane is its top: the line is drawn there, the card lands first', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await pane.getByTestId('kanban-done-rail').click()
  await showLanes(pane, 'waiting-cr', 'resolved')
  const done = await laneIds(pane, 'resolved')
  const src = (await laneIds(pane, 'waiting-cr'))[0]
  let lineBefore = ''
  await drag(page, card(pane, src), await pointOn(card(pane, done[2]), 'bottom'), async () => {
    lineBefore = await laneBody(pane, 'resolved').locator('[data-testid="kanban-drop-line"] + [data-testid="kanban-card"]').getAttribute('data-task-id') ?? ''
  })
  expect(lineBefore).toBe(done[0])
  await expect.poll(async () => (await laneIds(pane, 'resolved'))[0]).toBe(src)
  await expect(pane.getByTestId('kanban-toasts')).toContainText('Moved to Resolved. The task is still open.')
  // The keyboard says position 1 in a done lane.
  const kb = (await laneIds(pane, 'waiting-cr'))[0] ?? (await laneIds(pane, 'waiting-others')).slice(-1)[0]
  await card(pane, kb).focus()
  await page.keyboard.press('Space')
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')
  await expect(pane.getByTestId('kanban-live')).toHaveText(/ is over Resolved, position 1 of \d+\.$/)
  await page.keyboard.press('Escape')
  await expect(pane.getByTestId('kanban-live')).toHaveText('Move cancelled.')
})

test('C92: a write another window overwrites at once never pins the card where this window put it', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await showLanes(pane, 'waiting-others', 'waiting-cr')
  // The lane's top card: the cards grow with their summaries, so a lower one can sit under the fold.
  const src = (await laneIds(pane, 'waiting-others'))[0]
  const answered = page.waitForResponse((r) => r.request().method() === 'POST' && /\/move$/.test(new URL(r.url()).pathname))
  await drag(page, card(pane, src), await pointOn(laneBody(pane, 'waiting-cr').locator('[data-testid="kanban-card"]').last(), 'bottom'))
  await answered
  // Another window (the user elsewhere) puts it in Mitigating right after this write answered.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${src}`, { lane: 'mitigating' })
  await page.mouse.move(2, 2)
  await expect(card(pane, src)).toHaveAttribute('data-lane', 'mitigating', { timeout: 8_000 })
})
