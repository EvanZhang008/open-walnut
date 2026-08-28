/**
 * Playwright browser tests: the FOLDER model (schema v10 — groups became
 * per-project, nestable, empty-valid folders).
 *
 * Pins the four user-visible consequences of the cutover:
 *   1. A grouped cluster renders as a FOLDER (chip present, member rows boxed).
 *   2. An empty folder created via the API renders as a standalone droppable
 *      row inside its project bucket (it has no member rows to anchor to).
 *   3. Deleting a folder (chip ✕) releases the members in place — tasks stay,
 *      folder row disappears.
 *   4. Same-project rule: the create endpoint rejects a cross-project mix.
 *
 * All data is unique per run (suffixes) — parallel-safe against the shared
 * fixture server.
 */
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function createTaskViaApi(title: string, opts: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', ...opts }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

test('grouped tasks render as a folder; deleting the folder releases members in place', async ({ page }) => {
  const project = `FolderProj${Date.now().toString(36)}`
  const a = await createTaskViaApi('Folder member A', { project })
  const b = await createTaskViaApi('Folder member B', { project })
  const groupRes = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: [a.id, b.id], label: 'Migrated Folder' }),
  })
  expect(groupRes.ok).toBe(true)
  const group = (await groupRes.json()) as { group_id: string; project?: string }

  // The listing carries the new folder fields.
  const listing = (await (await fetch(`${API}/api/tasks/groups`)).json()) as { groups: Array<{ group_id: string; project?: string }> }
  const entry = listing.groups.find((g) => g.group_id === group.group_id)
  expect(entry?.project).toBe(project)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  // 1. The folder chip renders above the lead member with the folder label.
  const chip = page.locator(`.task-group-chip[data-group-id="${group.group_id}"], .task-group-chip:has-text("Migrated Folder")`).first()
  await expect(chip).toBeVisible()
  await expect(page.locator(`[data-task-id="${a.id}"]`).first()).toBeVisible()
  await expect(page.locator(`[data-task-id="${b.id}"]`).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/folder-model/folder-chip.png', fullPage: false })

  // 3. Delete the folder via its ✕ — members must stay, chip must go.
  await chip.hover()
  await chip.locator('.task-group-chip-dissolve').click()
  await expect(page.locator(`.task-group-chip:has-text("Migrated Folder")`)).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator(`[data-task-id="${a.id}"]`).first()).toBeVisible()
  await expect(page.locator(`[data-task-id="${b.id}"]`).first()).toBeVisible()
  await page.screenshot({ path: '/tmp/folder-model/folder-deleted-members-stay.png' })

  // Server agrees: folder gone from the listing, tasks still exist.
  const after = (await (await fetch(`${API}/api/tasks/groups`)).json()) as { groups: Array<{ group_id: string }> }
  expect(after.groups.find((g) => g.group_id === group.group_id)).toBeUndefined()
})

test('an empty folder renders as a droppable row in its project bucket', async ({ page }) => {
  const project = `EmptyFolderProj${Date.now().toString(36)}`
  // The bucket needs at least one task to exist in the By-project list.
  const anchor = await createTaskViaApi('Bucket anchor task', { project })
  const label = `Fresh Empty Folder ${Date.now().toString(36)}`
  const res = await fetch(`${API}/api/tasks/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, project }),
  })
  expect(res.status).toBe(201)
  const folder = (await res.json()) as { group_id: string }

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  await expect(page.locator(`[data-task-id="${anchor.id}"]`).first()).toBeVisible()
  const emptyRow = page.locator(`.task-group-chip-empty[data-group-id="${folder.group_id}"]`).first()
  await expect(emptyRow).toBeVisible()
  await expect(emptyRow).toContainText(label)
  await page.screenshot({ path: '/tmp/folder-model/empty-folder-row.png' })

  // Cleanup keeps the shared fixture list tidy for other specs.
  await fetch(`${API}/api/tasks/folders/${folder.group_id}`, { method: 'DELETE' })
})

test('the project + menu creates an empty folder through the in-app prompt', async ({ page }) => {
  const project = `PlusFolderProj${Date.now().toString(36)}`
  await createTaskViaApi('Plus menu anchor', { project })
  const label = `Menu Folder ${Date.now().toString(36)}`

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  const header = page.locator('.todo-group-project-header', { hasText: project }).first()
  await header.scrollIntoViewIfNeeded()
  await header.hover()
  await header.locator('[data-testid="plus-menu-trigger"]').click()
  await page.locator('[data-testid="plus-menu"] .task-kebab-item', { hasText: 'New folder' }).click()

  const modal = page.locator('.app-modal')
  await expect(modal).toBeVisible()
  await modal.locator('input').fill(label)
  await modal.getByRole('button', { name: 'Create' }).click()

  const emptyRow = page.locator('.task-group-chip-empty', { hasText: label }).first()
  await expect(emptyRow).toBeVisible({ timeout: 10000 })
  await page.screenshot({ path: '/tmp/folder-model/plus-menu-empty-folder.png' })

  // Cleanup via the API (the listing tells us the id the prompt flow created).
  const listing = (await (await fetch(`${API}/api/tasks/groups`)).json()) as { groups: Array<{ group_id: string; label?: string }> }
  const created = listing.groups.find((g) => g.label === label)
  if (created) await fetch(`${API}/api/tasks/folders/${created.group_id}`, { method: 'DELETE' })
})

test('folder API enforces the same-project rule and supports nesting', async ({ page: _page }) => {
  const projectA = `SameProjA${Date.now().toString(36)}`
  const projectB = `SameProjB${Date.now().toString(36)}`
  const a = await createTaskViaApi('Same project A1', { project: projectA })
  const b = await createTaskViaApi('Other project B1', { project: projectB })

  // Cross-project create → 400 with the rule spelled out.
  const bad = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: [a.id, b.id] }),
  })
  expect(bad.status).toBe(400)
  expect(((await bad.json()) as { error: string }).error).toContain('one project')

  // Nesting: child under parent (same project) works; cross-project parent → 400.
  const parent = (await (await fetch(`${API}/api/tasks/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Parent folder', project: projectA }),
  })).json()) as { group_id: string }
  const childRes = await fetch(`${API}/api/tasks/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Child folder', project: projectA, parent_id: parent.group_id }),
  })
  expect(childRes.status).toBe(201)
  const child = (await childRes.json()) as { group_id: string; parent_id?: string }
  expect(child.parent_id).toBe(parent.group_id)

  const crossParent = await fetch(`${API}/api/tasks/folders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Wrong home', project: projectB, parent_id: parent.group_id }),
  })
  expect(crossParent.status).toBe(400)

  // Deleting the parent re-parents the child to top level (not deleted).
  await fetch(`${API}/api/tasks/folders/${parent.group_id}`, { method: 'DELETE' })
  const listing = (await (await fetch(`${API}/api/tasks/groups`)).json()) as { groups: Array<{ group_id: string; parent_id?: string }> }
  const survivor = listing.groups.find((g) => g.group_id === child.group_id)
  expect(survivor).toBeTruthy()
  expect(survivor?.parent_id).toBeUndefined()
  await fetch(`${API}/api/tasks/folders/${child.group_id}`, { method: 'DELETE' })
})
