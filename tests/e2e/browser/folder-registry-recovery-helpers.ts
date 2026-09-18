/**
 * Shared scenario for folder-registry-recovery.spec.ts and its WebKit twin.
 *
 * The 2026-09-17 report, as a browser test. A folder's NAME comes from one
 * request (`GET /api/tasks/groups`); its membership rides on `task.group_id` in
 * the task list. When that one request died at boot (the connection queue
 * rejected it while the server was stalled) the page drew every folder as a bare
 * icon + count and stayed that way until a manual reload: the task list retried,
 * the registry did not.
 *
 * The scenario kills the first GETs of the registry at the network layer the way
 * the incident did (the request never reaches the server), loads the home page,
 * and requires the folder's name to appear WITHOUT a reload.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

export interface Litter { tasks: string[]; folders: string[]; projects: string[] }

export function newLitter(): Litter {
  return { tasks: [], folders: [], projects: [] }
}

export async function sweepLitter(litter: Litter): Promise<void> {
  for (const id of litter.tasks) {
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const gid of litter.folders) {
    await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const name of litter.projects) {
    await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
  }
}

export interface SeededFolder { project: string; label: string; groupId: string; taskIds: string[] }

/** A unique project with two tasks filed in one named folder. */
export async function seedFolder(litter: Litter, tag: string): Promise<SeededFolder> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const project = `Recovery ${tag} ${suffix}`
  const taskIds: string[] = []
  for (const n of ['one', 'two']) {
    const res = await fetch(`${API}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `Folder member ${n} ${suffix}`, source: 'local', project }),
    })
    if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { task: { id: string } }
    litter.tasks.push(body.task.id)
    taskIds.push(body.task.id)
  }
  litter.projects.push(project)
  const label = `Marina ${suffix}`
  const res = await fetch(`${API}/api/tasks/groups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, label }),
  })
  if (!res.ok) throw new Error(`folder create failed: ${res.status} ${await res.text()}`)
  const groupId = ((await res.json()) as { group_id: string }).group_id
  litter.folders.push(groupId)
  return { project, label, groupId, taskIds }
}

/**
 * StrictMode (on in the dev fixture, off in production) mounts every effect
 * twice, so the boot fetch of the registry is issued twice within a few ms.
 * Every GET inside this window after the first one counts as "the boot fetch",
 * so a scenario means the same thing on both engines and in production.
 */
const BOOT_WINDOW_MS = 500

/**
 * Kill the boot fetch of the folder registry (every GET in the boot window) and
 * then `extraKills` more, all before they leave the browser so the server never
 * sees them (the incident's request died in the client's connection queue; here
 * it dies at the network layer, and both are retryable failures to
 * fetchWithRetry). Every later GET, and every non-GET, goes through. Returns a
 * live counter.
 */
export async function killRegistryGets(page: Page, extraKills: number): Promise<{ killed: number; passed: number }> {
  const tally = { killed: 0, passed: 0 }
  let firstAt = 0
  let extraKilled = 0
  await page.route('**/api/tasks/groups', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const now = Date.now()
    if (firstAt === 0) firstAt = now
    const inBootWindow = now - firstAt <= BOOT_WINDOW_MS
    if (inBootWindow || extraKilled < extraKills) {
      if (!inBootWindow) extraKilled++
      tally.killed++
      return route.abort('timedout')
    }
    tally.passed++
    return route.fallback()
  })
  return tally
}

export async function openHome(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  await page.goto('/')
}

/** The main list's folder header row for this folder. */
export function folderHeader(page: Page, groupId: string) {
  return page.locator(`.todo-group-project .task-group-chip[data-group-id="${groupId}"]`).first()
}

/**
 * Evidence for a human reviewer, only when PW_EVIDENCE_DIR is set: the project
 * bucket cropped, before and after the name arrives. Not an assertion.
 */
async function snapshotBucket(page: Page, project: string, name: string): Promise<void> {
  const dir = process.env.PW_EVIDENCE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const bucket: Locator = page.locator('.todo-group-project').filter({
    has: page.locator('.todo-group-project-name', { hasText: project }),
  }).first()
  await bucket.screenshot({ path: join(dir, `${name}.png`) }).catch(() => undefined)
}

/**
 * The whole scenario: registry dead at boot, chip drawn nameless, then the name
 * arrives on its own, and the page never reloaded to get it. `extraKills` is
 * how many recovery attempts die too: 0 lets the connect-time re-pull (or the
 * first retry) land, 1 kills that as well so the first scheduled retry has to,
 * 2 pushes it to the second retry.
 */
export async function expectFolderNameRecovers(page: Page, seeded: SeededFolder, extraKills: number): Promise<void> {
  const tally = await killRegistryGets(page, extraKills)
  // The retry path leaves a trace; requiring it proves the recovery came from
  // the code under test and not from a fetch that happened to be issued twice.
  const retryLines: string[] = []
  page.on('console', (m) => {
    const text = m.text()
    if (text.includes('task folder registry fetch failed, retrying in')) retryLines.push(text)
  })
  await openHome(page)

  const header = folderHeader(page, seeded.groupId)
  // Membership does not depend on the registry, so the row is there at once,
  await expect(header).toBeVisible({ timeout: 30_000 })
  const labelBeforeRecovery = await header.locator('.task-group-chip-label').textContent()
  await snapshotBucket(page, seeded.project, `${extraKills}-extra-before`)
  await expect(header.locator('.task-group-chip-count')).toHaveText('2')
  expect(tally.killed, 'the boot-time registry fetch must really have been killed').toBeGreaterThanOrEqual(1)
  // A marker that only survives if the page is NOT reloaded.
  await page.evaluate(() => { (window as unknown as { __noReloadProbe: number }).__noReloadProbe = 1 })

  // and the name follows from the retry, inside the registry schedule.
  await expect(header.locator('.task-group-chip-label')).toHaveText(seeded.label, { timeout: 20_000 })
  await snapshotBucket(page, seeded.project, `${extraKills}-extra-after`)
  // Informational: what the user saw while the registry was dead. It is '' in
  // practice; not asserted because a fast re-pull can legitimately beat this read.
  console.log(`[folder-registry-recovery] label before recovery: ${JSON.stringify(labelBeforeRecovery)}`)

  expect(tally.killed).toBeGreaterThanOrEqual(1 + extraKills)
  expect(tally.passed).toBeGreaterThanOrEqual(1)
  expect(retryLines.length, 'the recovery must come from the retry path, not from an unrelated re-fetch').toBeGreaterThanOrEqual(1)
  const probe = await page.evaluate(() => (window as unknown as { __noReloadProbe?: number }).__noReloadProbe)
  expect(probe, 'the name must arrive without a page reload').toBe(1)
}
