/**
 * One browser, one PROJECT REGISTRY store: a rename or a Working Dir edit reaches
 * every surface in the same frame, without waiting for the server.
 *
 * The project twin of task-store-same-browser-instant.spec.ts, and the same
 * technique: the write is held at the NETWORK layer, so anything that still rode
 * the round-trip (or its WS echo) fails the sub-second assertions.
 *
 * What regressed before the shared store existed. `useProjectRegistry` was a plain
 * per-consumer fetch hook, so the home panel, the detail pane, the sidebar, the
 * draft column's project picker and the task kebab's "Move to project" list each
 * held their OWN copy, and the only registry event on the bus was
 * `project:created`. Renaming from the group header kebab therefore left the old
 * name in every picker (picking it RE-CREATED the project), left the just-renamed
 * project badged "new", and dropped the favorite star to hollow because
 * `favorites.projects` is keyed by name and the server rewrote it silently. Setting
 * a project's Working Dir reached nothing at all — `projectForDir` and the draft
 * column's folder pill kept the old path until a reload.
 *
 * Test 3 is the other half of the same fix: the /tasks table calls the registry
 * inside a per-ROW project cell, so a per-consumer hook meant one
 * `GET /api/projects` per visible row through the browser's 6-slot fetch gate.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { navigateToTasksPage } from './draft-surface-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

/**
 * How long the write is pinned at the network layer.
 *
 * 6s rather than the 3s the two DOM assertions need: the third surface (the task
 * kebab's project picker) takes three clicks to reach, and every one of them has to
 * happen while the PATCH is still unanswered for the assertion to mean anything.
 * `patchesAnswered` is checked after each surface, so a hold that expired early
 * would fail loudly instead of passing on a server-confirmed name.
 */
const HOLD_MS = 6000
/** How long a same-frame update may take to reach another surface. */
const INSTANT_MS = 700

test.setTimeout(180_000)

/** Everything created here, removed in afterEach even after a failed assertion. */
const litter: { tasks: string[]; projects: string[] } = { tasks: [], projects: [] }

function trackProject(name: string): void {
  if (name && !litter.projects.includes(name)) litter.projects.push(name)
}

test.beforeEach(async ({ page }) => {
  litter.tasks = []
  litter.projects = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tasks) {
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const name of litter.projects) {
    await fetch(`${API}/api/favorites/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
  }
})

async function createTaskViaApi(title: string, opts: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string } }
  litter.tasks.push(body.task.id)
  if (typeof opts.project === 'string') trackProject(opts.project)
  return body.task
}

async function favoriteProjectViaApi(name: string): Promise<void> {
  const res = await fetch(`${API}/api/favorites/projects/${encodeURIComponent(name)}`, { method: 'POST' })
  if (!res.ok) throw new Error(`favorite failed: ${res.status} ${await res.text()}`)
}

/** The registry row's server truth (the thing every consumer is a copy of). */
async function serverProject(name: string): Promise<{ name: string; metadata?: { default_cwd?: string } } | null> {
  const res = await fetch(`${API}/api/projects`)
  const body = (await res.json()) as { projects: { name: string; metadata?: { default_cwd?: string } }[] }
  return body.projects.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null
}

async function taskProjectViaApi(taskId: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/${taskId}`)
  const body = (await res.json()) as { task: { project?: string } }
  return body.task.project ?? ''
}

/** Project grouping ON, so the panel draws project group headers at all. */
async function presetProjectGrouping(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ }
  })
}

function listHeader(page: Page, project: string): Locator {
  return page.locator('.todo-group-project-header').filter({
    has: page.locator('.todo-group-project-name').filter({ hasText: new RegExp(`^${project}$`) }),
  }).first()
}

function detailPane(page: Page): Locator {
  return page.locator('.project-detail-pane')
}

/** Open the project header's kebab and take one of its items. */
async function clickProjectKebabItem(page: Page, project: string, item: string): Promise<void> {
  const header = listHeader(page, project)
  await expect(header).toBeVisible({ timeout: 30_000 })
  await header.hover() // header actions are hover-revealed in a resting list
  await header.locator(`[aria-label="Actions for ${project}"]`).click()
  const menu = page.locator('.task-kebab-menu:visible').last()
  const entry = menu.locator('.task-kebab-item', { hasText: item }).first()
  await expect(entry).toBeVisible({ timeout: 5_000 })
  await entry.click()
}

/**
 * The task kebab's "Move to project" option list — a THIRD registry consumer, and
 * the one whose staleness had teeth: picking a name the registry no longer has
 * re-creates the project.
 */
