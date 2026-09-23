/**
 * Two gaps the user hit on the draft column (2026-09-23):
 *
 *   1. A task-row ▶ opened a BOUND draft that only knew "Start Task": the
 *      Start Task / Ask Walnut fork every plain draft shows was gated off on
 *      bound drafts, so a task could be handed to a coding agent but never to
 *      the Personal AI. Now the fork renders on a bound draft too, and its Ask
 *      Walnut Start launches an Ask Walnut session ON that task (taskId in the
 *      payload; the task keeps its project; no second task).
 *   2. A draft had no "⋮": since the tier row left the column (2026-09-15) the
 *      only place to pin / date / prioritise before launching was the folder
 *      picker's footer. Now the header carries the same ⋮ a task row has — on a
 *      plain draft it edits the launch meta (DraftTaskMenu), on a bound draft it
 *      is the real task's kebab (live writes).
 *
 * House rules as the sibling draft specs: `page.goto('/')` is the initial load
 * only (loadHome), every later step is a real click, and every task probe is
 * scoped to a unique stamped title because the fixture server is SHARED.
 */

import { test, expect, type Page } from '@playwright/test'
import {
  basenameOf, discoverFixtureRoot, draftComposer, draftCwdPill, draftPanel, draftPanels,
  draftProjectPill, loadHome, openDraftOnCwd, tasksTitled, watchForbiddenRequests,
} from './draft-helpers'
import { expectTaskInTier, pinnedTierOf } from './draft-outcome-helpers'
import { presetPanelView } from './todo-panel-helpers'

const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/task-start-fork'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

// Real CLI spawns (mock CLI) plus round-trips that queue behind the fixture's
// session health monitor — the same budget the sibling specs run on.
test.setTimeout(180_000)
// Serial: every scenario mounts the pinned area of ONE shared fixture.
test.describe.configure({ mode: 'serial' })

const isQuickStart = (url: string) => new URL(url).pathname === '/api/sessions/quick-start'
const askWalnutCard = (page: Page) => draftPanel(page).locator('.draft-intent-card-walnut')
const startTaskCard = (page: Page) => draftPanel(page).locator('.draft-intent-card').filter({ hasText: 'Start Task' })

/** Create a TITLE-ONLY task in the fixture's Walnut folder and return its id. */
async function createTitleOnlyTask(page: Page, title: string, cwd: string): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project: 'Walnut', cwd } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { task: { id: string } }).task.id
}

