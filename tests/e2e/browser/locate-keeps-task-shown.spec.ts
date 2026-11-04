/**
 * A locate always ends with its task drawn and selected, whatever place holds it and whenever it
 * lands there (web/src/components/tasks/locate-hold.ts).
 *
 * 2026-11-02, mail-ask-drawer S4-11: Find on Home opened the place the task was drawn in at that
 * moment, once. The ask's turn ended a second later, its status went Working, then Needs you, then
 * Waiting, and the row went into the folded Waiting section: Home showed no selected row at all. The
 * class is every closed place a locate can leave a task in, at the locate or right after it:
 *
 *   1. a status section it moves into after the locate (Flat), Waiting and Completed both;
 *   2. a turn that ends after the locate (the S4-11 path, through a real session);
 *   3. a task that reaches the browser after the locate, already in a folded section;
 *   4. a project's own Waiting fold in a tier (By project) that a pinned task moves into;
 *   5. a grandchild under two collapsed parents (only the direct parent used to open);
 *   6. a folded folder holding the task;
 *   7. the whole list folded under its Tasks heading in the stacked view;
 *   8. a project the person folded for the active filter (a query keeps its own folds).
 *
 * And the person's own folds stay theirs: a click in the panel ends the hold, so a section they fold
 * after the locate stays folded when the task moves again, and a reload never reopens it.
 *
 * The locate is the `main:locate-task` event every outside Locate sends (`locateTaskOnHome` in
 * web/src/utils/open-session.ts, the session panel's Find on Home button among them); S4-11 in
 * mail-ask-drawer.spec.ts clicks the real button.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { isolateUiPrefs, listProjectHeader, openListProject, presetPanelView } from './todo-panel-helpers'
import { endRunningTurn, interruptTurn, presetPanelDesign, startRunningTurn, statusSectionToggle } from './status-section-helpers'

test.setTimeout(180_000)
// One file, one board: the cases below change sections and folds a sibling would read.
test.describe.configure({ mode: 'default' })

const litter: { tasks: string[]; folders: string[]; projects: string[]; sessions: string[] } = { tasks: [], folders: [], projects: [], sessions: [] }

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.folders = []; litter.projects = []; litter.sessions = []
  // Folds and section states stay in this context (the fixture mirrors ui-prefs to every spec).
  await isolateUiPrefs(page)
})

test.afterEach(async ({ request }) => {
  for (const sid of litter.sessions) await endRunningTurn(request, sid)
  for (const id of litter.tasks) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => undefined)
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
  for (const gid of litter.folders) await request.delete(`/api/tasks/folders/${gid}`).catch(() => undefined)
  for (const name of litter.projects) await request.delete(`/api/projects/${encodeURIComponent(name)}`).catch(() => undefined)
})

async function seed(request: APIRequestContext, title: string, body: Record<string, unknown> = {}, patch: Record<string, unknown> = {}): Promise<string> {
  const res = await request.post('/api/tasks', { data: { title, source: 'local', pinned: false, ...body } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  litter.tasks.push(id)
  if (typeof body.project === 'string' && !litter.projects.includes(body.project)) litter.projects.push(body.project)
  if (Object.keys(patch).length) await setTask(request, id, patch)
  return id
}

async function setTask(request: APIRequestContext, id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await request.patch(`/api/tasks/${id}`, { data: patch })
  expect(res.ok(), await res.text()).toBe(true)
}

async function pinToFocus(request: APIRequestContext, id: string): Promise<void> {
  expect((await request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
  expect((await request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: 'focus' } })).ok()).toBe(true)
}

/** What a session panel's Find on Home sends (locateTaskOnHome). */
async function locate(page: Page, taskId: string): Promise<void> {
  await page.evaluate((id) => { window.dispatchEvent(new CustomEvent('main:locate-task', { detail: { taskId: id } })) }, taskId)
}

/** The task's row, drawn, on screen, and the one selected row of the panel. */
async function expectShownAndSelected(page: Page, taskId: string, timeout = 30_000): Promise<void> {
  const row = page.locator(`#home-task-navigation [data-task-id="${taskId}"]`)
    .and(page.locator('.task-focused, .todo-pinned-card-active'))
  await expect(row).toHaveCount(1, { timeout })
  await expect(row).toBeVisible({ timeout })
  await expect(row).toBeInViewport({ timeout })
  await expect(page.locator('#home-task-navigation .task-focused, #home-task-navigation .todo-pinned-card-active')).toHaveCount(1)
}

async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
}

