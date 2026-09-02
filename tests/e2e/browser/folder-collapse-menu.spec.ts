/**
 * Playwright browser tests: folder rows are CLICKABLE and RIGHT-CLICKABLE.
 *
 * One test per user-visible behaviour layered on top of the folder model
 * (folder-model.spec.ts covers the model itself). Keep this list in step with the
 * tests below; it is expected to keep growing:
 *
 *   1. Main list: clicking the folder header row anywhere (not just the chevron)
 *      folds it. Members hide, the chevron un-rotates, and the fold survives a
 *      reload (localStorage `open-walnut-collapsed-folders`).
 *   2. Pinned tier (By-project view): clicking the folder chip folds it there
 *      too, and BOTH surfaces share one collapse set, so folding in the tier
 *      folds the same folder in the main list.
 *   3. Flat list mode (grouping off): the same folder folds there as well. The
 *      collapse set is global, so every list mode has to be wired to it.
 *   4. Right-click on a folder row opens Walnut's own menu with the folder
 *      actions, and Rename / Delete still work when driven from it.
 *   5. "Move to project…" really moves the folder: the header row re-renders
 *      under the DESTINATION project and its member rows travel with it. Real
 *      round trip, no mocking.
 *   6. An EMPTY folder survives the same move into a project that owns no tasks:
 *      nothing else can make that project's group render, so a folder that lost
 *      its row would simply be gone from the panel.
 *   7. The same flow's REQUEST contract, with the PATCH mocked: exactly one
 *      request, body `{ project: <target> }`.
 *   8. Re-picking the folder's CURRENT project is a dismiss, not a move: the
 *      flyout closes and no PATCH is sent.
 *   9. Picking Inbox sends `{ project: '' }` (Inbox is the absence of a project).
 *  10. A press-and-drag that starts on a MENU row never drags the folder chip,
 *      and never reorders the tier (the ContextMenu pointerdown guard).
 *  11. The empty-folder row carries the same menu, minus the collapse row.
 *
 * Cases 7, 8 and 9 MOCK the PATCH at the network layer (page.route) on purpose:
 * they pin the CLIENT contract, and a mock keeps them independent of whatever a
 * real move would leave behind in the shared fixture data. Cases 5 and 6 are
 * real round trips, so both halves of the feature are covered.
 *
 * All data is unique per run (suffixes), parallel-safe against the shared
 * fixture server, and registered in `litter` so afterEach removes it EVEN AFTER A
 * FAILED ASSERTION: a leaked pin sits in the shared Focus tier and changes the
 * geometry other specs' drag tests measure, and a leaked project group changes
 * what every list spec sees.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

// The gesture helpers below retry for up to 45s on purpose (two overlays that
// dismiss themselves on scroll). Under the config's 30s per-test budget none of
// them could ever exhaust its own loop, so a real failure surfaced as "Test
// timeout of 30000ms exceeded" instead of the message that says what broke.
test.setTimeout(180_000)

/**
 * Sequential inside this file: the fold sets (`walnut-todo-collapsed-folders`,
 * `walnut-todo-collapsed-projs`) are single localStorage keys that ui-prefs-sync
 * mirrors to the fixture SERVER and merges back at boot, last-writer-wins per key.
 * Two tests folding in parallel overwrite each other's whole set, and the test that
 * reloads to prove the fold PERSISTED comes back with the other one's value.
 * `default` rather than `serial` so one failure does not abandon the rest of the file.
 */
test.describe.configure({ mode: 'default' })

/** Everything this file creates. Module scope is per WORKER; beforeEach resets it. */
const litter: { tasks: string[]; folders: string[]; projects: string[] } = { tasks: [], folders: [], projects: [] }

function trackProject(name: string): void {
  if (name && !litter.projects.includes(name)) litter.projects.push(name)
}

test.beforeEach(() => {
  litter.tasks = []
  litter.folders = []
  litter.projects = []
})

