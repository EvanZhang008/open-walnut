/**
 * Two gaps the user hit on the draft column (2026-09-23):
 *
 *   1. A task-row ▶ opened a BOUND draft that only knew "Start Task": the
 *      Start Task / Ask Walnut fork every plain draft shows was gated off on
 *      bound drafts, so a task could be handed to a coding agent but never to
 *      the Personal AI. Now the fork renders on a bound draft too, and its Ask
 *      Walnut Start launches an Ask Walnut session ON that task (taskId in the
 *      payload; the task keeps its project; no second task).
 *   2. A draft had no place to pin / date / prioritise before launching except
 *      the folder picker's footer. A BOUND draft's header carries the real task's
 *      kebab (live writes). A plain draft has no header menu at all (2026-09-24):
 *      its launch bar ends in `More`, which opens the same settings popover every
 *      decision chip opens, and whatever is set there shows up as a chip. The Ask
 *      Walnut tab gets a row with just More (and the chips of what the user set).
 *
 * House rules as the sibling draft specs: `page.goto('/')` is the initial load
 * only (loadHome), every later step is a real click, and every task probe is
 * scoped to a unique stamped title because the fixture server is SHARED.
 */

import { test, expect, type Page } from '@playwright/test'
import {
  basenameOf, discoverFixtureRoot, draftComposer, draftCwdPill, draftDecisionChip, draftDecisionChips,
  draftMoreButton, draftPanel, draftPanels, draftProjectPill, draftTaskMenu, isoDay, loadHome, mockQuickParse,
  openAskWalnutDrawer, openDraft, openDraftOnCwd, openDraftSettings, patchClientConfig, tasksTitled,
  watchForbiddenRequests,
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
  // C21: a bound draft's launch bar has no More and no decision chips (the task
  // already exists; its truth is this kebab), and the header kept the real kebab.
  await expect(draftMoreButton(panel)).toHaveCount(0)
  await expect(panel.locator('.draft-decision-chip, .draft-decision-row')).toHaveCount(0)
  await expect(panel.locator('.session-panel-header .draft-task-menu-btn')).toHaveCount(0)
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  await expect(page.locator('[data-testid="draft-task-menu"]')).toHaveCount(0)
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

// ── 3. Plain draft: no header menu; More ends the bar and edits the launch ────

test('a plain draft has no header ⋮; More ends the pills row, sets tier + unread as chips, and the created task carries them', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  await loadHome(page)

  const cwd = `${fixtureRoot}/projects/walnut`
  const panel = await openDraftOnCwd(page, cwd)

  // C1: nothing in the header opens task settings any more.
  const header = panel.locator('.session-panel-header')
  await expect(header.locator('.draft-task-menu-btn')).toHaveCount(0)
  await expect(header.locator('button[aria-label="Task settings"]')).toHaveCount(0)
  // C2: More is the LAST element of the pills row, the button itself.
  const last = await panel.locator('.draft-composer-bar').evaluate((bar) => {
    const el = bar.lastElementChild as HTMLElement | null
    return el ? { tag: el.tagName, cls: el.className, text: el.textContent?.trim(), label: el.getAttribute('aria-label'), popup: el.getAttribute('aria-haspopup') } : null
  })
  expect(last?.tag).toBe('BUTTON')
  expect(last?.cls).toMatch(/\bdraft-more-btn\b/)
  expect(last).toMatchObject({ text: 'More', label: 'Task settings', popup: 'dialog' })
  // A fresh draft shows no decision chip at all (the default Focus is not drawn).
  await expect(draftDecisionChips(panel)).toHaveCount(0)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/05-plain-draft-more.png` })

  const menu = await openDraftSettings(panel, 'more')
  await expect(menu).toHaveAttribute('role', 'dialog')
  await expect(menu).toHaveAttribute('aria-label', 'Task settings')
  await expect(menu.locator('.task-kebab-tier-btn[aria-pressed="true"]')).toHaveCount(0)
  await menu.screenshot({ path: `${SCREENSHOT_DIR}/05b-plain-draft-task-menu.png` })

  // Unread first: a toggle row, so the menu stays open and the chip appears at once.
  await menu.getByRole('button', { name: /Start unread/ }).click()
  await expect(menu).toBeVisible()
  await expect(draftDecisionChip(panel, 'unread')).toHaveText(/Starts unread/)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // More never lights up for edits: the edits are the chips.
  await expect(draftMoreButton(panel)).not.toHaveClass(/draft-more-btn-active/)

  // A tier pick is one synchronous meta write, so a Start right after it carries it.
  await draftComposer(page).fill(`land in backlog, unread ${Date.now()}`)
  await openDraftSettings(panel, 'more')
  await menu.locator('.task-kebab-tier-btn').filter({ hasText: 'Backlog' }).click()
  await expect(menu).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'pinTier')).toHaveText(/Backlog/)
  await expect(draftDecisionChip(panel, 'pinTier').locator('.draft-ai-badge')).toHaveCount(0)
  const launched = page.waitForResponse((res) => res.request().method() === 'POST' && isQuickStart(res.url()))
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

// ── 4. Ask Walnut tab, Fix Walnut, and the chat slot ──────────────────────────

test('the Ask Walnut tab gets a More-only row that never parses; Fix Walnut and the chat slot draft get neither', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await presetPanelView(page, { section: 'all', project: '' })
  // Parse ON (page-local) so "the tab never parses" is a real claim, not the default.
  await patchClientConfig(page, { quickParse: true })
  const parse = await mockQuickParse(page, { pinTier: 'satellite', due_date: isoDay(3) })
  await loadHome(page)

  const panel = await openDraft(page)
  await askWalnutCard(page).click()
  await expect(panel.locator('.session-panel-title')).toHaveText('Ask Walnut')
  // C1 on the tab: still no header settings button.
  await expect(panel.locator('.session-panel-header .draft-task-menu-btn')).toHaveCount(0)
  await expect(panel.locator('.session-panel-header button[aria-label="Task settings"]')).toHaveCount(0)
  // C20: its own row, not the pills row, holding just More.
  const row = panel.locator('.draft-launch-pills.draft-walnut-meta-row')
  await expect(row).toBeVisible()
  await expect(row).not.toHaveClass(/draft-composer-bar/)
  await expect(panel.locator('.draft-composer-bar')).toHaveCount(0)
  await expect(row.locator('button.draft-more-btn')).toHaveText('More')
  await expect(row.locator('.draft-decision-chip')).toHaveCount(0)
  await draftComposer(page).fill('plan my week around the marina launch by friday')
  await page.waitForTimeout(1_200)
  expect(parse.calls, 'typing on the Ask Walnut tab sends no quick-parse').toHaveLength(0)
  await expect(panel.locator('.draft-ai-badge')).toHaveCount(0)

  // A value set through More shows as a chip in the same row (W2).
  const menu = await openDraftSettings(panel, 'more')
  await menu.locator('.task-kebab-date-toggle').filter({ hasText: /Due/ }).click()
  await menu.locator(`.dp-pill[title="${isoDay(1)}"]`).click()
  await expect(draftTaskMenu(page)).toHaveCount(0)
  await expect(draftDecisionChip(panel, 'dueDate')).toHaveText(/Due Tomorrow/)
  await expect(draftDecisionChip(panel, 'dueDate')).not.toHaveClass(/draft-decision-chip-ai/)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/06-ask-walnut-more-row.png` })
  await panel.locator('.session-panel-close').click()
  await expect(draftPanels(page)).toHaveCount(0)

  // C22: the Fix Walnut repair draft has no More and no decision chips.
  const drawer = await openAskWalnutDrawer(page)
  await drawer.locator('[data-testid="ask-walnut-fix"]').click()
  const fix = draftPanel(page)
  await expect(fix).toBeVisible({ timeout: 20_000 })
  await expect(fix.locator('.draft-more-btn')).toHaveCount(0)
  await expect(fix.locator('.draft-decision-chip, .draft-decision-row, .draft-walnut-meta-row')).toHaveCount(0)
  await fix.locator('.session-panel-close').click()
  await expect(draftPanels(page)).toHaveCount(0)

  // C22: the chat slot's fixed walnut draft has no row and no menu.
  const drawer2 = await openAskWalnutDrawer(page)
  await drawer2.locator('[data-testid="ask-walnut-new"]').click()
  const slotDraft = page.locator('[data-testid="ask-walnut-draft"]')
  await expect(slotDraft).toBeVisible({ timeout: 20_000 })
  await expect(slotDraft.locator('.draft-more-btn, .draft-walnut-meta-row, .draft-decision-row')).toHaveCount(0)
  await expect(slotDraft.locator('.draft-task-menu-btn')).toHaveCount(0)
})
