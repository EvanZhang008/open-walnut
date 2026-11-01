/**
 * Local-only tasks in a project that syncs to an outside service (src/core/private-tasks/), as a
 * user meets them (2026-11-01, the user: "we can turn a task from [the tracker] to local, of the
 * same project"; "in create new task UI we should have a button to select which source, local or
 * the default source of this project"; a keyword filter the user configures).
 *
 *   1. A synced task's ⋮ menu has a collapsed Sync row; Make local keeps its content, and the row
 *      then reads Local with why and offers Sync to <service>, which sends it back.
 *   2. The draft column's Sync chip shows only in a project that syncs, starts Local, and the
 *      task saved for later is created local (or with the service when flipped).
 *   3. The calendar quick add has a Local / <service> field; Local creates the task local.
 *   4. Settings › Tasks › Private tasks: the words are saved to the config and Try a title says
 *      which word a title matches.
 *
 * The project is the fixture's Atlas, owned by the fixture source `plugin-a` (no live plugin:
 * nothing is sent anywhere). Every task it makes is deleted after, and the words it
 * saves are put back.
 */
import fs from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  discoverFixtureRoot, draftMenuProject, draftMoreButton, loadHome, openDraftOnCwd,
} from './draft-helpers'
import { createTaskForLater } from './draft-outcome-helpers'
import { calendarEmptySlotPoint } from './calendar-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SERVICE = 'plugin-a'
const SHOTS = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/private-tasks`

let fixtureRoot = ''
const litter: string[] = []

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(180_000)

test.beforeAll(async () => {
  fixtureRoot = await discoverFixtureRoot()
  fs.mkdirSync(SHOTS, { recursive: true })
})
test.afterEach(async () => {
  for (const id of litter.splice(0).reverse()) await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
})

interface ApiTask { id: string; title: string; source?: string; project?: string; description?: string; sync_hold?: { state: string; by?: string; target: string; reason?: string } }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
const getTask = async (id: string) => (await api<{ task: ApiTask }>('GET', `/api/tasks/${id}`)).task
const engine = () => test.info().project.name
const stamp = () => `${engine()}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** The fixture's project owned by its outside source (test-server.ts seeds Atlas for plugin-a). */
const PROJECT = 'Atlas'

/** A fresh folder in the fixture's tree, for a draft to launch from. */
function freshFolder(): string {
  const cwd = `${fixtureRoot}/projects/private-${stamp()}`
  fs.mkdirSync(cwd, { recursive: true })
  return cwd
}

/** Open a draft on a fresh folder and pick the project in More's Project section. */
async function draftIn(page: Page, project: string): Promise<Locator> {
  const panel = await openDraftOnCwd(page, freshFolder())
  await draftMoreButton(panel).click()
  await draftMenuProject(page).locator('.task-kebab-project-current').click()
  const flyout = page.locator('.task-kebab-project-flyout')
  const filter = flyout.locator('.task-kebab-project-filter')
  if (await filter.count()) await filter.fill(project)
  await flyout.locator('.task-kebab-project-opt', { hasText: new RegExp(`^${project}$`) }).click()
  await expect(panel.locator('.draft-composer-bar .draft-project-chip')).toHaveText(`Project: ${project}`)
  return panel
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
}

async function openRowMenu(page: Page, id: string): Promise<Locator> {
  const row = page.locator(`.todo-panel-item[data-task-id="${id}"]`)
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.hover()
  await row.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible()
  return menu
}