test.describe('Flat', () => {
  test.beforeEach(async ({ page }) => { await presetPanelDesign(page, 'status') })

  test('a located task stays shown as it moves into folded Waiting, then Completed, and the person folds stay theirs', async ({ page, request }) => {
    const stamp = Date.now()
    const id = await seed(request, `locate moves ${stamp}`, { project: `LocateMoves${stamp}` }, { phase: 'NEED_ACTION' })
    await openHome(page)
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })

    await locate(page, id)
    await expectShownAndSelected(page, id)

    // After the locate, the task parks: Waiting (folded) opens for it.
    await setTask(request, id, { phase: 'WAITING' })
    await expect(page.locator(`[data-testid="status-section-waiting-rows"] [data-task-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 })
    await expectShownAndSelected(page, id)
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'true')

    // And completes: Completed (folded) opens for it.
    await setTask(request, id, { phase: 'COMPLETE' })
    await expect(page.locator(`[data-testid="status-section-done-rows"] [data-task-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 })
    await expectShownAndSelected(page, id)

    // The person folds Completed: a click in the panel, so the hold lets go. The task moving
    // again does not reopen a fold the person made.
    await statusSectionToggle(page, 'done').click()
    await expect(statusSectionToggle(page, 'done')).toHaveAttribute('aria-expanded', 'false')
    await statusSectionToggle(page, 'waiting').click()
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'false')
    await setTask(request, id, { phase: 'WAITING' })
    await expect.poll(async () => ((await (await request.get(`/api/tasks/${id}`)).json()) as { task?: { phase?: string } }).task?.phase).toBe('WAITING')
    await page.waitForTimeout(4_000) // the parking grace (3.15 s) runs out with the row folded away
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator(`#home-task-navigation [data-task-id="${id}"]`)).toHaveCount(0)

    // A reload restores the focus, never the fold the person closed.
    await page.reload()
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    await page.waitForTimeout(1_500)
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'false')
  })

  test('a turn that ends after the locate leaves its task shown wherever it lands', async ({ page, request }) => {
    const stamp = Date.now()
    const id = await seed(request, `locate turn ${stamp}`, { project: `LocateTurn${stamp}` }, { phase: 'IN_PROGRESS' })
    const sid = await startRunningTurn(request, id)
    litter.sessions.push(sid)
    await openHome(page)
    await locate(page, id)
    await expectShownAndSelected(page, id)
    const before = await page.locator(`#home-task-navigation [data-task-id="${id}"]`).first()
      .evaluate((el) => el.closest('[data-testid$="-rows"]')?.getAttribute('data-testid'))
    expect(before).toBe('status-section-working-rows')

    // The turn ends: the task leaves Working (for Needs you, Waiting, or both in turn).
    await interruptTurn(request, sid)
    await expect.poll(async () => page.locator(`#home-task-navigation [data-task-id="${id}"]`).first()
      .evaluate((el) => el.closest('[data-testid$="-rows"]')?.getAttribute('data-testid')).catch(() => null), { timeout: 60_000 })
      .not.toBe('status-section-working-rows')
    // Its user status settles a moment after the turn (the hand-back settle): it stays shown throughout.
    for (let i = 0; i < 6; i++) {
      await expectShownAndSelected(page, id)
      await page.waitForTimeout(1_000)
    }
  })

  test('a task that reaches the browser after the locate, already folded, opens and is selected', async ({ page, request }) => {
    const stamp = Date.now()
    await openHome(page)
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    // Made and parked outside the page, located before (or as) the page hears of it.
    const id = await seed(request, `locate late ${stamp}`, { project: `LocateLate${stamp}`, phase: 'WAITING' })
    await locate(page, id)
    await expectShownAndSelected(page, id)
    await expect(statusSectionToggle(page, 'waiting')).toHaveAttribute('aria-expanded', 'true')
    // It holds like any locate: completed now, it is shown in Completed.
    await setTask(request, id, { phase: 'COMPLETE' })
    await expect(page.locator(`[data-testid="status-section-done-rows"] [data-task-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 })
    await expectShownAndSelected(page, id)
  })
})

test.describe('By project', () => {
  test.beforeEach(async ({ page }) => {
    await presetPanelDesign(page, 'project')
    await presetPanelView(page, { section: 'all' })
  })

  test('a pinned task that moves into its project fold in the tier after the locate stays shown', async ({ page, request }) => {
    const stamp = Date.now()
    const id = await seed(request, `locate tier ${stamp}`, { project: `LocateTier${stamp}` }, { phase: 'NEED_ACTION' })
    await pinToFocus(request, id)
    await openHome(page)
    await locate(page, id)
    await expectShownAndSelected(page, id)

    await setTask(request, id, { phase: 'WAITING' })
    await expect(page.locator(`[data-testid="project-status-folds"] [data-task-id="${id}"]`)).toHaveCount(1, { timeout: 30_000 })
    await expectShownAndSelected(page, id)
  })

  test('a grandchild under two collapsed parents opens both', async ({ page, request }) => {
    const stamp = Date.now()
    const project = `LocateNest${stamp}`
    const top = await seed(request, `locate nest top ${stamp}`, { project })
    const mid = await seed(request, `locate nest mid ${stamp}`, { project, parent_task_id: top })
    const leaf = await seed(request, `locate nest leaf ${stamp}`, { project, parent_task_id: mid })
    await openHome(page)
    await openListProject(page, project)
    // The person collapses both parents (a load opens every parent with open subtasks).
    const chevron = (id: string) => page.locator(`#home-task-navigation [data-task-id="${id}"] .collapse-chevron`).first()
    // Far down a shared board: brought into view first, and clicked again if the list shifted
    // under the first click (WebKit's scroll into view lands while the panel still settles).
    const collapse = async (id: string) => {
      await expect(async () => {
        await chevron(id).scrollIntoViewIfNeeded()
        if (/expanded/.test((await chevron(id).getAttribute('class')) ?? '')) await chevron(id).click({ timeout: 3_000 })
        await expect(chevron(id)).not.toHaveClass(/expanded/, { timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
    }
    await expect(chevron(mid)).toHaveClass(/expanded/, { timeout: 30_000 })
    await collapse(mid)
    await collapse(top)
    await expect(page.locator(`#home-task-navigation [data-task-id="${leaf}"]:visible`)).toHaveCount(0)
    await expect(page.locator(`#home-task-navigation [data-task-id="${mid}"]:visible`)).toHaveCount(0)
    await locate(page, leaf)
    await expectShownAndSelected(page, leaf)
  })

  test('a task in a folded folder unfolds it', async ({ page, request }) => {
    const stamp = Date.now()
    const project = `LocateFolder${stamp}`
    const id = await seed(request, `locate folder ${stamp}`, { project })
    const mate = await seed(request, `locate folder mate ${stamp}`, { project })
    const res = await request.post('/api/tasks/groups', { data: { task_ids: [id, mate], label: `Folded ${stamp}` } })
    expect(res.ok(), await res.text()).toBe(true)
    const gid = ((await res.json()) as { group_id: string }).group_id
    litter.folders.push(gid)
    // The person folded it in the list before this visit.
    await page.addInitScript((key) => {
      if (!sessionStorage.getItem('pw-fold-seeded')) {
        sessionStorage.setItem('pw-fold-seeded', '1')
        localStorage.setItem('open-walnut-folder-folds', JSON.stringify([key]))
      }
    }, `list\u001f${gid}`)
    await openHome(page)
    await expect(page.locator(`.task-group-chip[data-group-id="${gid}"]`).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`#home-task-navigation [data-task-id="${id}"]:visible`)).toHaveCount(0)
    await locate(page, id)
    await expectShownAndSelected(page, id)
  })

  test('the list folded under its Tasks heading opens for a task it holds', async ({ page, request }) => {
    const stamp = Date.now()
    const id = await seed(request, `locate list fold ${stamp}`, { project: `LocateListFold${stamp}` })
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('pw-tasks-fold-seeded')) {
        sessionStorage.setItem('pw-tasks-fold-seeded', '1')
        localStorage.setItem('walnut-todo-collapsed-sections', JSON.stringify(['tasks']))
      }
    })
    await openHome(page)
    await expect(page.locator(`#home-task-navigation [data-task-id="${id}"]:visible`)).toHaveCount(0)
    await locate(page, id)
    await expectShownAndSelected(page, id)
  })

  test('a project folded for the active filter opens for a task it holds', async ({ page, request }) => {
    const stamp = Date.now()
    const project = `LocateQueryFold${stamp}`
    const id = await seed(request, `locate query fold ${stamp}`, { project, priority: 'immediate' })
    // A Priority chip is on: the list keeps its own folds for this query.
    await page.addInitScript(() => {
      localStorage.setItem('walnut-todo-filters', JSON.stringify({
        v: 1, status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION'], projects: [], date: 'now',
        sources: [], priorities: ['immediate'], tagsAny: [], sprints: [],
        time: { basis: 'updated', preset: null, customValue: 24, customUnit: 'hours' },
      }))
    })
    await openHome(page)
    const header = listProjectHeader(page, project)
    await expect(header).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`#home-task-navigation [data-task-id="${id}"]`).first()).toBeVisible({ timeout: 30_000 })
    // The person folds it while the query is on.
    await header.locator('.todo-group-name-btn').click()
    await expect(page.locator(`#home-task-navigation [data-task-id="${id}"]:visible`)).toHaveCount(0)
    await locate(page, id)
    await expectShownAndSelected(page, id)
  })
})
