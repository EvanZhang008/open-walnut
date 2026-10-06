/**
 * The kanban's lane structure and its shell, on the real density team
 * (board-kanban-fixture.ts):
 *
 *   C18  Rename a lane from its menu: the new name survives a reload and shows
 *        in a second window; its cards stay.
 *   C19  Add lane `Waiting on customer` (kind Waiting by its name) lands before
 *        Resolved with the wait colour, and survives a reload.
 *   C20  Delete lane: the dialog says where its cards go, they go there; the
 *        last lane cannot be deleted.
 *   C65  Two moves into Resolved inside 8s: two toasts, each completing its own
 *        card, both held while the pointer is over them.
 *   C89  A stored Page pick from before the kanban opens on Cards once, then Page.
 *   C52  Layout C (520px): the Board opens with the chat collapsed and a
 *        `Show chat` button; once the user shows it, it stays.
 *
 * Both engines share one fixture server, so every run seeds its own team.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import {
  call, kanbanApi, pollUntil, seedKanbanTeam, type KanbanApi, type KanbanTeam,
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
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${BASE}/api/v1/tasks/${id}/board`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${BASE}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

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
const laneHead = (pane: Locator, laneId: string) => pane.locator(`[data-testid="kanban-lane-head"][data-lane-id="${laneId}"]`)

async function shot(page: Page, name: string, info: { project: { name: string } }): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-${name}.png` })
}

async function laneMenu(page: Page, pane: Locator, laneId: string): Promise<Locator> {
  await laneHead(pane, laneId).getByTestId('kanban-lane-kebab').click()
  const menu = page.getByTestId('kanban-lane-menu')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('data-lane-id', laneId)
  return menu
}

/** Wide mode folds the done lane into a rail: open it into a normal lane (kept in sessionStorage). */
async function expandRail(pane: Locator): Promise<void> {
  const rail = pane.locator('[data-testid="kanban-done-rail"][data-lane-id="resolved"]')
  if (await rail.isVisible()) await rail.click()
  await expect(laneHead(pane, 'resolved')).toBeVisible()
}

const laneIds = (pane: Locator) => pane.getByTestId('kanban-lane-head').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane-id')))
const laneNames = (pane: Locator) => pane.getByTestId('kanban-lane-name').allTextContents()
interface LanesPayload { lanes_effective: Array<{ id: string; name: string; kind: string }>; cards: Record<string, { lane?: string }> }
const boardKanban = () => call<LanesPayload>(api, 'GET', `/api/v1/tasks/${team.leader}/board?team=1&fields=kanban`)

test('C18: a lane renamed from its menu keeps its name across a reload and a second window, and keeps its cards', async ({ page, browser }) => {
  const pane = await openBoard(page)
  await expect(card(pane, team.waiting)).toHaveAttribute('data-lane', 'waiting-others')
  const menu = await laneMenu(page, pane, 'waiting-others')
  const rows = await menu.locator('[role^="menuitem"]').evaluateAll((els) => els.map((e) => e.textContent?.trim()))
  expect(rows).toEqual(['Rename', 'Move left', 'Move right', 'To do', 'In progress', 'Waiting', 'Review', 'Done', 'Delete lane'])
  await expect(menu.getByTestId('kanban-lane-menu-kind-wait')).toHaveAttribute('aria-checked', 'true')
  await menu.getByTestId('kanban-lane-menu-rename').click()
  const input = laneHead(pane, 'waiting-others').getByTestId('kanban-lane-rename-input')
  await expect(input).toBeFocused()
  // A clash or an empty name is refused in place.
  await input.fill('waiting on CR')
  await input.press('Enter')
  await expect(laneHead(pane, 'waiting-others').getByTestId('kanban-lane-rename-error')).toHaveText('There is already a lane called "Waiting on CR"')
  await input.fill('  ')
  await input.press('Enter')
  await expect(laneHead(pane, 'waiting-others').getByTestId('kanban-lane-rename-error')).toHaveText('A lane needs a name')
  await input.fill('Waiting on partner team')
  await input.press('Enter')
  await expect(laneHead(pane, 'waiting-others').getByTestId('kanban-lane-name')).toHaveText('Waiting on partner team')
  await expect.poll(async () => (await boardKanban()).lanes_effective.find((l) => l.id === 'waiting-others')?.name).toBe('Waiting on partner team')
  await expect(card(pane, team.waiting)).toHaveAttribute('data-lane', 'waiting-others')
  // A second window shows it, and so does a reload of this one.
  const other = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  const pane2 = await openBoard(other)
  await expect(laneHead(pane2, 'waiting-others').getByTestId('kanban-lane-name')).toHaveText('Waiting on partner team')
  await other.context().close()
  const again = await openBoard(page)
  await expect(laneHead(again, 'waiting-others').getByTestId('kanban-lane-name')).toHaveText('Waiting on partner team')
  // Escape leaves a rename without a write.
  await laneHead(again, 'waiting-others').getByTestId('kanban-lane-name').dblclick()
  await laneHead(again, 'waiting-others').getByTestId('kanban-lane-rename-input').fill('Not this')
  await laneHead(again, 'waiting-others').getByTestId('kanban-lane-rename-input').press('Escape')
  await expect(laneHead(again, 'waiting-others').getByTestId('kanban-lane-name')).toHaveText('Waiting on partner team')
})