/**
 * The fold sets are mirrored to the SHARED fixture server, and a fresh Playwright
 * context adopts whatever another spec FILE last wrote there (the note on
 * isolateUiPrefs has the mechanism). Serializing inside this file, as configured
 * above, does nothing about that: project-collapse-menu.spec.ts drives the same two
 * keys and runs in PARALLEL with this file. Keep the fold local to each context.
 */
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tasks) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const gid of litter.folders) {
    await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  }
  // Registry rows last: deleting a project moves its remaining tasks to the Inbox.
  for (const name of litter.projects) {
    await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
  }
})

async function createTaskViaApi(title: string, opts: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  litter.tasks.push(body.task.id)
  if (typeof opts.project === 'string') trackProject(opts.project)
  return body.task
}

async function createFolderViaApi(taskIds: string[], label: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, label }),
  })
  if (!res.ok) throw new Error(`folder create failed: ${res.status} ${await res.text()}`)
  const gid = ((await res.json()) as { group_id: string }).group_id
  litter.folders.push(gid)
  return gid
}

/** An EMPTY folder (no members yet), the row the picker cases start from. */
async function createEmptyFolderViaApi(label: string, project: string): Promise<string> {
  const res = await fetch(`${API}/api/tasks/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, project }),
  })
  expect(res.status).toBe(201)
  const gid = ((await res.json()) as { group_id: string }).group_id
  litter.folders.push(gid)
  trackProject(project)
  return gid
}

/** Registry row for a project with NO tasks (the picker is registry-backed). */
async function createProjectViaApi(name: string): Promise<void> {
  const res = await fetch(`${API}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!res.ok) throw new Error(`project create failed: ${res.status} ${await res.text()}`)
  trackProject(name)
}

/** The folder's server-side owning project ('' = Inbox). */
async function folderProjectViaApi(groupId: string): Promise<string | undefined> {
  const res = await fetch(`${API}/api/tasks/groups`)
  const body = (await res.json()) as { groups: Array<{ group_id: string; project?: string }> }
  return body.groups.find((g) => g.group_id === groupId)?.project
}

async function pinToFocusViaApi(taskId: string): Promise<void> {
  const pin = await fetch(`${API}/api/focus/tasks/${taskId}`, { method: 'POST' })
  if (!pin.ok) throw new Error(`pin failed: ${pin.status} ${await pin.text()}`)
  const tier = await fetch(`${API}/api/focus/tasks/${taskId}/tier`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'focus' }),
  })
  if (!tier.ok) throw new Error(`tier failed: ${tier.status} ${await tier.text()}`)
}

/** The main list's folder header row (NOT the pinned tier's chip). */
function listHeader(page: Page, groupId: string) {
  return page.locator(`.todo-group-project .task-group-chip[data-group-id="${groupId}"]`).first()
}

/** The pinned Focus tier's folder chip. */
function tierChip(page: Page, groupId: string) {
  return page.locator(`[data-drop-zone="focus-drop-zone"] .task-group-chip[data-group-id="${groupId}"]`).first()
}

/** One project's group in the main list, located by its header name. */
function projectBucket(page: Page, project: string) {
  return page.locator('.todo-group-project').filter({
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${project}$`) }),
  })
}

/**
 * Intercept `PATCH /api/tasks/folders/<id>` and record the bodies, answering with
 * a plausible success. Returns the (growing) list, so a spec can assert both the
 * body contract and "no request at all". Non-PATCH calls fall through untouched.
 */
async function mockFolderPatch(page: Page, groupId: string, project: string): Promise<unknown[]> {
  const bodies: unknown[] = []
  await page.route(`**/api/tasks/folders/${groupId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    bodies.push(route.request().postDataJSON())
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ group_id: groupId, project, moved_task_ids: [], moved_folder_ids: [] }),
    })
  })
  return bodies
}

/**
 * Right-click a folder row and CLICK one of its menu items, retrying the WHOLE
 * gesture (see openFolderMenu for why the menu can vanish under you: it dismisses
 * itself on any scroll, and the fixture list settle-scrolls after load, which
 * detaches an item between "visible" and "clicked").
 */
