/**
 * A folder's and a project's right-click menus carry the task menu's settings group: Pinned
 * (tier pills), Project, and each plugin field (Sprint). On a group they act on its OPEN tasks.
 *
 *   1. Folder Pinned, real round trip: one pick pins every open task of the folder AND its
 *      subfolder into the tier (a completed task is left alone), the menu reopened on the tier's
 *      folder chip lights that tier, and clicking the lit pill unpins them all.
 *   2. Project Pinned from a MIXED state: nothing is lit, a pick puts every task in one tier.
 *   3. Sprint on a folder: the field list and its options are mocked (no plugin in the fixture),
 *      the batch write is captured: ONE request naming exactly the open members.
 *   4. The project's Project row moves the project into another one, after a confirm; Cancel
 *      changes nothing.
 *   5. A pick that touches 20+ tasks asks first; Cancel writes nothing.
 *   6. Keyboard and geometry: the pills stay inside the menu box, the arrows reach a pill, and
 *      Enter on it pins.
 *   7. Width: with a custom tier the pills still sit on one line (the menu may grow past the shared
 *      340px, up to 560px); a narrow window and many custom tiers wrap them inside the box.
 *
 * Every task, folder, pin, custom tier and project is unique per run and removed in afterEach, also after a
 * failed assertion: a leaked pin changes the Focus tier other specs measure.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, openListProject, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

test.setTimeout(180_000)

const litter: { tasks: string[]; folders: string[]; projects: string[]; tiers: string[] } = { tasks: [], folders: [], projects: [], tiers: [] }

test.beforeEach(async ({ page }) => {
  litter.tasks = []
  litter.folders = []
  litter.projects = []
  litter.tiers = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tiers) {
    await fetch(`${API}/api/focus/tiers/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const id of litter.tasks) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const gid of litter.folders) {
    await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const name of litter.projects) {
    await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
  }
})

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

async function createTask(title: string, project: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `${title} ${stamp()}`, project, source: 'local', pinned: false, ...extra }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  litter.tasks.push(id)
  if (!litter.projects.includes(project)) litter.projects.push(project)
  return id
}

async function createFolder(taskIds: string[], label: string): Promise<string> {
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

async function setParent(groupId: string, parentId: string): Promise<void> {
  const res = await fetch(`${API}/api/tasks/folders/${groupId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: parentId }),
  })
  if (!res.ok) throw new Error(`folder parent failed: ${res.status} ${await res.text()}`)
}

async function complete(id: string): Promise<void> {
  const res = await fetch(`${API}/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase: 'COMPLETE' }),
  })
  if (!res.ok) throw new Error(`complete failed: ${res.status} ${await res.text()}`)
}

async function pin(id: string, tier: string): Promise<void> {
  expect((await fetch(`${API}/api/focus/tasks/${id}`, { method: 'POST' })).ok).toBe(true)
  const res = await fetch(`${API}/api/focus/tasks/${id}/tier`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier }),
  })
  expect(res.ok).toBe(true)
}

async function createTier(label: string): Promise<string> {
  const res = await fetch(`${API}/api/focus/tiers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
  })
  if (!res.ok) throw new Error(`tier create failed: ${res.status} ${await res.text()}`)
  const id = ((await res.json()) as { tier: { id: string } }).tier.id
  litter.tiers.push(id)
  return id
}

/** The pills' layout inside an open menu: how many lines they take, and whether they stay in the box and the window. */
function pillFit(menu: Locator) {
  return menu.evaluate((box) => {
    const frame = box.getBoundingClientRect()
    const pills = [...box.querySelectorAll('.wn-context-menu-pill')].map((p) => p.getBoundingClientRect())
    return {
      count: pills.length,
      lines: new Set(pills.map((r) => Math.round(r.top))).size,
      inside: pills.every((r) => r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5),
      viewport: frame.left >= 0 && frame.right <= innerWidth && frame.bottom <= innerHeight,
      width: frame.width,
      innerWidth,
    }
  })
}

interface Split { pinned_tasks: string[]; focus_tasks: string[]; wait_tasks: string[] }
async function split(): Promise<Split> {
  return (await (await fetch(`${API}/api/focus/tasks`)).json()) as Split
}

/** Where each of `ids` sits now: 'focus' | 'wait' | 'satellite' | 'unpinned'. */
async function tiers(ids: string[]): Promise<string[]> {
  const s = await split()
  return ids.map((id) => !s.pinned_tasks.includes(id) ? 'unpinned'
    : s.focus_tasks.includes(id) ? 'focus' : s.wait_tasks.includes(id) ? 'wait' : 'satellite')
}

