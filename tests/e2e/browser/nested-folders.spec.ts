/**
 * Nested folders on the board. A subtask filed from a task whose folder also
 * holds other work gets a SUBFOLDER of that folder (caller-placement.ts), and the
 * board draws the folder tree nested (web/src/components/tasks/folder-tree.ts):
 * the subfolder's chip one step in under its parent folder's rows, its cards one
 * step further, folding the parent hides the subfolder with it, and a parent with
 * no card of its own in a tier still gets its heading above the subfolder.
 *
 * The create goes through the door a session's task_create uses (POST
 * /api/v1/tasks with the caller's session id); the board is then read and folded
 * the way the user does it, in a tier tab and in the Projects view.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { chooseViewOption } from './home-navigation-helpers'
import { seedShortcutBars } from './shortcut-test-fixture'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOT_DIR = '/tmp/nested-folders/shots'
// Seeded by the fixture server with a session record, so it is a WORKER caller.
// One per browser (test-server.ts), so the two projects never share a parent.
const parentFor = (browserName: string) => `pw-task-nested-folder-${browserName}`
const callerFor = (browserName: string) => `pw-nested-folder-session-${browserName}`
const litterTasks: string[] = []
const litterFolders: string[] = []

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
  return await res.json() as T
}

const setTier = (id: string, tier: string) => api('PUT', `/api/focus/tasks/${id}/tier`, { tier })

async function folderRow(gid: string): Promise<{ parent_id?: string; member_ids: string[] } | undefined> {
  const { groups } = await api<{ groups: Array<{ group_id: string; parent_id?: string; member_ids: string[] }> }>('GET', '/api/tasks/groups')
  return groups.find((g) => g.group_id === gid)
}

const chip = (page: Page, gid: string): Locator => page.locator(`.todo-panel .task-group-chip[data-group-id="${gid}"]`).first()
const card = (page: Page, id: string): Locator =>
  page.locator(`.todo-panel .todo-focus-card[data-task-id="${id}"], .todo-panel .todo-pinned-card[data-task-id="${id}"]`).first()
const row = (page: Page, id: string): Locator => page.locator(`.todo-panel .todo-panel-item[data-task-id="${id}"]`).first()
const left = async (l: Locator): Promise<number> => (await l.boundingBox())!.x

/** DOM order of the given folder chips / task rows inside the panel. */
async function domOrder(page: Page, keys: string[]): Promise<string[]> {
  return page.locator('.todo-panel').first().evaluate((panel, wanted) => {
    const out: string[] = []
    for (const el of panel.querySelectorAll('.task-group-chip[data-group-id], [data-task-id]')) {
      const key = el.classList.contains('task-group-chip') ? `folder:${el.getAttribute('data-group-id')}` : el.getAttribute('data-task-id')!
      if (wanted.includes(key) && !out.includes(key)) out.push(key)
    }
    return out
  }, keys)
}

test.beforeEach(async ({ page }) => {
  litterTasks.length = 0
  litterFolders.length = 0
  await isolateUiPrefs(page)
})

