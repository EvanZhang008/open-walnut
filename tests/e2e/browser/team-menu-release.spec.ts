/**
 * The task kebab's Team row (web/src/components/tasks/TeamMenuItems.tsx), as a
 * user meets it in a session column's header ⋮ (2026-10-05 ask: "an option to
 * unadopt a worker, or a worker unadopts its parent, in the menu but collapsed,
 * because it is not important; a click expands it").
 *
 *   1. Collapsed by default, with the pills' words (`Team: Leader · 2`); a click
 *      expands Adopt a worker… and Release a worker…; a second click folds it;
 *      every reopen of the menu starts folded.
 *   2. Release a worker… lists the leader's workers, open ones first and the
 *      finished one last, with no filter for a short team; a pick detaches that
 *      worker on the server and in the header pill, and closes picker and menu.
 *   3. A worker released elsewhere (API) leaves the open picker at once.
 *   4. Escape closes the picker alone, then the menu.
 *   5. A big team (12 workers) gets a filter; Enter releases the highlighted one.
 *
 * The leader is a fixture column with a long transcript; the chromium and webkit
 * projects share one fixture board, so each engine takes its own leader.
 */
import { test, expect, type Locator, type Page, type Response } from '@playwright/test'
import fs from 'node:fs/promises'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'

const KEYS = ['a', 'b', 'c'] as const
type Key = (typeof KEYS)[number]
const SID = (k: Key) => `pw-rollup-${k}-session`
const TID = (k: Key) => `pw-task-rollup-${k}`
const SHOTS = '/tmp/team-menu-release'
const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

const col = (page: Page, k: Key) => page.locator(`.main-page-session-column[data-column-id="${SID(k)}"]`)
const menu = (page: Page) => page.locator('.task-kebab-menu:visible')
const flyout = (page: Page) => page.getByTestId('release-worker-flyout')

interface TaskRow { id: string; phase: string; parent_task_id?: string; title: string }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
const parentOf = async (id: string) => (await api<{ task: TaskRow }>('GET', `/api/tasks/${id}`)).task.parent_task_id || ''

const litter: string[] = []

// Both tests count the same leader's workers: one at a time per engine.
test.describe.configure({ mode: 'serial' })
// deviceScaleFactor 1: evidence shots stay 1280px wide in WebKit too.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(180_000)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', '0') } catch { /* off */ }
  })
  await fs.mkdir(SHOTS, { recursive: true })
})

test.afterEach(async () => {
  for (const id of litter.splice(0)) await fetch(`${API}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
})

async function inViewport(page: Page, el: Locator): Promise<void> {
  const box = (await el.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5)
}

async function setup(page: Page, browserName: string, workers: number) {
  const k: Key = browserName === 'webkit' ? 'c' : 'b'
  const leader = TID(k)
  const stamp = `${browserName}-${Date.now().toString(36)}`
  const mk = async (title: string) => {
    const { task } = await api<{ task: TaskRow }>('POST', '/api/tasks', { title, source: 'local', project: 'Walnut', parent_task_id: leader })
    litter.push(task.id)
    return task.id
  }
  const ids: string[] = []
  for (let i = 0; i < workers; i++) ids.push(await mk(`Team worker ${String(i + 1).padStart(2, '0')} ${stamp}`))
  const failed: string[] = []
  page.on('response', (r: Response) => {
    if (r.url().includes('/api/') && r.status() >= 400) failed.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`)
  })
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  return { k, leader, stamp, mk, ids, failed, pageErrors }
}

async function openHomeWithColumns(page: Page, k: Key): Promise<void> {
  await setPanelMode(page, '3')
  await seedColumns(page, KEYS.map(SID))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })
  await expect(col(page, k).getByText(`roll-up ${k} answer 45`)).toBeVisible({ timeout: 30_000 })
}

async function openKebab(page: Page, k: Key): Promise<Locator> {
  await col(page, k).locator('.session-panel-header .task-kebab-btn').click()
  await expect(menu(page)).toBeVisible()
  return menu(page)
}

