/**
 * The session header after the user's three asks of 2026-11-19:
 *  - Watch moved out of the ⋮ menu to the header ("put this outside, kind of often
 *    used"): a pill on the title row, "Watch" / "Watching", pressed while watched
 *    (WatchPill, web/src/components/tasks/WatchToggle.tsx). The session menu has no
 *    Watch row (a phone keeps it: phone-session.spec.ts).
 *  - Open in new tab is the ⋮ menu's Window row only ("open in new tab can be added
 *    into drop down"): no header button.
 *  - No Scripts chip ("it si fine, remove it no need").
 *
 * Scenario matrix (real fixture server, mock CLI sessions, real clicks):
 *  A. a task with a session: Watch not pressed; the menu has no Watch row and holds
 *     Window > Open in new tab; no Scripts and no new-tab button in the header;
 *  B. Watch: it reads Watching, pressed, the task's row is in the task panel's Watching
 *     section (the first section), and the server task has watched_at;
 *  C. Watch again: back to Watch, the row leaves Watching, watched_at cleared;
 *  D. a narrow column: the pill is the eye alone (its name in the label) and toggles;
 *  E. a session with no task: no Watch pill.
 * A task whose subtasks are all done and that keeps a Board of its own gets no Board
 * chip: session-board-tab-lead-only.spec.ts case E proves it, so it is not repeated here.
 *
 * Runs in Chromium and, with PW_WEBKIT=1 --project webkit, in WebKit (the Mac app).
 * Screenshots: WATCH_SHOT_DIR (default /tmp/session-header-watch).
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { openKebabGroup } from './kebab-group-helpers'
import { closeSessionKebab, openSessionKebab } from './session-kebab-helpers'
import { openSessionFromFinder } from './session-finder-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, startSession, type KanbanApi } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SHOTS = process.env.WATCH_SHOT_DIR ?? '/tmp/session-header-watch'
/** The fixture's session with no task (test-server.ts), found by its title in the session finder. */
const TASKLESS = { id: '2532066a-e210-4702-be34-ed01008adbde', query: 'Deep link primary session' }
const litter: string[] = []
let api: KanbanApi
let project = ''

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial', timeout: 180_000 })

interface Made { id: string; sid: string }
let watched: Made
let narrow: Made

async function withSession(title: string): Promise<Made> {
  const { task } = await call<{ task: { id: string } }>(api, 'POST', '/api/tasks', { title, source: 'local', pinned: false, project })
  litter.push(task.id)
  const sid = await startSession(api, task.id, `snapshot-clean-turn:${title} ready`)
  return { id: task.id, sid }
}

const watchedAt = async (id: string) => (await call<{ task: { watched_at?: string | null } }>(api, 'GET', `/api/tasks/${id}`)).task.watched_at ?? ''

