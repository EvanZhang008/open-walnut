/**
 * The Board's three views on the kanban fixture team (board-kanban-fixture.ts:
 * 37 cards, every live state) once its leader defines board projects, the way
 * a lead uses them: the bar reads Projects | Cards | Page and opens on
 * Projects; Cards names each card's project, a project chip shows that
 * project's cards only (with a chip and the search too), and the pick is
 * remembered; a project the leader renames or removes changes the cards live.
 * Wide (1280) and narrow (520), light and dark, chromium and WebKit; shots in
 * /tmp/kanban/shots/three-views.
 */
import fs from 'node:fs/promises'
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, seedKanbanTeam, type KanbanApi, type KanbanTeam } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/kanban/shots/three-views'
const litter: string[] = []
let api: KanbanApi
let team: KanbanTeam
let engine = ''

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

const leaderHeaders = () => ({ 'x-walnut-caller-sid': team.leaderSid })

/** Three areas of the queue: the running and prompt cards, five idle cards plus the handed back one, one done card. */
function areas(): Record<string, { title: string; status: string; tasks: string[] }> {
  return {
    payments: { title: 'Card payments failing', status: 'wip', tasks: [...team.running, team.perm, team.question] },
    refunds: { title: 'Refund delays', status: 'decide', tasks: [...team.idle.slice(0, 5), team.handedBack] },
    ledger: { title: 'Ledger drift', status: 'done', tasks: [team.done[0]] },
  }
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(600_000)
  engine = info.project.name
  await fs.mkdir(SHOTS, { recursive: true })
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  team = await seedKanbanTeam(api, { engine, litter })
  // The leader's first card write makes the board file (no page yet), as it does on a real team; projects need one.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${team.idle[7]}`, { summary: 'Waiting on the bank\'s reply.' }, leaderHeaders())
  for (const [id, body] of Object.entries(areas())) {
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/projects/${id}`, body, leaderHeaders())
  }
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${API}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Real navigation (a link click), the leader's row, its Board chip. */
async function openBoard(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: team.project })
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane.getByTestId('board-view-toggle')).toBeVisible({ timeout: 30_000 })
  return pane
}

const projectCards = (pane: Locator) => pane.locator('[data-testid="board-card"][data-kind="project"]')
const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)
const shownCards = (pane: Locator) => pane.locator('[data-testid="kanban-card"]:visible')
const shownIds = (pane: Locator) => shownCards(pane).evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id') ?? '').sort())
const openOf = (ids: string[]) => ids.filter((id) => !team.done.includes(id))

async function cardsView(pane: Locator): Promise<void> {
  await pane.getByTestId('board-view-cards').click()
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  await expect(pane.locator('[data-testid="kanban-card-summary"]').first()).toBeVisible({ timeout: 30_000 })
}

async function narrowPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 900 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  return { page, close: () => ctx.close() }
}

test('Projects is the default once the leader defines projects; the bar reads Projects | Cards | Page', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  const segs = await pane.getByTestId('board-view-toggle').locator('[data-view]').evaluateAll((els) => els.map((e) => e.getAttribute('data-view')))
  expect(segs).toEqual(['projects', 'cards', 'custom'])
  await expect(pane.getByTestId('board-view-projects')).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.getByTestId('board-view-custom')).toHaveAttribute('aria-disabled', 'true')
  await expect(projectCards(pane)).toHaveCount(3, { timeout: 30_000 })
  const titles = await projectCards(pane).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))
  expect([...titles].sort()).toEqual(Object.values(areas()).map((a) => a.title).sort())
  // The kanban stays mounted but hidden under Projects: none of its cards is on screen.
  await expect(shownCards(pane)).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${engine}-1-projects-wide-light.png` })
})

test('Cards names each card\'s project; a project chip shows that project only, with the chips and the search too', async ({ page }) => {
  test.setTimeout(300_000)
  const pane = await openBoard(page)
  await cardsView(pane)
  const a = areas()
  for (const id of a.payments.tasks) await expect(card(pane, id).getByTestId('kanban-card-project')).toHaveText(a.payments.title)
  for (const id of a.refunds.tasks) await expect(card(pane, id).getByTestId('kanban-card-project')).toHaveText(a.refunds.title)
  const loose = team.idle.filter((id) => !a.refunds.tasks.includes(id))
  for (const id of loose) await expect(card(pane, id).getByTestId('kanban-card-project')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${engine}-2-cards-wide-light.png` })

  // The chip on a card filters to its project: exactly that project's open cards stay.
  const refundsChip = card(pane, a.refunds.tasks[0]).getByTestId('kanban-card-project')
  await refundsChip.click()
  const filter = pane.getByTestId('kanban-project-filter')
  await expect(filter).toHaveText(/Project: Refund delays/)
  await expect(refundsChip).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => shownIds(pane)).toEqual(openOf(a.refunds.tasks).sort())
  // A click on the card's chip did not open the card.
  await expect(pane.getByTestId('kanban-card-detail')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${engine}-3-project-filter-wide.png` })

  // With Needs you: the intersection (the handed back card is in this project; the prompts are not).
  const needs = pane.getByTestId('kanban-chip-needs')
  await needs.click()
  await expect(card(pane, team.handedBack)).toBeVisible()
  const needsIds = await shownIds(pane)
  for (const id of needsIds) expect(a.refunds.tasks).toContain(id)
  await expect(card(pane, team.perm)).toHaveCount(0)
  await needs.click()
  // With the search: a word from one card's title in the project.
  const search = pane.getByTestId('kanban-search')
  await search.fill(team.tickets[a.refunds.tasks[1]])
  await expect.poll(() => shownIds(pane)).toEqual([a.refunds.tasks[1]])
  await search.fill(team.tickets[loose[0]])
  await expect.poll(() => shownIds(pane)).toEqual([])
  await search.fill('')

  // The chip on another project's card switches the filter; a second click on it clears.
  const paymentsChip = card(pane, a.payments.tasks[0]).getByTestId('kanban-card-project')
  await filter.click()
  await expect(filter).toHaveCount(0)
  await paymentsChip.click()
  await expect(pane.getByTestId('kanban-project-filter')).toHaveText(/Project: Card payments failing/)
  await expect.poll(() => shownIds(pane)).toEqual(openOf(a.payments.tasks).sort())
  await paymentsChip.click()
  await expect(pane.getByTestId('kanban-project-filter')).toHaveCount(0)
  await expect.poll(async () => (await shownIds(pane)).length).toBeGreaterThan(a.payments.tasks.length + a.refunds.tasks.length)
})