async function openProjectPicker(page: Page, taskId: string): Promise<Locator> {
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.hover()
  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible').last()
  await expect(menu).toBeVisible({ timeout: 5_000 })
  await menu.locator('.task-kebab-project-current').click()
  const flyout = page.locator('.task-kebab-project-flyout')
  await expect(flyout).toBeVisible({ timeout: 5_000 })
  return flyout
}

test('a project rename from the header kebab reaches the board header, the detail pane and a project picker before the server answers', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const before = `marina${stamp}`
  const after = `acme${stamp}`
  const task = await createTaskViaApi('Project store rename member', { project: before })
  // Favorited on purpose: `favorites.projects` is keyed by NAME, so a rename that
  // only reaches the board would drop the star to hollow for the whole round trip.
  await favoriteProjectViaApi(before)
  trackProject(after)

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const header = listHeader(page, before)
  await expect(header).toBeVisible({ timeout: 30_000 })
  await expect(header.locator('.todo-group-fav-btn')).toHaveText('★')

  // The detail pane is the surface that holds the OLD name in its own state: its
  // host captured `project` when the pane opened and never hears about a rename.
  await header.locator('.todo-group-name-btn').click()
  await expect(detailPane(page)).toBeVisible({ timeout: 15_000 })
  await expect(detailPane(page).locator('.todo-detail-project')).toHaveText(before)

  // Hold every project PATCH at the network layer. The server does not even see
  // the rename until the hold ends, so no WS echo can arrive before it.
  let patchesAnswered = 0
  await page.route('**/api/projects/**', async (route) => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    patchesAnswered++
    await route.continue()
  })

  await clickProjectKebabItem(page, before, 'Rename')
  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await modal.locator('input').fill(after)
  await modal.getByRole('button', { name: 'Rename' }).click()

  // 1. The board group header — it renders `task.project`, so this is the shared
  //    TASK store being patched in the same frame as the registry row.
  await expect(listHeader(page, after)).toBeVisible({ timeout: INSTANT_MS })
  await expect(listHeader(page, before)).toHaveCount(0)
  expect(patchesAnswered, 'the header waited for the server').toBe(0)

  // 2. The detail pane's title, resolved forward from the name its host captured.
  await expect(detailPane(page).locator('.todo-detail-project')).toHaveText(after, { timeout: INSTANT_MS })
  expect(patchesAnswered, 'the detail pane waited for the server').toBe(0)

  // 3. The favorite star stays filled. The server rewrites favorites.projects for
  //    us, but it has not answered yet — a name-keyed list that only re-reads REST
  //    shows a hollow star for the whole round trip.
  await expect(listHeader(page, after).locator('.todo-group-fav-btn')).toHaveText('★')
  expect(patchesAnswered, 'the star waited for the server').toBe(0)

  // 4. A project PICKER on a third surface: the option list must offer the new
  //    name and no longer the old one (picking a dead name re-creates it).
  const flyout = await openProjectPicker(page, task.id)
  await expect(flyout.locator('.task-kebab-project-opt-name', { hasText: new RegExp(`^${after}$`) })).toHaveCount(1)
  await expect(flyout.locator('.task-kebab-project-opt-name', { hasText: new RegExp(`^${before}$`) })).toHaveCount(0)
  expect(patchesAnswered, 'the picker waited for the server').toBe(0)
  await page.screenshot({ path: '/tmp/project-store/rename-instant-three-surfaces.png' })
  await page.keyboard.press('Escape')

  // 5. Let the held PATCH land. The echoes must not undo what the user did.
  await expect.poll(() => patchesAnswered, { timeout: HOLD_MS * 3 }).toBe(1)
  await page.waitForTimeout(1_500)
  await expect(listHeader(page, after)).toBeVisible()
  await expect(listHeader(page, before)).toHaveCount(0)
  await expect(detailPane(page).locator('.todo-detail-project')).toHaveText(after)
  await expect(listHeader(page, after).locator('.todo-group-fav-btn')).toHaveText('★')
  await page.screenshot({ path: '/tmp/project-store/rename-after-server-answered.png' })

  // Server truth, not just the optimistic view.
  expect(await taskProjectViaApi(task.id)).toBe(after)
  expect((await serverProject(after))?.name).toBe(after)
  expect(await serverProject(before)).toBeNull()
  expect(errors).toEqual([])
})