test.beforeAll(async ({}, info) => {
  test.setTimeout(300_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  project = `${info.project.name}-watch-pill ${Date.now().toString(36)}`
  watched = await withSession('Header watch pill task')
  narrow = await withSession('Narrow column watch pill task')
  await fs.mkdir(SHOTS, { recursive: true })
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) {
    await fetch(`${api.base}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
  }
})

/** Home through a real link, scoped to this file's project; the first frame's task list decides the header. */
async function openHome(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project })
  await page.setContent(`<a href="${api.base}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

/** A click on the task's row opens its session as a Home column, its record landed. */
async function openTaskSession(page: Page, t: Made): Promise<Locator> {
  const row = page.locator(`.todo-panel-item[data-task-id="${t.id}"]`).first()
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${t.sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('[data-header-id="files"]')).toBeVisible({ timeout: 30_000 })
  return panel
}

const pill = (panel: Locator) => panel.getByTestId('session-watch-pill')
const watchingSection = (page: Page) => page.locator('#home-task-navigation').getByRole('region', { name: 'Watching' })

async function shootHeader(page: Page, panel: Locator, name: string): Promise<void> {
  const box = await panel.locator('.session-panel-header').boundingBox()
  if (!box) return
  await page.screenshot({
    path: `${SHOTS}/${test.info().project.name}-${name}.png`, animations: 'disabled',
    clip: { x: Math.max(0, box.x - 1), y: Math.max(0, box.y - 1), width: Math.min(box.width + 2, 1280), height: box.height + 2 },
  })
}

/** A Home column held to `px` wide, as a third column or a slim window draws it. */
async function clampColumns(page: Page, px: number): Promise<void> {
  await page.evaluate((width) => {
    document.getElementById('pw-column-clamp')?.remove()
    const style = document.createElement('style')
    style.id = 'pw-column-clamp'
    style.textContent = `.main-page-session-column {
      width: ${width}px !important; max-width: ${width}px !important; min-width: 0 !important; flex: 0 0 ${width}px !important;
    }`
    document.head.appendChild(style)
  }, px)
}

test('A-C: Watch is a header pill; a click watches the task (Watching, at the top of the task panel), a second one stops', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openHome(page)
  const panel = await openTaskSession(page, watched)
  const header = panel.locator('.session-panel-header')

  // ── A. The header: Watch, not pressed, on the title row; no Scripts, no new-tab button ──
  const watch = pill(panel)
  await expect(watch).toBeVisible({ timeout: 30_000 })
  await expect(watch).toHaveText('Watch')
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  await expect(watch).not.toHaveAttribute('data-narrow', 'true')
  await expect(panel.locator('.session-panel-header-top .session-panel-title-meta [data-testid="session-watch-pill"]')).toHaveCount(1)
  await expect(panel.locator('.session-panel-popout')).toHaveCount(0)
  await expect(header.locator('[data-header-id="popout"], [data-header-id="scripts"], [data-testid="session-scripts-chip"]')).toHaveCount(0)
  await expect(header.getByRole('button', { name: /^Scripts/ })).toHaveCount(0)
  await expect(header.getByText('Scripts', { exact: true })).toHaveCount(0)
  expect(await watchedAt(watched.id)).toBe('')
  await shootHeader(page, panel, 'a-header-watch')

  // The ⋮ menu: the task's rows are drawn (Background, Watch's old neighbour), no Watch among them;
  // Window holds Open in new tab.
  const menu = await openSessionKebab(panel)
  await expect(menu.getByTestId('task-kebab-background')).toBeVisible({ timeout: 30_000 })
  await expect(menu.getByTestId('task-kebab-watch')).toHaveCount(0)
  await expect(menu.locator('.task-kebab-item').filter({ hasText: /^(Watch|Stop watching)$/ })).toHaveCount(0)
  const windowRows = await openKebabGroup(menu, 'session-kebab-window')
  await expect(windowRows.getByTestId('session-menu-popout')).toHaveText('Open in new tab')
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-a-kebab-window.png`, animations: 'disabled' })
  await closeSessionKebab(panel)
  await expect(watchingSection(page).locator(`[data-task-id="${watched.id}"]`)).toHaveCount(0)

  // ── B. Watch: Watching, pressed; the row joins Watching, the first section; the server has it ──
  await watch.click()
  await expect(watch).toHaveText('Watching')
  await expect(watch).toHaveAttribute('aria-pressed', 'true')
  await expect(watch).toHaveAccessibleName('Watch')
  const watchedRow = watchingSection(page).locator(`[data-task-id="${watched.id}"]`)
  await expect(watchedRow.first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#home-task-navigation section.status-section').first()).toHaveAttribute('aria-label', 'Watching')
  await expect.poll(() => watchedAt(watched.id), { timeout: 15_000 }).not.toBe('')
  await shootHeader(page, panel, 'b-header-watching')
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-b-watching-section.png`, animations: 'disabled' })

  // ── C. Again: Watch, not pressed; the row leaves Watching; the server clears it ──
  await watch.click()
  await expect(watch).toHaveText('Watch')
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  await expect(watch).toHaveAccessibleName('Watch')
  await expect(watchedRow).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => watchedAt(watched.id), { timeout: 15_000 }).toBe('')
  await shootHeader(page, panel, 'c-header-watch-again')
  expect(errors).toEqual([])
})

test('D: in a narrow column Watch is the eye alone, named in its label, and still toggles', async ({ page }) => {
  await openHome(page)
  const panel = await openTaskSession(page, narrow)
  await clampColumns(page, 460)
  const watch = pill(panel)
  await expect(watch).toHaveAttribute('data-narrow', 'true', { timeout: 15_000 })
  await expect(watch.locator('.session-watch-pill-label')).toHaveCount(0)
  await expect(watch).toHaveText('')
  await expect(watch.locator('svg')).toHaveCount(1)
  await expect(watch).toHaveAccessibleName('Watch')
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  // The eye stays a comfortable target and clear of the title.
  const box = (await watch.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(20)
  expect(box.height).toBeGreaterThanOrEqual(20)
  await shootHeader(page, panel, 'd-narrow-watch')

  await watch.click()
  await expect(watch).toHaveAttribute('aria-pressed', 'true')
  await expect(watch).toHaveAccessibleName('Watch')
  await expect(watch).toHaveAttribute('data-narrow', 'true')
  await expect.poll(() => watchedAt(narrow.id), { timeout: 15_000 }).not.toBe('')
  await expect(watchingSection(page).locator(`[data-task-id="${narrow.id}"]`).first()).toBeVisible({ timeout: 15_000 })
  await shootHeader(page, panel, 'd-narrow-watching')

  await watch.click()
  await expect(watch).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => watchedAt(narrow.id), { timeout: 15_000 }).toBe('')

  // Wide again: the word comes back.
  await page.evaluate(() => document.getElementById('pw-column-clamp')?.remove())
  await expect(watch).not.toHaveAttribute('data-narrow', 'true', { timeout: 15_000 })
  await expect(watch).toHaveText('Watch')
})

test('E: a session with no task has no Watch pill (and no new-tab button or Scripts chip either)', async ({ page }) => {
  await openHome(page)
  const panel = await openSessionFromFinder(page, TASKLESS.query, TASKLESS.id)
  const header = panel.locator('.session-panel-header')
  await expect(header.locator('[data-header-id="close"]')).toBeVisible({ timeout: 30_000 })
  await expect(header.locator('.session-panel-badge', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
  await expect(pill(panel)).toHaveCount(0)
  // Still none a beat later, once everything about the session has landed.
  await page.waitForTimeout(500)
  await expect(pill(panel)).toHaveCount(0)
  await expect(panel.locator('.session-panel-popout')).toHaveCount(0)
  await expect(header.locator('[data-header-id="scripts"], [data-testid="session-scripts-chip"]')).toHaveCount(0)
  await shootHeader(page, panel, 'e-taskless')
})