test('the Team row is collapsed, expands on click, and releases a worker', async ({ page, browserName }, info) => {
  const t = await setup(page, browserName, 0)
  const waiting = await t.mk(`Waiting worker ${t.stamp}`)
  await api('PATCH', `/api/tasks/${waiting}`, { phase: 'NEED_ACTION' })
  // Test data: a CJK title (escaped).
  const cjk = await t.mk(`\u6bcf\u65e5\u6458\u8981 worker ${t.stamp}`)
  const finished = await t.mk(`Finished worker ${t.stamp}`)
  await api('POST', `/api/tasks/${finished}/complete`)
  await openHomeWithColumns(page, t.k)
  const pill = col(page, t.k).locator('[data-testid="leader-pill"]').first()
  await expect(pill).toHaveText('Leader · 2', { timeout: 20_000 })

  // 1. Collapsed: one row that says where the task stands; nothing else shows.
  let m = await openKebab(page, t.k)
  const toggle = m.getByTestId('kebab-team-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toContainText('Team: Leader · 2')
  await expect(m.getByTestId('kebab-adopt-worker')).toHaveCount(0)
  await expect(m.getByTestId('kebab-release-worker')).toHaveCount(0)
  await m.screenshot({ path: `${SHOTS}/${info.project.name}-1-collapsed.png` })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(m.getByTestId('kebab-adopt-worker')).toBeVisible()
  await expect(m.getByTestId('kebab-release-worker')).toBeVisible()
  // A leader with no leader of its own has nothing to leave.
  await expect(m.getByTestId('kebab-leave-leader')).toHaveCount(0)
  await inViewport(page, m)
  await m.screenshot({ path: `${SHOTS}/${info.project.name}-2-expanded.png` })

  // A second click folds it again.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(m.getByTestId('kebab-release-worker')).toHaveCount(0)
  await toggle.click()

  // 2. Release a worker…: open ones first, the finished one last, no filter for three.
  await m.getByTestId('kebab-release-worker').click()
  await expect(flyout(page)).toBeVisible()
  const rows = flyout(page).locator('[data-testid="release-worker-row"]')
  await expect(rows).toHaveCount(3)
  // Open ones first (in the board's order), the finished one last.
  const order = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  expect(order.slice(0, 2).sort()).toEqual([waiting, cjk].sort())
  expect(order[2]).toBe(finished)
  const rowOf = (id: string) => flyout(page).locator(`[data-testid="release-worker-row"][data-task-id="${id}"]`)
  await expect(rowOf(waiting)).toContainText('Need Action')
  await expect(rowOf(finished)).toContainText('Complete')
  await expect(flyout(page).locator('.adopt-worker-filter')).toHaveCount(0)
  await inViewport(page, flyout(page))
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-3-release-picker.png` })

  await rowOf(waiting).click()
  await expect(flyout(page)).toHaveCount(0)
  await expect(menu(page)).toHaveCount(0)
  await expect.poll(() => parentOf(waiting)).toBe('')
  await expect(pill).toHaveText('Leader · 1')
  // The others stay in the team.
  expect(await parentOf(cjk)).toBe(t.leader)
  expect(await parentOf(finished)).toBe(t.leader)

  // A reopened menu starts folded, with the new count.
  m = await openKebab(page, t.k)
  await expect(m.getByTestId('kebab-team-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(m.getByTestId('kebab-team-toggle')).toContainText('Team: Leader · 1')

  // 3. A worker released elsewhere leaves the open picker at once, nothing written from here.
  await m.getByTestId('kebab-team-toggle').click()
  await m.getByTestId('kebab-release-worker').click()
  await expect(rows).toHaveCount(2)
  const patches: string[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/tasks')) patches.push(new URL(r.url()).pathname) })
  await api('PATCH', `/api/tasks/${cjk}`, { parent_task_id: '' })
  await expect(flyout(page).locator(`[data-task-id="${cjk}"]`)).toHaveCount(0, { timeout: 15_000 })
  await expect(rows).toHaveCount(1)
  expect(patches).toEqual([])

  // 4. Escape: the picker first, the menu after.
  await page.keyboard.press('Escape')
  await expect(flyout(page)).toHaveCount(0)
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  // 5. The last worker released elsewhere while the picker is open closes the
  // picker and takes the Release row away; adopting one again brings the row
  // back but never reopens the picker by itself.
  m = await openKebab(page, t.k)
  await m.getByTestId('kebab-team-toggle').click()
  await m.getByTestId('kebab-release-worker').click()
  await expect(rows).toHaveCount(1)
  await api('PATCH', `/api/tasks/${finished}`, { parent_task_id: '' })
  await expect(flyout(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(m.getByTestId('kebab-release-worker')).toHaveCount(0)
  await expect(m.getByTestId('kebab-team-toggle')).not.toContainText('Leader')
  await expect(m.getByTestId('kebab-adopt-worker')).toBeVisible()
  await api('PATCH', `/api/tasks/${finished}`, { parent_task_id: t.leader })
  await expect(m.getByTestId('kebab-release-worker')).toBeVisible({ timeout: 15_000 })
  await expect(m.getByTestId('kebab-team-toggle')).toContainText('Team: Leader · 1 done')
  await expect(flyout(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)

  expect(t.failed, 'no API request failed').toEqual([])
  expect(t.pageErrors).toEqual([])
})

test('a big team gets a filter, and Enter releases the highlighted worker', async ({ page, browserName }, info) => {
  const t = await setup(page, browserName, 12)
  await openHomeWithColumns(page, t.k)
  await expect(col(page, t.k).locator('[data-testid="leader-pill"]').first()).toHaveText('Leader · 12', { timeout: 20_000 })

  const m = await openKebab(page, t.k)
  await expect(m.getByTestId('kebab-team-toggle')).toContainText('Team: Leader · 12')
  await m.getByTestId('kebab-team-toggle').click()
  await m.getByTestId('kebab-release-worker').click()
  const rows = flyout(page).locator('[data-testid="release-worker-row"]')
  await expect(rows).toHaveCount(12)
  const filter = flyout(page).locator('.adopt-worker-filter')
  await expect(filter).toBeFocused()
  await inViewport(page, flyout(page))
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-4-big-team.png` })

  await filter.fill(`worker 07 ${t.stamp}`)
  await expect(rows).toHaveCount(1)
  await filter.press('Enter')
  await expect(flyout(page)).toHaveCount(0)
  await expect.poll(() => parentOf(t.ids[6])).toBe('')
  await expect(col(page, t.k).locator('[data-testid="leader-pill"]').first()).toHaveText('Leader · 11')
  for (const id of t.ids.filter((_, i) => i !== 6)) expect(await parentOf(id)).toBe(t.leader)

  expect(t.failed, 'no API request failed').toEqual([])
  expect(t.pageErrors).toEqual([])
})