async function boot(page: Page): Promise<void> {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

const folderHeader = (page: Page, groupId: string) =>
  page.locator(`.todo-group-project .task-group-chip[data-group-id="${groupId}"]`).first()

const projectHeader = (page: Page, project: string) => page.locator('.todo-group-project-header').filter({
  has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${project}$`) }),
}).first()

/**
 * Right-click a row and wait for its menu, RETRYING the gesture: the menu closes on any scroll
 * by design, and the fixture's list can settle-scroll for a moment after load.
 */
async function openMenu(page: Page, row: Locator, testId: string, anItem: RegExp | string): Promise<Locator> {
  const menu = page.getByTestId(testId)
  await expect(async () => {
    await row.click({ button: 'right' })
    await expect(menu.getByRole('menuitemradio', { name: anItem }).or(menu.getByRole('menuitem', { name: anItem })).first())
      .toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  return menu
}

const pill = (menu: Locator, name: string) => menu.getByRole('menuitemradio', { name, exact: true })

test('folder Pinned pins every open task of the folder and its subfolder, and the lit pill unpins them', async ({ page }) => {
  const s = stamp()
  const project = `GroupPinFolder${s}`
  const a = await createTask('folder member a', project)
  const b = await createTask('folder member b', project)
  const done = await createTask('folder member done', project)
  const c = await createTask('subfolder member c', project)
  const d = await createTask('subfolder member d', project)
  const outside = await createTask('not in the folder', project)
  const parent = await createFolder([a, b, done], `PinParent ${s}`)
  const child = await createFolder([c, d], `PinChild ${s}`)
  await setParent(child, parent)
  await complete(done)

  await boot(page)
  await openListProject(page, project)
  const row = folderHeader(page, parent)
  await expect(row).toBeVisible({ timeout: 15_000 })

  let menu = await openMenu(page, row, 'folder-ctx-menu', 'Focus')
  await expect(menu.getByRole('group', { name: 'Pin to' })).toBeVisible()
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/group-menu-settings/folder-menu.png', clip: (await menu.boundingBox())! })
  await pill(menu, 'Focus').click()
  await expect(menu).toHaveCount(0)

  await expect.poll(() => tiers([a, b, c, d, done, outside]), { timeout: 15_000 })
    .toEqual(['focus', 'focus', 'focus', 'focus', 'unpinned', 'unpinned'])

  // A pinned task is listed in its tier only, so the folder now shows as the Focus tier's chip.
  const chip = page.locator(`[data-drop-zone="focus-drop-zone"] .task-group-chip[data-group-id="${parent}"]`).first()
  await expect(chip).toBeVisible({ timeout: 15_000 })
  menu = await openMenu(page, chip, 'folder-ctx-menu', 'Focus')
  await expect(menu.getByRole('group', { name: 'Pinned' })).toBeVisible()
  await expect(pill(menu, 'Focus')).toHaveAttribute('aria-checked', 'true')
  await pill(menu, 'Focus').click()
  await expect.poll(() => tiers([a, b, c, d]), { timeout: 15_000 })
    .toEqual(['unpinned', 'unpinned', 'unpinned', 'unpinned'])
})

test('project Pinned from a mixed state lights nothing, and one pick puts every task in that tier', async ({ page }) => {
  const project = `GroupPinProject${stamp()}`
  const a = await createTask('project member a', project)
  const b = await createTask('project member b', project)
  await pin(a, 'focus')

  await boot(page)
  const header = projectHeader(page, project)
  await expect(header).toBeVisible({ timeout: 15_000 })
  const menu = await openMenu(page, header, 'project-ctx-menu', 'Satellite')
  await expect(menu.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/group-menu-settings/project-menu.png', clip: (await menu.boundingBox())! })
  await pill(menu, 'Satellite').click()
  await expect.poll(() => tiers([a, b]), { timeout: 15_000 }).toEqual(['satellite', 'satellite'])
})

test('Sprint on a folder writes one batch naming exactly its open tasks', async ({ page }) => {
  const s = stamp()
  const project = `GroupSprint${s}`
  const a = await createTask('sprint member a', project)
  const b = await createTask('sprint member b', project)
  const done = await createTask('sprint member done', project)
  const groupId = await createFolder([a, b, done], `Sprintable ${s}`)
  await complete(done)

  const field = {
    pluginId: 'demo-tracker', pluginName: 'Demo tracker', key: 'sprint', label: 'Sprint', type: 'enum',
    optionsRoute: 'sprints', optionsUrl: '/api/test-mock/demo-tracker/sprints', coreField: 'sprint',
  }
  await page.route('**/api/integrations/task-fields', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ fields: [field] }) }))
  await page.route('**/api/test-mock/demo-tracker/sprints', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ options: [{ value: 'S7' }, { value: 'S8' }], current: 'S8' }) }))
  const bodies: unknown[] = []
  await page.route('**/api/tasks/batch/plugin-field', async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ changed: [], failed: [] }) })
  })

  await boot(page)
  await openListProject(page, project)
  const row = folderHeader(page, groupId)
  await expect(row).toBeVisible({ timeout: 15_000 })
  let menu = await openMenu(page, row, 'folder-ctx-menu', /^Sprint/)
  const sprintRow = menu.getByRole('menuitem', { name: /^Sprint/ })
  await expect(sprintRow).toContainText('Set…')
  await sprintRow.click()
  const flyout = page.locator('.plugin-field-flyout')
  await expect(flyout).toBeVisible()
  await page.screenshot({ path: '/tmp/group-menu-settings/sprint-flyout.png' })
  await flyout.locator('.task-kebab-project-opt', { hasText: /^S7$/ }).click()
  await expect(flyout).toHaveCount(0)

  await expect.poll(() => bodies.length).toBe(1)
  const body = bodies[0] as { task_ids: string[]; pluginId: string; key: string; value: string }
  expect([...body.task_ids].sort()).toEqual([a, b].sort())
  expect({ pluginId: body.pluginId, key: body.key, value: body.value }).toEqual({ pluginId: 'demo-tracker', key: 'sprint', value: 'S7' })

  // The row reads the value the tasks now share.
  menu = await openMenu(page, row, 'folder-ctx-menu', /^Sprint/)
  await expect(menu.getByRole('menuitem', { name: /^Sprint/ })).toContainText('S7')
  await page.keyboard.press('Escape')
})

test('the Project row moves a project into another after a confirm, and Cancel changes nothing', async ({ page }) => {
  const s = stamp()
  const from = `GroupMoveFrom${s}`
  const target = `GroupMoveTo${s}`
  const a = await createTask('moving member', from)
  await createTask('target member', target)

  await boot(page)
  const header = projectHeader(page, from)
  await expect(header).toBeVisible({ timeout: 15_000 })
  const flyout = page.locator('.task-kebab-project-flyout')
  const pickTarget = async () => {
    const menu = await openMenu(page, header, 'project-ctx-menu', /^Project/)
    await expect(menu.getByRole('menuitem', { name: /^Project/ })).toContainText(from)
    await menu.getByRole('menuitem', { name: /^Project/ }).click()
    await expect(flyout).toBeVisible()
    const filter = flyout.locator('.task-kebab-project-filter')
    if (await filter.count()) await filter.fill(target)
    await flyout.locator('.task-kebab-project-opt', { hasText: new RegExp(`^${target}$`) }).click()
    const modal = page.locator('.app-modal')
    await expect(modal).toContainText(`Move “${from}” into “${target}”?`)
    return modal
  }

  let modal = await pickTarget()
  await page.screenshot({ path: '/tmp/group-menu-settings/project-move-confirm.png' })
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(modal).toHaveCount(0)
  const unchanged = (await (await fetch(`${API}/api/tasks/${a}`)).json()) as { task: { project: string } }
  expect(unchanged.task.project).toBe(from)

  modal = await pickTarget()
  await modal.getByRole('button', { name: 'Move' }).click()
  await expect.poll(async () => ((await (await fetch(`${API}/api/tasks/${a}`)).json()) as { task: { project: string } }).task.project,
    { timeout: 15_000 }).toBe(target)
  await expect(projectHeader(page, from)).toHaveCount(0, { timeout: 15_000 })
})

test('a pick that touches 20 or more tasks asks first, and Cancel writes nothing', async ({ page }) => {
  const project = `GroupPinMany${stamp()}`
  const ids: string[] = []
  for (let i = 0; i < 20; i += 1) ids.push(await createTask(`many ${i}`, project))

  await boot(page)
  const header = projectHeader(page, project)
  await expect(header).toBeVisible({ timeout: 15_000 })
  let menu = await openMenu(page, header, 'project-ctx-menu', 'Parked')
  await pill(menu, 'Parked').click()
  const modal = page.locator('.app-modal')
  await expect(modal).toContainText('Pin 20 tasks to Parked?')
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await expect(modal).toHaveCount(0)
  expect((await tiers(ids)).every((t) => t === 'unpinned')).toBe(true)

  menu = await openMenu(page, header, 'project-ctx-menu', 'Parked')
  await pill(menu, 'Parked').click()
  await page.locator('.app-modal').getByRole('button', { name: 'Pin' }).click()
  await expect.poll(async () => (await tiers(ids)).every((t) => t === 'wait'), { timeout: 20_000 }).toBe(true)
})

test('the pills stay inside the menu box, and the arrows plus Enter reach one', async ({ page }) => {
  const s = stamp()
  const project = `GroupPinKeys${s}`
  const a = await createTask('keyboard member a', project)
  const b = await createTask('keyboard member b', project)
  const groupId = await createFolder([a, b], `Keyboard ${s}`)

  await boot(page)
  await openListProject(page, project)
  const row = folderHeader(page, groupId)
  await expect(row).toBeVisible({ timeout: 15_000 })
  const menu = await openMenu(page, row, 'folder-ctx-menu', 'Focus')

  const fit = await menu.evaluate((box) => {
    const frame = box.getBoundingClientRect()
    const pills = [...box.querySelectorAll('.wn-context-menu-pill')].map((p) => p.getBoundingClientRect())
    return {
      count: pills.length,
      inside: pills.every((r) => r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5),
      width: frame.width,
      viewport: frame.right <= innerWidth && frame.bottom <= innerHeight,
    }
  })
  expect(fit.count).toBeGreaterThanOrEqual(3)
  expect(fit.inside).toBe(true)
  expect(fit.viewport).toBe(true)
  expect(fit.width).toBeLessThanOrEqual(560)

  const parked = pill(menu, 'Parked')
  for (let i = 0; i < 12 && !(await parked.evaluate((el) => el.classList.contains('focused'))); i += 1) {
    await page.keyboard.press('ArrowDown')
  }
  await expect(parked).toHaveClass(/focused/)
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect.poll(() => tiers([a, b]), { timeout: 15_000 }).toEqual(['wait', 'wait'])
})

test('a menu with the Pinned pills is wide enough to keep them on one line, and wraps them inside the box when it cannot', async ({ page }) => {
  const s = stamp()
  const project = `GroupPinWide${s}`
  const a = await createTask('wide member a', project)
  const b = await createTask('wide member b', project)
  const groupId = await createFolder([a, b], `Wide ${s}`)
  const custom = `Teammate ${s}`
  await createTier(custom)

  // The built-in tiers plus one custom tier sit on one line, as they do in the task menu
  // (the shared 340px ceiling wrapped the custom one under them).
  await page.setViewportSize({ width: 1280, height: 800 })
  await boot(page)
  await openListProject(page, project)
  const row = folderHeader(page, groupId)
  await expect(row).toBeVisible({ timeout: 15_000 })
  let menu = await openMenu(page, row, 'folder-ctx-menu', custom)
  let fit = await pillFit(menu)
  expect(fit).toMatchObject({ lines: 1, inside: true, viewport: true })
  expect(fit.count).toBeGreaterThanOrEqual(4)
  expect(fit.width).toBeGreaterThan(340)
  expect(fit.width).toBeLessThanOrEqual(560)
  await page.screenshot({ path: '/tmp/group-menu-settings/wide-folder-menu.png', clip: (await menu.boundingBox())! })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  menu = await openMenu(page, projectHeader(page, project), 'project-ctx-menu', custom)
  fit = await pillFit(menu)
  expect(fit).toMatchObject({ lines: 1, inside: true, viewport: true })
  await page.screenshot({ path: '/tmp/group-menu-settings/wide-project-menu.png', clip: (await menu.boundingBox())! })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // A narrow window: the menu stays inside it and the pills wrap inside the box.
  await page.setViewportSize({ width: 420, height: 800 })
  menu = await openMenu(page, row, 'folder-ctx-menu', custom)
  fit = await pillFit(menu)
  expect(fit).toMatchObject({ inside: true, viewport: true })
  expect(fit.lines).toBeGreaterThan(1)
  expect(fit.width).toBeLessThanOrEqual(fit.innerWidth - 16)
  await page.screenshot({ path: '/tmp/group-menu-settings/narrow-folder-menu.png', clip: (await menu.boundingBox())! })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Many custom tiers: the menu stops at its 560px ceiling and the pills wrap inside it.
  for (let i = 0; i < 5; i += 1) await createTier(`Extra ${i} ${s}`)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.reload()
  await page.waitForLoadState('networkidle')
  await openListProject(page, project)
  menu = await openMenu(page, folderHeader(page, groupId), 'folder-ctx-menu', `Extra 4 ${s}`)
  fit = await pillFit(menu)
  expect(fit).toMatchObject({ inside: true, viewport: true })
  expect(fit.count).toBeGreaterThanOrEqual(9)
  expect(fit.lines).toBeGreaterThan(1)
  expect(fit.width).toBeLessThanOrEqual(560)
  await page.screenshot({ path: '/tmp/group-menu-settings/many-tiers-folder-menu.png', clip: (await menu.boundingBox())! })
  await page.keyboard.press('Escape')
})