test('a synced task turns local from its menu, keeps its content, and syncs back', async ({ page }) => {
  const { task } = await api<{ task: ApiTask }>('POST', '/api/tasks', { title: `Quarter plan ${stamp()}`, project: PROJECT, description: 'the plan in full', pinned: false })
  litter.push(task.id)
  expect(task.source).toBe(SERVICE)

  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: PROJECT })
  await openHome(page)
  let menu = await openRowMenu(page, task.id)
  const sync = menu.getByTestId('kebab-sync')
  await expect(sync).toHaveAttribute('data-sync-kind', 'synced')
  await expect(menu.getByTestId('kebab-sync-toggle')).toContainText(`Sync: Syncs to ${SERVICE}`)
  // Collapsed until clicked.
  await expect(menu.getByTestId('kebab-make-local-keep')).toHaveCount(0)
  await menu.getByTestId('kebab-sync-toggle').click()
  await expect(menu.getByTestId('kebab-make-local-archive')).toContainText(`Make local, archive it in ${SERVICE}`)
  await expect(menu.getByTestId('kebab-make-local-neutralize')).toBeVisible()
  await menu.screenshot({ path: `${SHOTS}/${engine()}-1-synced-menu.png` })
  const made = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/v1/tasks/${task.id}/make-local`))
  await menu.getByTestId('kebab-make-local-keep').click()
  expect((await made).status()).toBe(200)
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await getTask(task.id)).source).toBe('local')
  const local = await getTask(task.id)
  expect(local).toMatchObject({ project: PROJECT, description: 'the plan in full', sync_hold: { state: 'chosen', by: 'user', target: SERVICE } })

  // The row's menu now says it is local and why, and offers the way back.
  menu = await openRowMenu(page, task.id)
  await expect(menu.getByTestId('kebab-sync')).toHaveAttribute('data-sync-kind', 'kept')
  await expect(menu.getByTestId('kebab-sync-toggle')).toContainText(`Local, not in ${SERVICE}`)
  await menu.getByTestId('kebab-sync-toggle').click()
  await expect(menu.getByTestId('kebab-sync-line')).toHaveText(`Kept out of ${SERVICE}: You made it local`)
  // It never reached the service (the fixture source has no live plugin), so there is no copy
  // there to archive.
  await expect(menu.getByTestId('kebab-outside-archive')).toHaveCount(0)
  await menu.screenshot({ path: `${SHOTS}/${engine()}-2-kept-menu.png` })
  await menu.getByTestId('kebab-sync-to-project').click()
  await expect.poll(async () => (await getTask(task.id)).source).toBe(SERVICE)
  expect((await getTask(task.id)).sync_hold).toBeUndefined()
})

test('the draft column\'s Sync chip: Local by default in a project that syncs, the service when flipped', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 })
  await loadHome(page)

  // A fresh folder files under a new local project: no chip.
  let panel = await openDraftOnCwd(page, freshFolder())
  await expect(panel.getByTestId('draft-sync-chip')).toHaveCount(0)

  // Saved for later as it starts: Local.
  panel = await draftIn(page, PROJECT)
  const chip = panel.getByTestId('draft-sync-chip')
  await expect(chip).toHaveAttribute('data-sync', 'local')
  await expect(chip).toHaveText('Sync:Local')
  await panel.locator('.draft-composer-bar').screenshot({ path: `${SHOTS}/${engine()}-3-draft-chip-local.png` })
  await panel.locator('.chat-input-textarea').fill(`notes kept to myself ${stamp()}`)
  const localId = await createTaskForLater(page, panel)
  litter.push(localId)
  expect(await getTask(localId)).toMatchObject({ source: 'local', project: PROJECT, sync_hold: { state: 'chosen', by: 'user', target: SERVICE } })

  // Flipped to the service: the task goes there (no model on the fixture, so at once).
  panel = await draftIn(page, PROJECT)
  const chip2 = panel.getByTestId('draft-sync-chip')
  await chip2.click()
  await expect(chip2).toHaveAttribute('data-sync', 'project')
  await expect(chip2).toHaveText(`Sync:${SERVICE}`)
  await panel.locator('.chat-input-textarea').fill(`fix the release script ${stamp()}`)
  const syncedId = await createTaskForLater(page, panel)
  litter.push(syncedId)
  expect((await getTask(syncedId)).source).toBe(SERVICE)
})

test('the calendar quick add creates a task Local when asked', async ({ page }) => {
  await openHome(page)
  await page.click('a[href="/calendar"]')
  await expect(page.locator('.cal-toolbar')).toBeVisible()
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const slot = await calendarEmptySlotPoint(page, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
  await page.mouse.click(slot.x, slot.y)
  const panel = page.locator('.qtc-confirm-panel')
  const title = `Garden plan ${stamp()}`
  await page.locator('.qtc-input').fill(title)
  await expect(panel).toBeVisible()
  await panel.locator('.qtc-confirm-title').fill(title)
  await panel.locator('.qtc-confirm-project').fill(PROJECT)
  const field = panel.getByTestId('qtc-sync-choice')
  await expect(field).toBeVisible()
  await expect(panel.getByTestId('qtc-sync-project')).toHaveAttribute('aria-checked', 'true')
  await panel.getByTestId('qtc-sync-local').click()
  await expect(panel.getByTestId('qtc-sync-local')).toHaveAttribute('aria-checked', 'true')
  await panel.screenshot({ path: `${SHOTS}/${engine()}-4-quick-add-sync.png` })
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks')
  await panel.locator('.qtc-confirm-primary').click()
  const res = await created
  const id = ((await res.json()) as { task: ApiTask }).task.id
  litter.push(id)
  expect(await getTask(id)).toMatchObject({ source: 'local', project: PROJECT, sync_hold: { state: 'chosen' } })
})

// Both write `private_tasks` in the one config the fixture shares: one at a time.
test.describe.serial('Settings', () => {
  test('Settings: private words are saved and Try a title says which one matches', async ({ page }) => {
    const word = `zq${stamp().toLowerCase()}`
    type Cfg = { config: { private_tasks?: { words?: string[] } } }
    const before = (await api<Cfg>('GET', '/api/config')).config.private_tasks
    try {
      await openHome(page)
      await page.locator('.sidebar-nav a[href^="/settings"]').click()
      await page.getByTestId('settings-nav-tasks').click()
      const group = page.getByTestId('tasks-private')
      await expect(group).toBeVisible()
      const box = page.getByTestId('settings-private-words')
      await box.fill(`${word}\n/(broken/`)
      await page.getByTestId('settings-private-try').fill(`my ${word} packet`)
      await expect(group).toContainText(`Stays local: it matches "${word}".`)
      await expect(group).toContainText('These lines are not used (not a valid pattern, or one that could be slow): /(broken/')
      await box.blur()
      await expect.poll(async () => (await api<Cfg>('GET', '/api/config')).config.private_tasks?.words)
        .toEqual([word, '/(broken/'])
      await group.screenshot({ path: `${SHOTS}/${engine()}-5-settings.png` })
      await page.getByTestId('settings-private-try').fill('fix the login page')
      await expect(group).toContainText('No private word matches it')
    } finally {
      await api('PUT', '/api/config', { private_tasks: before ?? { words: [] } }).catch(() => undefined)
    }
  })

  test('Settings: who reads each sync service is chosen per service and saved', async ({ page }) => {
    type Cfg = { config: { private_tasks?: { words?: string[]; audience?: Record<string, string> } } }
    const before = (await api<Cfg>('GET', '/api/config')).config.private_tasks
    // The fixture's source has no live plugin, so the list of loaded services is answered here,
    // from the real config, the way the server answers it (audience.ts: setting, else default).
    await page.route('**/api/v1/private-tasks/services', async (route) => {
      const set = (await api<Cfg>('GET', '/api/config')).config.private_tasks?.audience?.[SERVICE]
      await route.fulfill({ json: { services: [{ id: SERVICE, name: 'Plugin A', audience: set ?? 'shared', default: 'shared', set: !!set }] } })
    })
    try {
      await openHome(page)
      await page.locator('.sidebar-nav a[href^="/settings"]').click()
      await page.getByTestId('settings-nav-tasks').click()
      const row = page.getByTestId(`settings-private-audience-${SERVICE}`)
      await expect(row).toContainText('Who reads Plugin A')
      await expect(row).toContainText('Others read Plugin A, so Walnut keeps private tasks out of it')
      await page.getByTestId(`settings-private-audience-${SERVICE}-self`).click()
      await expect(row).toContainText('Only you read Plugin A, so private tasks may go there')
      await expect.poll(async () => (await api<Cfg>('GET', '/api/config')).config.private_tasks?.audience?.[SERVICE]).toBe('self')
      // The words and the AI switch are left as they were.
      expect((await api<Cfg>('GET', '/api/config')).config.private_tasks?.words ?? []).toEqual(before?.words ?? [])
      await row.screenshot({ path: `${SHOTS}/${engine()}-6-audience.png` })
      await page.getByTestId(`settings-private-audience-${SERVICE}-shared`).click()
      await expect.poll(async () => (await api<Cfg>('GET', '/api/config')).config.private_tasks?.audience?.[SERVICE]).toBe('shared')
      await expect(row).toContainText('Others read Plugin A')
    } finally {
      await api('PUT', '/api/config', { private_tasks: before ?? { words: [] } }).catch(() => undefined)
    }
  })
})