test('a subtask from a task in a shared folder lands in a subfolder the board draws nested', async ({ page, browserName }) => {
  test.setTimeout(240_000)
  const PARENT = parentFor(browserName)
  const CALLER_SID = callerFor(browserName)
  const before = (await api<{ task: { pinned?: boolean; focus_tier?: string; group_id?: string } }>('GET', `/api/tasks/${PARENT}`)).task
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  try {
    // The parent sits in Focus, in a folder it shares with unrelated work.
    if (!before.pinned) await api('POST', `/api/focus/tasks/${PARENT}`)
    await setTier(PARENT, 'focus')
    const { task: neighbour } = await api<{ task: { id: string } }>('POST', '/api/tasks', {
      title: `Unrelated neighbour ${stamp}`, project: 'Walnut', source: 'local', pinned: true,
    })
    litterTasks.push(neighbour.id)
    await setTier(neighbour.id, 'focus')
    const shared = (await api<{ group_id: string }>('POST', '/api/tasks/groups', {
      task_ids: [PARENT, neighbour.id], label: `Shared ${stamp}`,
    })).group_id
    litterFolders.push(shared)

    // The session files a subtask: a subfolder of the shared folder, holding both.
    const res = await fetch(`${API}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-walnut-caller-sid': CALLER_SID },
      body: JSON.stringify({ title: `Split piece ${stamp}` }),
    })
    expect(res.status).toBe(201)
    const created = await res.json() as { task: { id: string }; placement: { group_id: string; folder_created: boolean; parent_task_id?: string; tier?: string } }
    const child = created.task.id
    litterTasks.push(child)
    const sub = created.placement.group_id
    litterFolders.unshift(sub)
    expect(created.placement).toMatchObject({ folder_created: true, parent_task_id: PARENT, tier: 'focus' })
    expect(sub).not.toBe(shared)
    const subRow = await folderRow(sub)
    expect(subRow?.parent_id).toBe(shared)
    expect(subRow?.member_ids.sort()).toEqual([PARENT, child].sort())
    expect((await folderRow(shared))?.member_ids).toEqual([neighbour.id])

    // The Focus tab: the subfolder sits INSIDE the shared folder, one step in.
    await seedShortcutBars(page)
    await presetPanelView(page, { section: 'focus', project: '' })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    const focusTab = page.locator('.todo-section-tabs [role="tab"]', { hasText: 'Focus' }).first()
    await expect(focusTab).toHaveAttribute('aria-selected', 'true', { timeout: 90_000 })
    await expect(card(page, child)).toBeVisible({ timeout: 30_000 })
    await expect(chip(page, shared)).toBeVisible()
    await expect(chip(page, sub)).toHaveAttribute('data-folder-depth', '1')
    expect(await domOrder(page, [`folder:${shared}`, neighbour.id, `folder:${sub}`, PARENT, child]))
      .toEqual([`folder:${shared}`, neighbour.id, `folder:${sub}`, PARENT, child])
    expect(await left(chip(page, sub)) - await left(chip(page, shared))).toBeCloseTo(16, 0)
    expect(await left(card(page, child)) - await left(card(page, neighbour.id))).toBeCloseTo(16, 0)
    expect(await left(card(page, PARENT))).toBeCloseTo(await left(card(page, child)), 0)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    const shot = async (name: string) => {
      await chip(page, shared).scrollIntoViewIfNeeded()
      const top = (await chip(page, shared).boundingBox())!
      const panel = (await page.locator('.todo-panel').first().boundingBox())!
      const view = page.viewportSize()!
      const y = Math.max(0, panel.y, top.y - 40)
      await page.screenshot({
        path: `${SHOT_DIR}/${browserName}-${name}.png`,
        clip: { x: panel.x, y, width: panel.width, height: Math.min(260, view.height - y) },
      })
    }
    await shot('focus-nested')

    // Folding the parent folder hides the subfolder with it; unfolding brings it back.
    await chip(page, shared).click()
    await expect(card(page, neighbour.id)).toBeHidden()
    await expect(chip(page, sub)).toBeHidden()
    await expect(card(page, child)).toBeHidden()
    await shot('focus-parent-folded')
    await chip(page, shared).click()
    await expect(chip(page, sub)).toBeVisible()
    await expect(card(page, child)).toBeVisible()
    // Folding the subfolder alone leaves the parent folder's own rows.
    await chip(page, sub).click()
    await expect(card(page, child)).toBeHidden()
    await expect(card(page, neighbour.id)).toBeVisible()
    await chip(page, sub).click()
    await expect(card(page, child)).toBeVisible()

    // The neighbour leaves Focus: the shared folder has no card here any more, and
    // its heading still goes above the subfolder instead of vanishing.
    await setTier(neighbour.id, 'satellite')
    await expect(card(page, neighbour.id)).toHaveCount(0, { timeout: 30_000 })
    await expect(chip(page, shared)).toBeVisible()
    expect(await domOrder(page, [`folder:${shared}`, `folder:${sub}`, PARENT, child]))
      .toEqual([`folder:${shared}`, `folder:${sub}`, PARENT, child])
    expect(await left(chip(page, sub)) - await left(chip(page, shared))).toBeCloseTo(16, 0)
    await shot('focus-parent-heading-only')
    await chip(page, shared).click()
    await expect(chip(page, sub)).toBeHidden()
    await expect(card(page, child)).toBeHidden()
    await chip(page, shared).click()
    await expect(card(page, child)).toBeVisible()

    // The Projects view draws the same tree: the subfolder's header one step in.
    // Projects lives on Display's View page.
    await chooseViewOption(page, 'tasks')
    // A project's list shows its first rows and folders sink to the bottom, so the
    // fixture's busy Walnut project needs "Show more", as it would for the user.
    await expect(page.locator('.todo-panel .todo-panel-item').first()).toBeVisible({ timeout: 30_000 })
    for (let i = 0; i < 8 && !(await row(page, PARENT).isVisible()); i++) {
      const more = page.locator('.todo-panel .todo-list-show-more')
      if ((await more.count()) === 0) break
      await more.last().click()
    }
    await expect(row(page, PARENT)).toBeVisible({ timeout: 30_000 })
    await expect(chip(page, sub)).toHaveAttribute('data-folder-depth', '1')
    expect(await domOrder(page, [`folder:${shared}`, neighbour.id, `folder:${sub}`, PARENT]))
      .toEqual([`folder:${shared}`, neighbour.id, `folder:${sub}`, PARENT])
    expect(await left(chip(page, sub)) - await left(chip(page, shared))).toBeCloseTo(16, 0)
    const pad = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    expect(await pad(row(page, PARENT)) - await pad(row(page, neighbour.id))).toBeCloseTo(16, 0)
    await shot('projects-nested')
    await chip(page, shared).click()
    await expect(chip(page, sub)).toBeHidden()
    await expect(row(page, PARENT)).toBeHidden()
    await chip(page, shared).click()
    await expect(row(page, PARENT)).toBeVisible()
  } finally {
    await fetch(`${API}/api/tasks/groups/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: [PARENT] }),
    }).catch(() => undefined)
    if (before.group_id) {
      await fetch(`${API}/api/tasks/groups/${before.group_id}/add`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task_ids: [PARENT] }),
      }).catch(() => undefined)
    }
    await setTier(PARENT, before.focus_tier || 'satellite').catch(() => undefined)
    if (!before.pinned) await fetch(`${API}/api/focus/tasks/${PARENT}`, { method: 'DELETE' }).catch(() => undefined)
    for (const id of [...litterTasks].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    for (const gid of litterFolders) await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  }
})