test('C19: Add lane puts `Waiting on customer` before Resolved, kind Waiting, and it stays after a reload', async ({ page }) => {
  const pane = await openBoard(page)
  await expandRail(pane)
  await pane.getByTestId('kanban-add-lane').click()
  const input = pane.getByTestId('kanban-add-lane-input')
  await expect(input).toBeFocused()
  await expect(pane.getByTestId('kanban-add-lane-kind-active')).toHaveAttribute('aria-checked', 'true')
  await input.fill('Waiting on customer')
  await expect(pane.getByTestId('kanban-add-lane-kind-wait')).toHaveAttribute('aria-checked', 'true')
  await expect(pane.getByTestId('kanban-add-lane-kinds')).toHaveAttribute('role', 'radiogroup')
  await input.press('Enter')
  await expect.poll(() => laneNames(pane)).toEqual(['New', 'Investigating', 'Mitigating', 'Waiting on partner team', 'Waiting on CR', 'Waiting on customer', 'Resolved'])
  const ids = await laneIds(pane)
  const added = ids[5]!
  expect(added).toMatch(/^ln-[0-9a-f]{8}$/)
  await expect(laneHead(pane, added)).toHaveAttribute('data-kind', 'wait')
  const bar = laneHead(pane, added).locator('.kanban-lane-kind-bar')
  const ref = laneHead(pane, 'waiting-cr').locator('.kanban-lane-kind-bar')
  expect(await bar.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await ref.evaluate((e) => getComputedStyle(e).backgroundColor))
  // G35: the new lane's Add task has the focus.
  await expect(pane.locator(`[data-testid="kanban-lane"][data-lane-id="${added}"] [data-testid="kanban-add-task"]`)).toBeFocused({ timeout: 5_000 })
  const again = await openBoard(page)
  await expandRail(again)
  await expect.poll(() => laneNames(again)).toContain('Waiting on customer')
  expect((await boardKanban()).lanes_effective.find((l) => l.id === added)).toMatchObject({ name: 'Waiting on customer', kind: 'wait' })
})

