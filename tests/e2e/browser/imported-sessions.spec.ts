/**
 * Imported sessions in the Homepage task list: the "Imported" pill marks a task
 * the external-session importer still owns, the cwd sub-folder groups imports by
 * working directory under the per-host project, and adoption (the import tag
 * coming off) removes the pill live, with no reload.
 *
 * The rows are seeded through the same REST surface the importer's own writes
 * land on (tag + cwd + folder). The scan → import path itself is pinned by the
 * vitest e2e (tests/e2e/external-session-import.test.ts) against a real server
 * and real transcript files; this spec owns what a human SEES afterwards.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const TAG = 'walnut:external-sessions'
const SHOT_DIR = '/tmp/imported-sessions'
const PILL_TITLE = 'Imported: this session was started outside Walnut. It is completed automatically after a week without activity. Send it a message to adopt it.'

const litter: { tasks: string[]; folders: string[]; projects: string[] } = { tasks: [], folders: [], projects: [] }

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', { title, source: 'local', pinned: false, ...opts })
  litter.tasks.push(task.id)
  return task.id
}

async function createFolder(label: string, project: string): Promise<string> {
  const { group_id } = await api<{ group_id: string }>('/api/tasks/folders', 'POST', { label, project })
  litter.folders.push(group_id)
  return group_id
}

async function shoot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false })
}

function projectBucket(page: Page, project: string) {
  return page.locator('.todo-group-project').filter({
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  })
}

function row(page: Page, taskId: string) {
  return page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
}

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.folders = []; litter.projects = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tasks) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const gid of litter.folders) await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  for (const name of litter.projects) await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
})

test('imported rows carry the pill inside their cwd folder; adoption removes it live', async ({ page, browserName }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Imported from specbox ${stamp}`
  litter.projects.push(project)

  // Seed the shape the importer writes: one folder per cwd, tagged tasks inside it,
  // plus a task of the user's own in the same project (no tag, no folder).
  const folder = await createFolder('myCode/walnut', project)
  const imported1 = await createTask(`Imported one ${stamp}`, { project, tags: [TAG], cwd: '/Users/dev/myCode/walnut', group_id: folder })
  const imported2 = await createTask(`Imported two ${stamp}`, { project, tags: [TAG], cwd: '/Users/dev/myCode/walnut', group_id: folder })
  const mine = await createTask(`My own task ${stamp}`, { project })

  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const bucket = projectBucket(page, project)
  await expect(bucket).toBeVisible({ timeout: 15_000 })

  // The cwd folder chip sits under the host project with the cwd-derived label.
  const chip = bucket.locator(`.task-group-chip[data-group-id="${folder}"]`)
  await expect(chip).toBeVisible()
  await expect(chip.locator('.task-group-chip-label')).toHaveText('myCode/walnut')

  // Pill on every imported row, none on the user's own row.
  for (const id of [imported1, imported2]) {
    const pill = row(page, id).locator('[data-testid="imported-pill"]')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveText('Imported')
    await expect(pill).toHaveAttribute('title', PILL_TITLE)
  }
  await expect(row(page, mine)).toBeVisible()
  await expect(row(page, mine).locator('[data-testid="imported-pill"]')).toHaveCount(0)

  // Crop to the project bucket so the evidence is the rows, not the whole page.
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await bucket.screenshot({ path: `${SHOT_DIR}/${browserName}-imported-rows.png` })

  // Adoption: the importer drops the tag when the session gets a message. The
  // web learns it over the WS task:updated and the pill goes, no reload.
  await api(`/api/tasks/${imported1}`, 'PATCH', { remove_tags: [TAG] })
  await expect(row(page, imported1).locator('[data-testid="imported-pill"]')).toHaveCount(0, { timeout: 10_000 })
  await expect(row(page, imported2).locator('[data-testid="imported-pill"]')).toBeVisible()
  await bucket.screenshot({ path: `${SHOT_DIR}/${browserName}-after-adoption.png` })

  // A completed import keeps its pill (still the imported type until adopted).
  await api(`/api/tasks/${imported2}`, 'PATCH', { phase: 'COMPLETE' })
  await expect(row(page, imported2)).toHaveClass(/todo-panel-item-done/, { timeout: 10_000 })
  await expect(row(page, imported2).locator('[data-testid="imported-pill"]')).toBeVisible()
  await shoot(page, `${browserName}-page`)
})
