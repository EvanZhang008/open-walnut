/**
 * Shared helpers for the filter-bar board specs (filter-bar-board.spec.ts and
 * filter-bar-board-entry.spec.ts): boot with isolated prefs and the tab bar on,
 * seed run-stamped tasks through the API, and read hit rows, tabs and the footer.
 */
import { expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

import { openHome } from './home-navigation-helpers'
import { addFilter, filterChip, filterDimRow, filterValue, openFilterMenu } from './filter-bar-helpers'

export const SHOTS = '/tmp/filterbar/shots'
export const QUICK_VIEWS_KEY = 'walnut-todo-quick-views-visible'
// Parallel workers can start in the same millisecond, so the stamp carries a random tail.
export const runStamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

export async function boot(page: Page, baseURL: string, extra?: Record<string, string>): Promise<void> {
  await isolateUiPrefs(page)
  await page.addInitScript(([qv, seed]) => {
    try {
      if (sessionStorage.getItem('pw-board-seeded')) return
      sessionStorage.setItem('pw-board-seeded', '1')
      localStorage.setItem(qv as string, 'true')
      localStorage.setItem('walnut-todo-collapsed-sections', '[]')
      for (const [k, v] of Object.entries(seed as Record<string, string>)) localStorage.setItem(k, v)
    } catch { /* ignore */ }
  }, [QUICK_VIEWS_KEY, extra ?? {}] as const)
  await openHome(page, baseURL, 90_000)
}

export interface Seed { title: string; phase?: string; pin?: string; start?: string }

/** Create tasks in `project`; phase / pin tier / start date are applied after creation. */
export async function seed(page: Page, project: string, specs: Seed[]): Promise<string[]> {
  const ids: string[] = []
  for (const s of specs) {
    const res = await page.request.post('/api/tasks', {
      data: { title: s.title, source: 'local', project },
    })
    expect(res.ok(), await res.text()).toBe(true)
    const id = (await res.json()).task.id as string
    if (s.start) expect((await page.request.patch(`/api/tasks/${id}`, { data: { start_date: s.start } })).ok()).toBe(true)
    // A REST-created task lands pinned (Satellite); only the ones asked for stay pinned.
    if (!s.pin) expect((await page.request.delete(`/api/focus/tasks/${id}`)).ok()).toBe(true)
    if (s.pin) {
      expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
      if (s.pin !== 'satellite') {
        expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier: s.pin } })).ok()).toBe(true)
      }
    }
    if (s.phase) expect((await page.request.patch(`/api/tasks/${id}`, { data: { phase: s.phase } })).ok()).toBe(true)
    ids.push(id)
  }
  return ids
}

export const cleanup = async (page: Page, ids: readonly string[]) => {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
}

export const row = (page: Page, id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"]`)
// Satellite draws cards, Focus draws rows: a pin is either.
export const card = (page: Page, id: string) => page.locator(`.todo-focus-card[data-task-id="${id}"], .todo-pinned-card[data-task-id="${id}"]`)
export const anyRow = (page: Page, id: string) => page.locator(`.todo-panel-item[data-task-id="${id}"], .todo-focus-card[data-task-id="${id}"], .todo-pinned-card[data-task-id="${id}"]`)
export const tab = (page: Page, name: string) => page.locator('.todo-section-tabs [role="tab"]', { hasText: name }).first()
export const tabCount = async (page: Page, name: string) => Number((await tab(page, name).locator('.todo-section-tab-count').textContent()) ?? 'NaN')
export const footer = (page: Page) => page.getByTestId('todo-filter-footer')

/** Every task id drawn as a real row (list rows and tier cards, override rows excluded). */
export async function hitIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids = new Set<string>()
    for (const el of document.querySelectorAll<HTMLElement>('.todo-panel .todo-panel-item[data-task-id], .todo-panel .todo-focus-card[data-task-id], .todo-panel .todo-pinned-card[data-task-id]')) {
      if (el.closest('.task-filter-override') || el.classList.contains('task-filter-override')) continue
      if (el.offsetParent === null) continue
      ids.add(el.dataset.taskId!)
    }
    return [...ids]
  })
}

export async function selectTab(page: Page, name: string): Promise<void> {
  await tab(page, name).click()
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true')
}

/** Filter to exactly these projects (first one replaces, the rest are added). */
export async function filterProjects(page: Page, projects: readonly string[]): Promise<void> {
  for (const [i, p] of projects.entries()) {
    // The values arrive with the board: wait until the row offers this one
    // (directly or behind `N more`) before the helper decides which path to take.
    await openFilterMenu(page)
    const more = filterDimRow(page, 'project').locator('.fb-val', { hasText: /^\s*\d+ more\s*$/ })
    await expect(filterValue(page, 'project', p).or(more).first()).toBeVisible({ timeout: 20_000 })
    await addFilter(page, 'project', p, { add: i > 0 })
  }
  await expect(filterChip(page, 'project')).toHaveCount(1)
}

/** The task panel (plus an optional extra box) as a screenshot clip, after finite animations settle. */
export async function panelClip(page: Page, extra?: ReturnType<Page['locator']>) {
  // Let finite animations (row entry, FLIP moves) end so the shot shows the settled board.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => undefined))))
  const panel = (await page.locator('.todo-panel').first().boundingBox())!
  let { x, y, width, height } = panel
  if (extra) {
    const b = await extra.boundingBox()
    if (b) {
      const right = Math.max(x + width, b.x + b.width); const bottom = Math.max(y + height, b.y + b.height)
      x = Math.min(x, b.x); y = Math.min(y, b.y); width = right - x; height = bottom - y
    }
  }
  return { x, y, width: Math.min(width, 1280), height: Math.min(height, 900) }
}