test('a Working Dir set in the detail pane is what the next /api/projects consumer reads, with no reload', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `marinacwd${stamp}`
  await createTaskViaApi('Project store cwd member', { project })
  const newCwd = `/tmp/project-store-${stamp}`

  await presetPanelView(page, { section: 'all', project: '' })
  await presetProjectGrouping(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const header = listHeader(page, project)
  await expect(header).toBeVisible({ timeout: 30_000 })
  await header.locator('.todo-group-name-btn').click()
  const pane = detailPane(page)
  await expect(pane).toBeVisible({ timeout: 15_000 })
  const cwdRow = pane.locator('.detail-setting-row').filter({ hasText: 'Working Dir' })
  await expect(cwdRow.locator('.detail-setting-value')).toHaveText('not set')

  // Hold the metadata PUT; leave the metadata GET alone, because the whole point
  // below is that a fresh consumer's own REST answer is STALE and the store wins.
  let putsAnswered = 0
  await page.route('**/api/projects/**', async (route) => {
    if (route.request().method() !== 'PUT') { await route.continue(); return }
    await new Promise((r) => setTimeout(r, HOLD_MS))
    putsAnswered++
    await route.continue()
  })
  // What the route would tell a fresh consumer while the PUT is in flight.
  const metadataGets: string[] = []
  page.on('response', async (res) => {
    if (res.request().method() !== 'GET') return
    if (!/\/api\/projects\/.*\/metadata/.test(res.url())) return
    try {
      const body = (await res.json()) as { metadata?: { default_cwd?: string } }
      metadataGets.push(body.metadata?.default_cwd ?? '')
    } catch { /* not the JSON this test reads */ }
  })

  await cwdRow.locator('.detail-setting-value').click()
  await cwdRow.locator('.detail-setting-input').fill(newCwd)
  await cwdRow.locator('.detail-setting-input').press('Enter')
  await expect(cwdRow.locator('.detail-setting-value')).toHaveText(newCwd, { timeout: INSTANT_MS })
  expect(putsAnswered, 'the pane waited for the server').toBe(0)

  // A FRESH consumer of the registry: close the pane and open it again. Its own
  // `GET /api/projects/:name/metadata` still answers with the pre-write blob (the
  // PUT has not landed), so a surface keeping a private REST copy shows "not set"
  // here — which is exactly what every other project-reading surface did.
  metadataGets.length = 0
  await pane.locator('.todo-detail-close').click()
  await expect(detailPane(page)).toHaveCount(0)
  await listHeader(page, project).locator('.todo-group-name-btn').click()
  const reopened = detailPane(page).locator('.detail-setting-row').filter({ hasText: 'Working Dir' })
  await expect(reopened.locator('.detail-setting-value')).toHaveText(newCwd, { timeout: INSTANT_MS })
  expect(putsAnswered, 'the re-opened pane waited for the server').toBe(0)
  await expect.poll(() => metadataGets.length, { timeout: 10_000 }).toBeGreaterThan(0)
  expect(metadataGets, 'the fresh consumer\'s own REST answer was NOT stale, so this proves nothing')
    .not.toContain(newCwd)
  await page.screenshot({ path: '/tmp/project-store/cwd-reaches-fresh-consumer.png' })

  // Let the PUT land: the value persists and the server agrees.
  await expect.poll(() => putsAnswered, { timeout: HOLD_MS * 3 }).toBe(1)
  await page.waitForTimeout(1_500)
  await expect(detailPane(page).locator('.detail-setting-row').filter({ hasText: 'Working Dir' })
    .locator('.detail-setting-value')).toHaveText(newCwd)
  expect((await serverProject(project))?.metadata?.default_cwd).toBe(newCwd)
  expect(errors).toEqual([])
})

test('the /tasks table reads the project registry once for the whole table, not once per row', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const project = `marinarows${stamp}`
  for (let i = 0; i < 6; i++) await createTaskViaApi(`Project store row ${i}`, { project })

  // Count the LIST endpoint only ('/api/projects' exactly, never a per-project
  // sub-path): that is the one a per-consumer hook multiplied by the row count.
  let listGets = 0
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') listGets++
    await route.continue()
  })

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

  const afterHome = listGets
  await navigateToTasksPage(page)
  const rows = page.locator('.tp-row[data-task-id]')
  // The premise: MANY rows are on screen, each of which used to fetch for itself.
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(4)
  const rowCount = await rows.count()

  // At most one: the store shares one in-flight request and a fresh-enough list is
  // reused outright, so the usual number here is ZERO.
  const onTasksPage = listGets - afterHome
  expect(onTasksPage,
    `the /tasks table fetched the registry ${onTasksPage}x for ${rowCount} rows`).toBeLessThanOrEqual(1)

  // …and the table's project cells really do have the list (a broken prop would
  // show an empty picker, which no request count could catch).
  const cell = rows.first().locator('[title="Move to project"]')
  await cell.click()
  const popover = page.locator('.tp-proj-popover')
  await expect(popover).toBeVisible({ timeout: 10_000 })
  const filter = popover.locator('.tp-proj-filter')
  if (await filter.count()) await filter.fill(project)
  await expect(popover.locator('.tp-pri-opt', { hasText: project })).toHaveCount(1)
  await page.screenshot({ path: '/tmp/project-store/tasks-table-one-registry-fetch.png' })
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