/** Hover the task's row/card and press its ▶ — the bound-draft entry point. */
async function pressStartOnTask(page: Page, taskId: string): Promise<void> {
  const row = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`).first()
  await expect(row).toBeVisible({ timeout: 25_000 })
  await row.hover()
  await row.locator('.task-start-btn').click()
  await expect(draftPanel(page)).toBeVisible({ timeout: 10_000 })
}

interface TaskProbe { id: string; project?: string; session_id?: string; unread?: boolean; walnut_agent?: boolean }
async function fetchTask(page: Page, id: string): Promise<TaskProbe> {
  const res = await page.request.get(`/api/tasks/${id}`)
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { task: TaskProbe }).task
}

// ── 1. Bound draft offers Ask Walnut, and that Start is an ask ON the task ────

test('task-row ▶ opens a bound draft WITH the Start Task / Ask Walnut fork, and Ask Walnut launches on that task', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const stamp = Date.now()
  const title = `ask walnut about me ${stamp}`
  const cwd = `${fixtureRoot}/projects/walnut`
  const taskId = await createTitleOnlyTask(page, title, cwd)

  const seen = watchForbiddenRequests(page)
  await pressStartOnTask(page, taskId)
  expect(seen, '▶ on a title-only task must not launch anything').toEqual([])

  const panel = draftPanel(page)
  // THE regression: both intent cards render on a bound draft, Start Task
  // pre-selected, the binding still visible.
  await expect(startTaskCard(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(askWalnutCard(page)).toBeVisible()
  await expect(panel.locator('.draft-bound-task')).toContainText(title)
  await expect(panel.locator('.draft-quick-hint')).toContainText('Start a session on this task')
  await expect(draftCwdPill(panel)).toContainText(basenameOf(cwd))
  // Element shots: the column sits at the right edge of a 2400px viewport, so
  // a page clip would miss it.
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/01-bound-draft-with-fork.png` })

  // Switch to Ask Walnut: the header says so, the binding survives, the generic
  // "plan my day" seeds stay away (this column is about ONE task), and Start ↵
  // is still there (an empty composer sends the title).
  await askWalnutCard(page).click()
  await expect(askWalnutCard(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(panel.locator('.session-panel-title')).toHaveText('Ask Walnut')
  await expect(panel.locator('.draft-bound-task')).toContainText(title)
  await expect(panel.locator('.draft-quick-hint')).toContainText('Ask Walnut about this task')
  await expect(panel.locator('.draft-walnut-suggests')).toHaveCount(0)
  await expect(panel.locator('.draft-start-btn')).toBeVisible()
  // Walnut mode has no folder/project pills (the server owns both) — and the
  // "create task for later" exit stays gone: this draft already IS a task.
  await expect(panel.locator('.draft-later-btn')).toHaveCount(0)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/02-bound-draft-ask-walnut.png` })

  // Round trip back and forth: the tab switch must not lose the binding.
  await startTaskCard(page).click()
  await expect(panel.locator('.session-panel-title')).toHaveText('New Session')
  await expect(panel.locator('.draft-bound-task')).toContainText(title)
  await askWalnutCard(page).click()
  await expect(panel.locator('.session-panel-title')).toHaveText('Ask Walnut')

  const launch = page.waitForRequest((req) => req.method() === 'POST' && isQuickStart(req.url()))
  await panel.locator('.draft-start-btn').click()
  const payload = (await launch).postDataJSON() as {
    taskId?: string; message?: string; cwd?: string; walnutAgent?: boolean; project?: string; sessionId?: string
  }
  // THE assertions: an Ask Walnut launch that REUSES the row's task.
  expect(payload.walnutAgent).toBe(true)
  expect(payload.taskId).toBe(taskId)
  expect(payload.message).toBe(title)
  expect(payload.cwd ?? '').toBe('')
  // The task's own project rides along — never re-filed under "Ask Walnut".
  expect(payload.project).toBe('Walnut')

  await expect(draftPanels(page)).toHaveCount(0)
  // Column-scoped: once the task is an ask, the chat slot may show the same
  // session too (it defaults to the newest ask when nothing is persisted).
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${payload.sessionId}"]`))
    .toBeVisible({ timeout: 30_000 })

  // Still exactly one task with this stamp, it is the bound one, it kept its
  // project, and it now owns the session.
  await expect.poll(async () => (await tasksTitled(page, `${stamp}`)).length,
    { timeout: 15_000, message: 'an Ask Walnut launch on a bound draft must not mint a second task' }).toBe(1)
  await expect.poll(async () => (await fetchTask(page, taskId)).project, { timeout: 10_000 }).toBe('Walnut')
  await expect.poll(async () => (await fetchTask(page, taskId)).session_id, { timeout: 15_000 }).toBe(payload.sessionId)
  // It is a Personal-AI task now: every Ask Walnut behaviour (amber title, the
  // chat slot's asks list, launch memory, persona repair) keys on this marker.
  expect((await fetchTask(page, taskId)).walnut_agent).toBe(true)
  // The session record says the same project as the task (server-side fix:
  // an existing task's record is stamped with the task's project, not the
  // launch payload's).
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${payload.sessionId}`)
    if (!res.ok()) return `status-${res.status()}`
    return ((await res.json()) as { session?: { project?: string } }).session?.project
  }, { timeout: 15_000 }).toBe('Walnut')
  await page.locator(`.main-page-session-column .session-panel[data-session-id="${payload.sessionId}"]`)
    .screenshot({ path: `${SCREENSHOT_DIR}/03-bound-ask-started.png` })
})

// ── 2. Bound draft ⋮ = the real task's kebab (live writes, no launch) ─────────

test('a bound draft\'s header ⋮ pins the REAL task without launching anything', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const stamp = Date.now()
  const title = `pin me from the draft ${stamp}`
  const taskId = await createTitleOnlyTask(page, title, `${fixtureRoot}/projects/walnut`)
  // A REST-created task is pinned to the pinned default, Satellite (no
  // focus_tier) — the pick below must MOVE it somewhere else.
  await expectTaskInTier(page, taskId, 'satellite')

  await pressStartOnTask(page, taskId)
  const panel = draftPanel(page)
  const seen = watchForbiddenRequests(page)

  // The header ⋮ appears once the task fetch lands (TaskQuickActions).
  const kebab = panel.locator('.session-panel-header .task-kebab-btn')
  await expect(kebab).toBeVisible({ timeout: 10_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  // The pin row shows the task's CURRENT tier lit — this is the real task's menu.
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveText(/Satellite/)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/04-bound-draft-header.png` })
  await menu.screenshot({ path: `${SCREENSHOT_DIR}/04b-bound-draft-kebab-menu.png` })

  await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Backlog' }).click()
  await expect(menu).toHaveCount(0)
  await expectTaskInTier(page, taskId, 'backlog')
  // Nothing launched, nothing created: the ⋮ is task settings, not Start.
  expect(seen).toEqual([])
  await expect(draftPanels(page)).toHaveCount(1)

  // Reopen: the menu reflects the write it just made.
  await kebab.click()
  await expect(page.locator('.task-kebab-menu .task-kebab-tier-btn[aria-pressed="true"]')).toHaveText(/Backlog/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)

  // Move the task through the same ⋮ (a live write). The draft's project pill
  // was seeded once at ▶; it must follow the task, not keep promising Walnut.
  await expect(draftProjectPill(panel)).toHaveText('Walnut')
  await kebab.click()
  await page.locator('.task-kebab-menu .task-kebab-project-current').click()
  await page.locator('.task-kebab-project-flyout .task-kebab-project-opt').filter({ hasText: /^\s*Ideas\s*$/ }).click()
  await expect.poll(async () => (await fetchTask(page, taskId)).project, { timeout: 10_000 }).toBe('Ideas')
  await expect(draftProjectPill(panel)).toHaveText('Ideas', { timeout: 10_000 })
  expect(seen).toEqual([])

  // Discard the draft; the task keeps its new tier and project.
  await panel.locator('.session-panel-close').click()
  await expect(draftPanels(page)).toHaveCount(0)
  expect(await pinnedTierOf(page, taskId)).toBe('backlog')
  expect((await fetchTask(page, taskId)).project).toBe('Ideas')
})

