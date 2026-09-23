/**
 * A page load must not spend the browser's six connections on work nobody is
 * looking at, nor throw away the task list it already has (2026-09-23 report:
 * after a refresh the Focus list took 10.8s and the draft's quick folders 5s).
 * Three causes, three contracts pinned here against a real server:
 *
 *   1. the post-connect "safety" refetch of the task list is skipped when the
 *      first read left after the socket was up (useTasks), so a production page
 *      reads the list once;
 *   2. the "/" palette's 1.2MB skill list is read at most twice (it was three
 *      times: commands/index.ts, the plugin loader's first run, the first
 *      connect), and it rides the low-priority lane (api/client);
 *   3. the list does not wait for the per-session status batches (api/tasks):
 *      it paints while they are still running.
 *
 * And the behaviour those reads feed still works: a draft's "/" palette lists
 * skills, and the draft's quick folders render.
 */
import { test, expect, type Page } from '@playwright/test'
import { draftComposer, draftPanel, loadHome, openDraft } from './draft-helpers'
import { presetPanelView } from './todo-panel-helpers'

test.setTimeout(120_000)

interface Seen { path: string; search: string; at: number }

function watchRequests(page: Page): Seen[] {
  const seen: Seen[] = []
  const t0 = Date.now()
  page.on('request', (req) => {
    if (req.method() !== 'GET') return
    const url = new URL(req.url())
    if (url.pathname.startsWith('/api/')) seen.push({ path: url.pathname, search: url.search, at: Date.now() - t0 })
  })
  return seen
}

test('one reload reads the task list once, the skill list at most twice, and paints the list before the status batches finish', async ({ page }) => {
  // A view with rows on screen (the fixture's default groups by collapsed project).
  await presetPanelView(page, { section: 'all', project: '' })
  // Warm load first: the fixture serves the SPA through Vite DEV, whose first
  // dependency pass reloads the page once. The user's case is a refresh anyway.
  await loadHome(page)

  // Hold every status batch until the list has painted: under the old
  // "await hydration" the rows could not appear while any batch was open.
  let releaseStatus: () => void = () => {}
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve })
  let heldStatus = 0
  await page.route('**/api/sessions/status?**', async (route) => {
    heldStatus++
    await statusGate
    // The page may have moved on (test teardown) while this batch was held.
    await route.continue().catch(() => {})
  })

  const seen = watchRequests(page)
  const t0 = Date.now()
  const trail: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (/\[tasks\]|\[ws\] state|FAILED/.test(t)) trail.push(`${Date.now() - t0} ${t.slice(0, 140)}`)
  })
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  // Contract 3: rows render while status batches are still being held.
  await expect(page.locator('#home-task-navigation [data-task-id]').first()).toBeVisible({ timeout: 30_000 })
  const heldWhilePainted = heldStatus
  releaseStatus()
  // The fixture's tasks carry sessions, so at least one batch was open.
  expect(heldWhilePainted, 'the list must paint while a status batch is still open').toBeGreaterThan(0)

  // Let the post-connect window (1s debounce) and the plugin loader's connect
  // refresh (250ms coalesce) pass before counting.
  await page.waitForTimeout(4_000)
  const log = trail.join('\n')
  // Contract 1, read from useTasks' own decision (the raw count is not usable
  // here: React StrictMode in the DEV build runs the mount effect twice, so a
  // dev page issues two list reads where a production page issues one; the
  // production count is measured separately against real data).
  expect(log, 'contract 1: the post-connect refetch must be skipped').toContain('ws connected → list request left after the connect; no refetch')
  expect(log).not.toContain('ws connected → refetching tasks')
  const lists = seen.filter((r) => r.path === '/api/tasks' && r.search.includes('fields=list'))
  expect(lists.length, `list reads ${JSON.stringify(lists.map((r) => r.at))}\n${log}`).toBeLessThanOrEqual(2)
  const skills = seen.filter((r) => r.path === '/api/skills')
  expect(skills.length, `contract 2: skill list reads ${JSON.stringify(skills.map((r) => r.at))}`).toBeGreaterThanOrEqual(1)
  expect(skills.length).toBeLessThanOrEqual(2)
})

test('after a reload a draft still gets its quick folders and a "/" palette that lists skills', async ({ page }) => {
  await loadHome(page)
  await page.reload()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

  const panel = await openDraft(page)
  await expect(panel.locator('.draft-quick-chips .draft-quick-chip').first()).toBeVisible({ timeout: 20_000 })

  const composer = draftComposer(page)
  await composer.click()
  await composer.pressSequentially('/')
  const palette = page.locator('.command-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  // Skills arrive on the low lane; the palette must still get them.
  await expect(palette.locator('.command-palette-source-skill').first()).toBeVisible({ timeout: 20_000 })
  await expect(draftPanel(page)).toBeVisible()
})