async function clickFolderMenuItem(page: Page, row: Locator, item: string): Promise<void> {
  const menu = page.locator('[data-testid="folder-ctx-menu"]')
  await expect(async () => {
    await row.click({ button: 'right' })
    const entry = menu.getByRole('menuitem', { name: item })
    await expect(entry).toBeVisible({ timeout: 2_000 })
    await entry.click({ timeout: 2_000 })
    // The menu closes on select, which is the signal the click actually landed.
    await expect(menu).toHaveCount(0, { timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
}

/** One option row by EXACT name (the filter box only appears past 6 projects). */
function pickerOption(page: Page, flyout: Locator, name: string): Locator {
  return flyout.locator('.task-kebab-project-opt').filter({
    has: page.locator('.task-kebab-project-opt-name', { hasText: new RegExp(`^${name}$`) }),
  }).first()
}

/**
 * Right-click the folder, open "Move to project…", and pick an option — the WHOLE
 * chain retried as one gesture.
 *
 * Both overlays dismiss themselves on ANY scroll by design (each is anchored to a
 * frozen cursor point), and the fixture's list settle-scrolls for a moment after
 * load, so either the menu row or the picker option can detach between "visible"
 * and "clicked". The flyout closing is the signal the pick actually landed, so a
 * retry only ever repeats a gesture that did NOT reach the server.
 */
async function pickFolderProject(
  page: Page,
  row: Locator,
  pick: (flyout: Locator) => Locator,
  opts: { filter?: string; beforePick?: (flyout: Locator) => Promise<void> } = {},
): Promise<void> {
  const flyout = page.locator('.task-kebab-project-flyout')
  await expect(async () => {
    await clickFolderMenuItem(page, row, 'Move to project…')
    await expect(flyout).toBeVisible({ timeout: 3_000 })
    const filter = flyout.locator('.task-kebab-project-filter')
    if (opts.filter && (await filter.count())) await filter.fill(opts.filter)
    await opts.beforePick?.(flyout)
    const option = pick(flyout)
    await expect(option).toBeVisible({ timeout: 2_000 })
    await option.click({ timeout: 2_000 })
    await expect(flyout).toHaveCount(0, { timeout: 3_000 })
  }).toPass({ timeout: 45_000 })
}

/**
 * Right-click a folder row and wait for the menu, RETRYING the gesture.
 *
 * ContextMenu dismisses itself on any scroll by design (a cursor anchor is a
 * frozen viewport point, so after a scroll it no longer describes its row). The
 * fixture's task list can still settle-scroll for a moment after load, which
 * closes a menu that did open — retrying the gesture is the honest way to test
 * the menu without pinning the scroll behaviour we deliberately want.
 */
async function openFolderMenu(page: Page, row: Locator, anItem: string) {
  const menu = page.locator('[data-testid="folder-ctx-menu"]')
  await expect(async () => {
    await row.click({ button: 'right' })
    await expect(menu.getByRole('menuitem', { name: anItem })).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  return menu
}

test('main list: clicking the folder header row body folds it, and the fold survives a reload', async ({ page }) => {
  const project = `FoldRowProj${Date.now().toString(36)}`
  const a = await createTaskViaApi('Fold row member A', { project })
  const b = await createTaskViaApi('Fold row member B', { project })
  const groupId = await createFolderViaApi([a.id, b.id], `Foldable ${Date.now().toString(36)}`)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const header = listHeader(page, groupId)
  const rowA = page.locator(`.todo-group-project .todo-panel-item[data-task-id="${a.id}"]`).first()
  const rowB = page.locator(`.todo-group-project .todo-panel-item[data-task-id="${b.id}"]`).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()
  await expect(header.locator('.collapse-chevron')).toHaveClass(/expanded/)

  // Click the row BODY (the member count), not the chevron and not the label.
  await header.locator('.task-group-chip-count').click()

  await expect(rowA).toBeHidden()
  await expect(rowB).toBeHidden()
  // The header row itself stays — it is what you click to unfold.
  await expect(header).toBeVisible()
  await expect(header.locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/list-folder-collapsed.png' })

  // Persisted: a reload comes back folded.
  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(listHeader(page, groupId)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator(`.todo-group-project .todo-panel-item[data-task-id="${a.id}"]`).first()).toBeHidden()

  // The header row carries the same right-click menu, worded for the CURRENT
  // state — folded right now, so the row reads "Expand folder".
  const menu = await openFolderMenu(page, listHeader(page, groupId), 'Expand folder')
  // A main-list folder is not in the Focus area, so it offers no hide row.
  await expect(menu.getByRole('menuitem', { name: 'Hide from Focus' })).toHaveCount(0)

  // Unfold from the menu (re-opened by the helper, which retries the gesture).
  await clickFolderMenuItem(page, listHeader(page, groupId), 'Expand folder')
  await expect(page.locator(`.todo-group-project .todo-panel-item[data-task-id="${a.id}"]`).first()).toBeVisible()

})

test('pinned tier: clicking the folder chip folds it, and the main list folds with it', async ({ page }) => {
  const project = `FoldTierProj${Date.now().toString(36)}`
  const a = await createTaskViaApi('Fold tier member A', { project })
  const b = await createTaskViaApi('Fold tier member B', { project })
  const groupId = await createFolderViaApi([a.id, b.id], `TierFoldable ${Date.now().toString(36)}`)
  await pinToFocusViaApi(a.id)
  await pinToFocusViaApi(b.id)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const chip = tierChip(page, groupId)
  const cardA = page.locator(`[data-drop-zone="focus-drop-zone"] [data-task-id="${a.id}"]`).first()
  const cardB = page.locator(`[data-drop-zone="focus-drop-zone"] [data-task-id="${b.id}"]`).first()
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await expect(cardA).toBeVisible()
  await expect(cardB).toBeVisible()
  // The chip carries the same affordances as the main list header: a chevron + count.
  await expect(chip.locator('.collapse-chevron')).toHaveClass(/expanded/)
  await expect(chip.locator('.task-group-chip-count')).toHaveText('2')
  await page.screenshot({ path: '/tmp/folder-collapse-menu/tier-chip-expanded.png' })

  await chip.locator('.task-group-chip-count').click()

  await expect(cardA).toBeHidden()
  await expect(cardB).toBeHidden()
  await expect(chip).toBeVisible()
  await expect(chip.locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/tier-chip-collapsed.png' })

  // ONE collapse set, two surfaces: the main list folded too.
  await expect(page.locator(`.todo-group-project .todo-panel-item[data-task-id="${a.id}"]`).first()).toBeHidden()
  await expect(listHeader(page, groupId).locator('.collapse-chevron')).not.toHaveClass(/expanded/)

})

test('flat list mode: the folder header still folds (one collapse set, every list mode)', async ({ page }) => {
  const project = `FoldFlatProj${Date.now().toString(36)}`
  const a = await createTaskViaApi('Fold flat member A', { project })
  const b = await createTaskViaApi('Fold flat member B', { project })
  const groupId = await createFolderViaApi([a.id, b.id], `FlatFoldable ${Date.now().toString(36)}`)

  await presetPanelView(page, { section: 'all', project: '' })
  // Grouping OFF: the flat branch renders the same rows without project buckets.
  await page.addInitScript(() => {
    try { localStorage.setItem('walnut-todo-groupBy', 'none') } catch { /* ignore */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const flat = page.locator('.todo-flat-results')
  const header = flat.locator(`.task-group-chip[data-group-id="${groupId}"]`).first()
  const rowA = flat.locator(`.todo-panel-item[data-task-id="${a.id}"]`).first()
  const rowB = flat.locator(`.todo-panel-item[data-task-id="${b.id}"]`).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()
  await expect(header.locator('.collapse-chevron')).toHaveClass(/expanded/)

  await header.locator('.task-group-chip-count').click()

  await expect(rowA).toBeHidden()
  await expect(rowB).toBeHidden()
  await expect(header).toBeVisible()
  await expect(header.locator('.collapse-chevron')).not.toHaveClass(/expanded/)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/flat-folder-collapsed.png' })

})

test('right-click on a folder chip opens the folder menu; Rename and Delete work from it', async ({ page }) => {
  const project = `FoldMenuProj${Date.now().toString(36)}`
  const a = await createTaskViaApi('Menu folder member A', { project })
  const b = await createTaskViaApi('Menu folder member B', { project })
  const label = `MenuFoldable ${Date.now().toString(36)}`
  const groupId = await createFolderViaApi([a.id, b.id], label)
  await pinToFocusViaApi(a.id)
  await pinToFocusViaApi(b.id)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const chip = tierChip(page, groupId)
  await expect(chip).toBeVisible({ timeout: 15_000 })

  const menu = await openFolderMenu(page, chip, 'Rename folder')
  for (const item of ['Rename folder', 'Collapse folder', 'Move to project…', 'Hide from Focus', 'Delete folder']) {
    await expect(menu.getByRole('menuitem', { name: item })).toBeVisible()
  }
  await page.screenshot({ path: '/tmp/folder-collapse-menu/folder-context-menu.png' })

  // Rename through the menu → the app's own prompt modal (never window.prompt).
  const renamed = `${label} renamed`
  await clickFolderMenuItem(page, chip, 'Rename folder')
  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible()
  await modal.locator('input').fill(renamed)
  await modal.getByRole('button', { name: 'Rename' }).click()
  await expect(tierChip(page, groupId)).toContainText(renamed, { timeout: 10_000 })

  // Delete through the menu → the chip goes, the member tasks stay.
  await clickFolderMenuItem(page, tierChip(page, groupId), 'Delete folder')
  await expect(page.locator(`.task-group-chip[data-group-id="${groupId}"]`)).toHaveCount(0, { timeout: 10_000 })
  await expect(page.locator(`[data-task-id="${a.id}"]`).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/folder-collapse-menu/folder-deleted-from-menu.png' })

})

test('"Move to project…" really moves the folder: header + members land under the destination', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const from = `FoldRealFrom${stamp}`
  const target = `FoldRealTo${stamp}`
  const a = await createTaskViaApi('Real move member A', { project: from })
  const b = await createTaskViaApi('Real move member B', { project: from })
  // The destination is a registry row with NO tasks of its own, which is the hard
  // case: the panel only builds a project group for projects that own a displayed
  // task, so the moved folder has to make its destination render.
  await createProjectViaApi(target)
  const groupId = await createFolderViaApi([a.id, b.id], `RealMovable ${stamp}`)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(listHeader(page, groupId)).toBeVisible({ timeout: 15_000 })
  await pickFolderProject(page, listHeader(page, groupId), (f) => pickerOption(page, f, target), {
    filter: target,
    beforePick: async () => { await page.screenshot({ path: '/tmp/folder-collapse-menu/folder-move-project-picker.png' }) },
  })

  // The folder header now renders inside the DESTINATION project's group…
  const dest = projectBucket(page, target)
  await expect(dest.locator(`.task-group-chip[data-group-id="${groupId}"]`)).toBeVisible({ timeout: 15_000 })
  // …its members came along (they carry the new project, so they render there)…
  await expect(dest.locator(`.todo-panel-item[data-task-id="${a.id}"]`)).toBeVisible()
  await expect(dest.locator(`.todo-panel-item[data-task-id="${b.id}"]`)).toBeVisible()
  // …and nothing is left behind in the source project.
  await expect(projectBucket(page, from).locator(`.todo-panel-item[data-task-id="${a.id}"]`)).toHaveCount(0)
  // A move that worked raises no error toast.
  await expect(page.locator('.notification-toast--error', { hasText: 'Action failed' })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/folder-moved-to-project.png' })

  // Server truth, not just the optimistic view.
  expect(await folderProjectViaApi(groupId)).toBe(target)

})

test('an EMPTY folder moved to a project with no tasks still renders, in its new home', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const from = `FoldEmptyFrom${stamp}`
  const target = `FoldEmptyTo${stamp}`
  // The source keeps a task so its group renders; the destination is a bare
  // registry row. With no member tasks to carry the project across, the moved
  // folder itself is the ONLY reason the destination group can exist.
  await createTaskViaApi('Empty move anchor', { project: from })
  await createProjectViaApi(target)
  const groupId = await createEmptyFolderViaApi(`EmptyMovable ${stamp}`, from)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const row = page.locator(`.task-group-chip-empty[data-group-id="${groupId}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await pickFolderProject(page, row, (f) => pickerOption(page, f, target), { filter: target })

  await expect(projectBucket(page, target).locator(`.task-group-chip-empty[data-group-id="${groupId}"]`))
    .toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.notification-toast--error', { hasText: 'Action failed' })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/empty-folder-moved-to-project.png' })
  expect(await folderProjectViaApi(groupId)).toBe(target)

})

test('"Move to project…" sends exactly one PATCH with { project: <target> }', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const project = `FoldMoveFrom${stamp}`
  const target = `FoldMoveTo${stamp}`
  const a = await createTaskViaApi('Move folder member A', { project })
  const b = await createTaskViaApi('Move folder member B', { project })
  // A task in the destination gives it a project-registry row, so it shows up as
  // an option in the picker (which is registry-backed, not task-derived).
  await createTaskViaApi('Destination anchor', { project: target })
  const groupId = await createFolderViaApi([a.id, b.id], `MovableFolder ${stamp}`)
  await pinToFocusViaApi(a.id)
  await pinToFocusViaApi(b.id)

  // Mocked on purpose: this case pins the REQUEST (see the header note).
  const patches = await mockFolderPatch(page, groupId, target)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const chip = tierChip(page, groupId)
  await expect(chip).toBeVisible({ timeout: 15_000 })
  // The picker is its OWN portalled flyout (never inline rows in the menu).
  await pickFolderProject(page, chip, (f) => pickerOption(page, f, target), { filter: target })

  await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1)
  expect(patches[0]).toEqual({ project: target })
  await expect(page.locator('.task-kebab-project-flyout')).toHaveCount(0)

  await page.unroute(`**/api/tasks/folders/${groupId}`)
})

test('re-picking the folder’s current project is a dismiss, not a move (no PATCH)', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const project = `FoldSameProj${stamp}`
  const a = await createTaskViaApi('Same project member A', { project })
  const b = await createTaskViaApi('Same project member B', { project })
  const groupId = await createFolderViaApi([a.id, b.id], `SameProjFolder ${stamp}`)

  // Nothing should reach this route; the counter is how we prove it.
  const patches = await mockFolderPatch(page, groupId, project)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(listHeader(page, groupId)).toBeVisible({ timeout: 15_000 })
  await pickFolderProject(page, listHeader(page, groupId), (f) => f.locator('.task-kebab-project-opt.active'), {
    // The folder's own project is the TICKED row, which is itself the assertion
    // that the panel resolved the owning project at all.
    beforePick: async (f) => {
      const current = f.locator('.task-kebab-project-opt.active')
      await expect(current).toHaveCount(1)
      await expect(current).toContainText(project)
    },
  })

  await expect(page.locator('.task-kebab-project-flyout')).toHaveCount(0)
  // Give a stray request time to appear before declaring there was none.
  await page.waitForTimeout(1_000)
  expect(patches).toHaveLength(0)
  // The folder is untouched, still under its project.
  await expect(projectBucket(page, project).locator(`.task-group-chip[data-group-id="${groupId}"]`)).toBeVisible()

  await page.unroute(`**/api/tasks/folders/${groupId}`)
})

test('picking Inbox moves the folder out of every project — body { project: "" }', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const project = `FoldToInbox${stamp}`
  const a = await createTaskViaApi('To inbox member A', { project })
  const b = await createTaskViaApi('To inbox member B', { project })
  const groupId = await createFolderViaApi([a.id, b.id], `InboxBound ${stamp}`)

  const patches = await mockFolderPatch(page, groupId, '')

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await expect(listHeader(page, groupId)).toBeVisible({ timeout: 15_000 })
  // Inbox is a real option, always first and never filtered away by default.
  await pickFolderProject(page, listHeader(page, groupId), (f) => pickerOption(page, f, 'Inbox'))

  await expect.poll(() => patches.length, { timeout: 10_000 }).toBe(1)
  // '' , not 'Inbox': Inbox is the ABSENCE of a project, and the wire carries that.
  expect(patches[0]).toEqual({ project: '' })

  await page.unroute(`**/api/tasks/folders/${groupId}`)
})

test('pressing and dragging inside the folder menu never drags the folder chip', async ({ page }) => {
  const stamp = Date.now().toString(36)
  const project = `FoldMenuDrag${stamp}`
  const a = await createTaskViaApi('Menu drag member A', { project })
  const b = await createTaskViaApi('Menu drag member B', { project })
  const groupId = await createFolderViaApi([a.id, b.id], `MenuDragFolder ${stamp}`)
  // ONE pinned member is enough for the tier to draw the chip (a folder boxes down
  // to a single member), and the Focus tier is shared fixture state: every extra
  // pinned card shifts the geometry other specs' drag tests measure.
  await pinToFocusViaApi(a.id)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const zone = page.locator('[data-drop-zone="focus-drop-zone"]')
  const chip = tierChip(page, groupId)
  await expect(chip).toBeVisible({ timeout: 15_000 })
  const orderBefore = await zone.locator('[data-task-id]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-task-id')),
  )

  // The chip IS the dnd-kit drag activator, and the menu portals to <body> while
  // still bubbling React events through the chip's component tree — so a press
  // inside the menu would arm a folder drag without ContextMenu's pointerdown guard.
  const menu = await openFolderMenu(page, chip, 'Rename folder')
  const row = menu.getByRole('menuitem', { name: 'Rename folder' })
  const box = await row.boundingBox()
  if (!box) throw new Error('menu row has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 6 })
  // Mid-gesture is where a leaked drag would show, so check before releasing.
  await expect(page.locator('.task-group-chip-dragging')).toHaveCount(0)
  await page.mouse.up()

  await expect(page.locator('.task-group-chip-dragging')).toHaveCount(0)
  // The row itself is wider than 30px, so the browser still counts this as a click
  // on it (Rename opens its modal). That is fine and not what this test is about:
  // what must never happen is the FOLDER arming a drag underneath the menu.
  await page.keyboard.press('Escape')
  await expect(page.locator('.app-modal')).toHaveCount(0)
  const orderAfter = await zone.locator('[data-task-id]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-task-id')),
  )
  expect(orderAfter).toEqual(orderBefore)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/menu-drag-no-folder-drag.png' })

})

test('the empty-folder row has the same right-click menu (no collapse row)', async ({ page }) => {
  const project = `FoldEmptyMenu${Date.now().toString(36)}`
  await createTaskViaApi('Empty folder menu anchor', { project })
  const label = `EmptyMenuFolder ${Date.now().toString(36)}`
  const groupId = await createEmptyFolderViaApi(label, project)

  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const row = page.locator(`.task-group-chip-empty[data-group-id="${groupId}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  const menu = await openFolderMenu(page, row, 'Rename folder')
  await expect(menu.getByRole('menuitem', { name: 'Move to project…' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Delete folder' })).toBeVisible()
  // Nothing to fold: an empty folder has no member rows.
  await expect(menu.getByRole('menuitem', { name: /Collapse folder|Expand folder/ })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/folder-collapse-menu/empty-folder-context-menu.png' })

  await page.keyboard.press('Escape')
})