// ── 3. Plain draft ⋮ = launch meta; the created task lands with it ───────────

test('a plain draft\'s header ⋮ sets tier + unread on the launch meta, and the created task carries them', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const cwd = `${fixtureRoot}/projects/walnut`
  const panel = await openDraftOnCwd(page, cwd)

  const kebab = panel.locator('.draft-task-menu-btn')
  await expect(kebab).toBeVisible()
  // Fresh draft: default meta, so the trigger is NOT lit.
  await expect(kebab).not.toHaveClass(/active/)
  await kebab.click()
  const menu = page.locator('[data-testid="draft-task-menu"]')
  await expect(menu).toBeVisible()
  // Focus is the launcher default (DEFAULT_META) and shows as the lit tier.
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveText(/Focus/)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/05-plain-draft-header.png` })
  await menu.screenshot({ path: `${SCREENSHOT_DIR}/05b-plain-draft-task-menu.png` })

  // Unread first (the menu stays open for a toggle row), then Esc.
  await menu.getByRole('button', { name: /Start marked unread/ }).click()
  await expect(menu.getByRole('button', { name: /Starts unread/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // The trigger lights up: this draft now carries edits.
  await expect(kebab).toHaveClass(/active/)

  // Clicking the lit tier unpins (same grammar as a task row).
  await kebab.click()
  await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Focus' }).click()
  await expect(menu).toHaveCount(0)
  await kebab.click()
  await expect(menu.locator('.task-kebab-tier-label')).toHaveText('Pin to')
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveCount(0)

  // Re-pin from the unpinned state and Start IMMEDIATELY. The row kebab's grammar
  // (pin now, set the tier 100ms later) would lose this race: the launch would
  // read the unpinned meta and the late tier write would hit a draft that is
  // already gone. A draft's pin is one synchronous meta write, so it can't.
  // The composer is filled first so nothing sits between the pick and Start.
  await page.keyboard.press('Escape')
  await draftComposer(page).fill(`land in backlog, unread ${Date.now()}`)
  await kebab.click()
  // The RESPONSE names the task the launch created (a quick-start task's title
  // is a placeholder until the background namer runs, so the message text is
  // not a handle to find it by).
  const launched = page.waitForResponse((res) => res.request().method() === 'POST' && isQuickStart(res.url()))
  await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Backlog' }).click()
  await panel.locator('.draft-start-btn').click()
  const res = await launched
  expect(res.ok(), await res.text()).toBe(true)
  const payload = res.request().postDataJSON() as {
    taskMeta?: { pinTier?: string | null; unread?: boolean }; sessionId?: string
  }
  expect(payload.taskMeta?.pinTier).toBe('backlog')
  expect(payload.taskMeta?.unread).toBe(true)
  const created = ((await res.json()) as { taskId: string }).taskId

  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${payload.sessionId}"]`))
    .toBeVisible({ timeout: 30_000 })
  await expectTaskInTier(page, created, 'backlog')
  await expect.poll(async () => (await fetchTask(page, created)).unread, { timeout: 10_000 }).toBe(true)
})