test('the Cards pick is remembered, and a renamed or removed project changes the cards live', async ({ page }) => {
  test.setTimeout(240_000)
  const pane = await openBoard(page)
  await cardsView(pane)
  expect(await page.evaluate((o) => localStorage.getItem(`walnut:board-view.v1:${o}`), team.leader)).toBe('cards')
  const a = areas()
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/projects/refunds`, { ...a.refunds, title: 'Refund delays (bank side)' }, leaderHeaders())
  await expect(card(pane, a.refunds.tasks[0]).getByTestId('kanban-card-project')).toHaveText('Refund delays (bank side)', { timeout: 15_000 })
  // A filter on a project that goes away shows every card again, never an empty board.
  await card(pane, a.payments.tasks[0]).getByTestId('kanban-card-project').click()
  await expect(pane.getByTestId('kanban-project-filter')).toBeVisible()
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/projects/payments`, { delete: true, override_user: true }, leaderHeaders())
  await expect(pane.getByTestId('kanban-project-filter')).toHaveCount(0, { timeout: 15_000 })
  await expect(card(pane, a.payments.tasks[0]).getByTestId('kanban-card-project')).toHaveCount(0)
  await expect.poll(async () => (await shownIds(pane)).length).toBeGreaterThan(a.payments.tasks.length)
  // Put it back for the shots that follow.
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/projects/payments`, a.payments, leaderHeaders())
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/projects/refunds`, a.refunds, leaderHeaders())
  await expect(card(pane, a.payments.tasks[0]).getByTestId('kanban-card-project')).toHaveText(a.payments.title, { timeout: 15_000 })
})

const renders = (page: Page) => page.evaluate(() => ({ ...((window as unknown as { __kanbanCardRenders?: Record<string, number> }).__kanbanCardRenders ?? {}) }))

test('with projects, one status update re-renders one card', async ({ page }) => {
  test.setTimeout(180_000)
  const pane = await openBoard(page)
  await cardsView(pane)
  await expect(card(pane, team.running[1]).getByTestId('kanban-card-project')).toHaveText(areas().payments.title)
  // Clear of a minute tick, which may touch every card's foot.
  await page.mouse.move(2, 2)
  await page.waitForTimeout(2500)
  const sec = new Date().getSeconds()
  if (sec > 40) await page.waitForTimeout((62 - sec) * 1000)
  const before = await renders(page)
  await call(api, 'PATCH', `/api/sessions/${team.runningSids[1]}`, { activity: 'One last look' })
  await expect(card(pane, team.running[1]).getByTestId('kanban-card-status')).toHaveText('Running: One last look', { timeout: 10_000 })
  await page.waitForTimeout(800)
  const after = await renders(page)
  expect(Object.keys(after).filter((id) => (after[id] ?? 0) > (before[id] ?? 0))).toEqual([team.running[1]])
})

test('narrow 520 and dark: the project chip fits the card, nothing runs off the pane', async ({ page, browser }) => {
  test.setTimeout(300_000)
  const pane = await openBoard(page)
  await cardsView(pane)
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: `${SHOTS}/${engine}-4-cards-wide-dark.png` })
  await pane.getByTestId('board-view-projects').click()
  await expect(projectCards(pane)).toHaveCount(3)
  await page.screenshot({ path: `${SHOTS}/${engine}-5-projects-wide-dark.png` })

  const narrow = await narrowPage(browser)
  try {
    const np = await openBoard(narrow.page)
    await cardsView(np)
    await expect(np.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
    const a = areas()
    const chip = card(np, a.refunds.tasks[0]).getByTestId('kanban-card-project')
    await expect(chip).toBeVisible()
    const cardBox = (await card(np, a.refunds.tasks[0]).boundingBox())!
    const chipBox = (await chip.boundingBox())!
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
    expect(await np.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
    await narrow.page.screenshot({ path: `${SHOTS}/${engine}-6-cards-narrow-light.png` })
    await chip.click()
    await expect(np.getByTestId('kanban-project-filter')).toBeVisible()
    await narrow.page.screenshot({ path: `${SHOTS}/${engine}-7-project-filter-narrow.png` })
    await narrow.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await narrow.page.screenshot({ path: `${SHOTS}/${engine}-8-project-filter-narrow-dark.png` })
    await np.getByTestId('board-view-projects').click()
    await expect(projectCards(np)).toHaveCount(3)
    await narrow.page.screenshot({ path: `${SHOTS}/${engine}-9-projects-narrow-dark.png` })
  } finally {
    await narrow.close()
  }
})
