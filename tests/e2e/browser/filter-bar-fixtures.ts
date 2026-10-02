/**
 * Board stubs and small measuring helpers for the Filter bar specs
 * (filter-bar.spec.ts, filter-bar-dense.spec.ts). `stubBoard` answers every
 * board read for ONE page (tasks, pins, projects, folders, tiers) so a spec
 * sees exactly its own data density and never writes to the fixture server.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { filterButton, filterMenu, filterRow } from './filter-bar-helpers'

export const SHOTS = '/tmp/filterbar/shots'

export type Seed = { id: string; title: string; project?: string; phase?: string; source?: string; tags?: string[]; blocked?: boolean }

export function stubTask(s: Seed, i: number): Record<string, unknown> {
  const at = new Date(Date.now() - (i + 1) * 60_000).toISOString()
  const phase = s.phase ?? 'TODO'
  const status = phase === 'COMPLETE' ? 'done' : phase === 'TODO' ? 'todo' : 'in_progress'
  return {
    id: s.id, title: s.title, status, phase, priority: 'none', project: s.project ?? '', source: s.source ?? 'local',
    tags: s.tags ?? [], created_at: at, updated_at: at, description: '', summary: '', note: '', subtasks: [], session_ids: [],
    ...(phase === 'COMPLETE' ? { completed_at: at } : {}),
  }
}

/** Answer every board read for THIS page: tasks, pins, projects, folders, tiers. */
export async function stubBoard(page: Page, seeds: Seed[], pins: string[] = [], opts: { tabBar?: boolean } = {}): Promise<void> {
  await isolateUiPrefs(page)
  // The tab bar is off on a fresh browser; specs that measure it turn it on.
  if (opts.tabBar) await page.addInitScript(() => localStorage.setItem('walnut-todo-quick-views-visible', 'true'))
  const tasks = seeds.map(stubTask)
  const projects = [...new Set(seeds.map((s) => s.project ?? ''))]
  await page.addInitScript((open) => {
    if (localStorage.getItem('walnut-todo-list-opened') === null) localStorage.setItem('walnut-todo-list-opened', open)
  }, JSON.stringify(projects))
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('**/api/tasks?*', async (route) => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.continue()
    await route.fulfill({ json: { tasks, completedHidden: 0 } })
  })
  await page.route('**/api/tasks/groups', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { groups: [] } }) : route.continue())
  await page.route('**/api/focus/tasks', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { pinned_tasks: pins, focus_tasks: [], satellite_tasks: pins, backlog_tasks: [], wait_tasks: [], custom_tier_tasks: {} } })
    : route.continue())
  await page.route('**/api/focus/tiers', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { tiers: [] } }) : route.continue())
  const counts = { todo: 0, active: 0, done: 0 }
  await page.route((url) => url.pathname === '/api/projects', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { projects: projects.filter(Boolean).map((name) => ({ name, source: 'local', favorite: false, counts })), inbox: { counts } } })
    : route.continue())
}

/** Mia: Home 3 + Garden 2 open, one Garden task complete, one pin in each project. */
export const MIA: Seed[] = [
  { id: 'fb-mia-h1', title: 'Fix the fence', project: 'Home' },
  { id: 'fb-mia-h2', title: 'Paint the hallway', project: 'Home' },
  { id: 'fb-mia-h3', title: 'Clean the gutters', project: 'Home', phase: 'IN_PROGRESS' },
  { id: 'fb-mia-g1', title: 'Water the roses', project: 'Garden' },
  { id: 'fb-mia-g2', title: 'Plant tulip bulbs', project: 'Garden' },
  { id: 'fb-mia-g3', title: 'Buy compost', project: 'Garden', phase: 'COMPLETE' },
]
export const MIA_PINS = ['fb-mia-h1', 'fb-mia-g1']

/** Owner: 400 tasks over Walnut, iOS App and Project 01..28; Local + Microsoft To Do; 80 tags. */
export function ownerSeeds(withInbox = false): Seed[] {
  const names = ['Walnut', 'iOS App', ...Array.from({ length: 28 }, (_, i) => `Project ${String(i + 1).padStart(2, '0')}`)]
  const out: Seed[] = []
  for (let i = 0; i < 400; i++) {
    out.push({
      id: `fb-own-${i}`, title: `Owner task ${i}`, project: names[i % names.length],
      source: i % 4 === 0 ? 'ms-todo' : 'local', tags: [`label:t${String(i % 80).padStart(2, '0')}`],
      phase: i % 10 === 0 ? 'IN_PROGRESS' : 'TODO',
    })
  }
  if (withInbox) out.push({ id: 'fb-own-inbox', title: 'Loose idea', project: '' })
  return out
}

export async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect(filterButton(page)).toBeVisible({ timeout: 30_000 })
}

export const row = (page: Page, id: string) => page.locator(`.todo-panel [data-task-id="${id}"]`).first()
export const listIds = (page: Page) => page.locator('.todo-panel-list .todo-panel-item[data-task-id]')
  .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-task-id')))].sort())
export const box = async (l: Locator) => (await l.boundingBox())!
export const badge = (page: Page) => page.getByTestId('filter-badge')
export const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')

/** A <= 1280px wide clip around the toolbar, the row and the popover. */
export async function clipAround(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const parts = [page.locator('#home-task-navigation .todo-panel-toolbar'), filterRow(page), filterMenu(page)]
  const boxes = (await Promise.all(parts.map(async (l) => ((await l.count()) ? l.first().boundingBox() : null)))).filter(Boolean) as { x: number; y: number; width: number; height: number }[]
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 8)
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 8)
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 8
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8
  return { x, y, width: Math.min(1280, right - x), height: bottom - y }
}

/** WCAG contrast of an element's text against the opaque stack of backgrounds behind it. */
export function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? ['0', '0', '0', '0']).map(Number)
    const layers: number[][] = []
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const [r, g, b, a = 1] = parse(getComputedStyle(n).backgroundColor)
      if (a > 0) layers.push([r, g, b, a])
      if (a >= 1) break
    }
    let bg = [255, 255, 255]
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
    const [fr, fg, fb, fa = 1] = parse(getComputedStyle(el).color)
    const fgc = [fr * fa + bg[0] * (1 - fa), fg * fa + bg[1] * (1 - fa), fb * fa + bg[2] * (1 - fa)]
    const lum = (c: number[]) => {
      const [R, G, B] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * R + 0.7152 * G + 0.0722 * B
    }
    const [l1, l2] = [lum(fgc), lum(bg)].sort((x, y) => y - x)
    return (l1 + 0.05) / (l2 + 0.05)
  }, selector)
}

/** Wait until an overlay is placed (not parked at left -9999) and its open animation ended. */
export async function settled(l: Locator): Promise<void> {
  await expect.poll(async () => (await l.boundingBox())?.x ?? -1, { timeout: 5_000 }).toBeGreaterThanOrEqual(0)
  await l.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
}