test('C20: Delete lane says where its cards go and puts them there', async ({ page }) => {
  // Two worked cards the user placed in Mitigating: deleted, they fall back to Investigating (they had sessions).
  const moved = [team.all[10], team.all[11]]
  for (const id of moved) await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/cards/${id}`, { lane: 'mitigating' })
  const pane = await openBoard(page)
  for (const id of moved) await expect(card(pane, id)).toHaveAttribute('data-lane', 'mitigating')
  const menu = await laneMenu(page, pane, 'mitigating')
  await menu.getByTestId('kanban-lane-menu-delete').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Delete "Mitigating"?')
  await expect(dialog).toContainText('Its 2 cards move to Investigating.')
  await dialog.getByRole('button', { name: 'Delete lane' }).click()
  await expect.poll(() => laneIds(pane)).not.toContain('mitigating')
  for (const id of moved) await expect(card(pane, id)).toHaveAttribute('data-lane', 'investigating')
  const after = await boardKanban()
  expect(after.lanes_effective.map((l) => l.id)).not.toContain('mitigating')
  for (const id of moved) expect(after.cards[id]?.lane).toBeUndefined()
})

test('C65: two moves into Resolved inside 8s keep two toasts, each completing its own card, held while hovered', async ({ page }) => {
  const pane = await openBoard(page)
  const [a, b] = [team.all[8], team.all[12]]
  for (const id of [a, b]) {
    const c = card(pane, id)
    await c.hover()
    await c.getByTestId('kanban-card-more').click()
    await page.getByTestId('kanban-card-menu-move').click()
    await page.locator('[data-testid="kanban-card-move-lane"][data-lane-id="resolved"]').click()
    await expect.poll(async () => (await boardKanban()).cards[id]?.lane).toBe('resolved')
  }
  const toasts = pane.getByTestId('kanban-toast')
  await expect(toasts).toHaveCount(2)
  await expect(toasts.nth(0)).toContainText('Moved to Resolved. The task is still open.')
  // The pointer over the stack holds both past their 8s.
  await pane.getByTestId('kanban-toasts').hover()
  await page.waitForTimeout(9_000)
  await expect(toasts).toHaveCount(2)
  const stillOpen = toasts.filter({ hasText: 'The task is still open.' })
  await expect(stillOpen).toHaveCount(2)
  // The newest is on top: its Complete task completes the second card only.
  await toasts.nth(0).getByTestId('kanban-toast-complete').click()
  await pollUntil('second card complete', async () => (await call<{ task: { phase: string } }>(api, 'GET', `/api/tasks/${b}`)).task.phase, (p) => p === 'COMPLETE')
  expect((await call<{ task: { phase: string } }>(api, 'GET', `/api/tasks/${a}`)).task.phase).not.toBe('COMPLETE')
  // The first card's toast is still there (the complete adds its own `Completed` toast on top).
  await expect(stillOpen).toHaveCount(1)
  await stillOpen.getByTestId('kanban-toast-complete').click()
  await pollUntil('first card complete', async () => (await call<{ task: { phase: string } }>(api, 'GET', `/api/tasks/${a}`)).task.phase, (p) => p === 'COMPLETE')
  await expect(stillOpen).toHaveCount(0)
  await page.mouse.move(5, 5)
})

test('C89: a stored Page pick opens on Page, Cards is one click away and is remembered, the old Overview pick reads as Cards', async ({ page }) => {
  test.setTimeout(180_000)
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: team.project })
  await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board`, { html: '<h1>Triage page</h1><p>The page the leader wrote.</p>' })
  await page.addInitScript((owner) => {
    if (!sessionStorage.getItem('pw-c89-seeded')) {
      localStorage.setItem(`walnut:board-view.v1:${owner}`, 'custom')
      sessionStorage.setItem('pw-c89-seeded', '1')
    }
  }, team.leader)
  const pane = await openBoard2(page)
  await expect(pane.getByTestId('board-view-custom')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(pane.locator('.task-board-frame')).toBeVisible()
  await expect(pane.getByTestId('board-view-custom')).toHaveText('Page')
  await expect(pane.getByTestId('board-view-custom')).toHaveAttribute('title', 'The page the leader wrote for this team')
  // This team's leader defined no board projects: the bar offers Cards and Page only.
  await expect(pane.getByTestId('board-view-projects')).toHaveCount(0)
  await expect(pane.getByTestId('board-view-cards')).toHaveText(/^Cards/)
  await pane.getByTestId('board-view-cards').click()
  await expect(pane.getByTestId('board-kanban')).toBeVisible()
  expect(await page.evaluate((o) => localStorage.getItem(`walnut:board-view.v1:${o}`), team.leader)).toBe('cards')
  // The pick from before the kanban ('overview', the project board) shows Cards on a board with no projects.
  await page.evaluate((o) => localStorage.setItem(`walnut:board-view.v1:${o}`, 'overview'), team.leader)
  const again = await openBoard2(page)
  await expect(again.getByTestId('board-view-cards')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
  await expect(again.getByTestId('board-kanban')).toBeVisible()
})

/** openBoard for a stored Page pick: waits for the pane, not for the kanban (Page shows instead). */
async function openBoard2(page: Page): Promise<Locator> {
  await openHome(page)
  const row = page.locator(`.todo-panel-item[data-task-id="${team.leader}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await panel.getByTestId('session-board-chip').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}

test.describe('layout C, a 520px window', () => {
  test.use({ viewport: { width: 520, height: 800 } })

  test('C52: the Board opens with the chat collapsed and a Show chat button; once shown, the chat stays', async ({ page }, info) => {
    await isolateUiPrefs(page)
    await presetPanelView(page, { section: 'all', project: team.project })
    const pane = await openBoard2(page)
    const root = pane.getByTestId('kanban-root')
    await expect(root).toBeVisible({ timeout: 30_000 })
    await expect(pane.getByTestId('board-kanban')).toHaveAttribute('data-mode', 'narrow')
    const chat = page.locator('.session-panel-split.is-changed-open .session-panel-chat-col')
    await expect(page.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(1)
    await expect.poll(() => root.evaluate((e) => e.clientWidth)).toBeGreaterThanOrEqual(480)
    // Narrow mode never scrolls sideways.
    expect(await root.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= document.scrollingElement!.clientWidth + 1)).toBe(true)
    const show = page.getByTestId('kanban-show-chat')
    await expect(show).toBeVisible()
    await expect(show).toHaveText('Show chat')
    await shot(page, 'narrow-light', info)
    await page.emulateMedia({ colorScheme: 'dark' })
    // Let the lane background transitions settle before the shot.
    await page.waitForTimeout(400)
    await shot(page, 'narrow-dark', info)
    await page.emulateMedia({ colorScheme: 'light' })
    await show.click()
    await expect(chat).toBeVisible()
    await expect(page.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(0)
    await expect(page.getByTestId('kanban-show-chat')).toHaveCount(0)
    // Close the Board and open it again: the user's pick wins, no second collapse.
    const panel = page.locator(`${REAL_PANEL}[data-session-id="${team.leaderSid}"]`)
    await panel.getByTestId('session-board-chip').click()
    await expect(pane).toHaveCount(0)
    await panel.getByTestId('session-board-chip').click()
    await expect(page.getByTestId('task-board-pane')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.locator('.session-panel-split.is-chat-collapsed')).toHaveCount(0)
    await expect(chat).toBeVisible()
  })
})

test('C20: the last lane cannot be deleted, nor the last Done lane', async ({ page }) => {
  const before = (await boardKanban()).lanes_effective
  try {
    const pane = await openBoard(page)
    await expandRail(pane)
    const done = await laneMenu(page, pane, 'resolved')
    await expect(done.getByTestId('kanban-lane-menu-delete')).toHaveAttribute('aria-disabled', 'true')
    await expect(done.getByTestId('kanban-lane-menu-delete')).toHaveAttribute('title', 'A board keeps one Done lane')
    // A blocked row ignores its click: no confirm, the menu stays.
    await done.getByTestId('kanban-lane-menu-delete').click({ force: true })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(done).toBeVisible()
    for (const k of ['todo', 'active', 'wait', 'review']) {
      await expect(done.getByTestId(`kanban-lane-menu-kind-${k}`)).toHaveAttribute('aria-disabled', 'true')
    }
    await expect(done.getByTestId('kanban-lane-menu-complete-on-drop')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('kanban-lane-menu')).toHaveCount(0)
    await expect(laneHead(pane, 'resolved').getByTestId('kanban-lane-kebab')).toBeFocused()
    // One lane left (a direct write): its Delete says a board keeps one.
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/lanes`, { lanes: before.filter((l) => l.kind === 'done') })
    await expect.poll(() => laneIds(pane)).toEqual(['resolved'])
    const only = await laneMenu(page, pane, 'resolved')
    await expect(only.getByTestId('kanban-lane-menu-delete')).toHaveAttribute('aria-disabled', 'true')
    await expect(only.getByTestId('kanban-lane-menu-delete')).toHaveAttribute('title', 'A board keeps at least one lane')
    await expect(only.getByTestId('kanban-lane-menu-left')).toHaveAttribute('aria-disabled', 'true')
    await expect(only.getByTestId('kanban-lane-menu-right')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
  } finally {
    await call(api, 'PUT', `/api/v1/tasks/${team.leader}/board/lanes`, { lanes: before })
  }
})
