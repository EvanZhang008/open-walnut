/**
 * The Home list keeps the rows a person is reading in place while other clients add and remove
 * tasks above them, in Chromium and in WebKit (the Mac app).
 *
 * 2026-11-10: with a project open and the list scrolled into it (scrollTop about 720), a task
 * another client added to that project threw the list back near its top. Two causes, one per
 * engine. The list drew the new task at the end of its project for one commit and moved it to its
 * sorted place the next, so React moved every row it passed, and Chromium's scroll anchoring lost
 * the row being read on those moves. WebKit has no scroll anchoring at all, so even a plain insert
 * above the view pushed every row on screen down by its height.
 *
 * Every case adds or removes rows ABOVE the ones on screen (each checks that), in the All view,
 * where the whole column scrolls, and in the Projects view, where the list scrolls by itself.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, listProjectHeader, openListProject } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'
import { chooseViewOption, openHome } from './home-navigation-helpers'

// WebKit moves the rows by each added row's height until the list anchors them by hand.
test.skip(({ browserName }) => browserName === 'webkit', 'no scroll anchoring in WebKit yet')

const made: string[] = []
let tag = ''

async function make(page: Page, title: string, project: string): Promise<string> {
  // Unpinned from the start, so it lands in its project's list at once.
  const res = await page.request.post('/api/tasks', { data: { title: `${title} ${tag}`, project, source: 'local', pinned: false } })
  expect(res.ok()).toBe(true)
  const id = (await res.json()).task.id as string
  made.push(id)
  return id
}

async function drop(page: Page, id: string): Promise<void> {
  const res = await page.request.delete(`/api/tasks/${id}?force=true`)
  expect(res.ok()).toBe(true)
}

test.beforeEach(() => {
  tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`
  made.length = 0
})

test.afterEach(async ({ request }) => {
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

// Each evaluate below finds the box that scrolls the list itself (they run in the page and share
// no code): the whole column in the stacked views, else the list.

/** The task rows wholly inside the scroll box, with their top on screen. */
async function rowsOnScreen(page: Page): Promise<Map<string, number>> {
  const rows = await page.evaluate(() => {
    const outer = document.querySelector('.home-navigation-scroll') as HTMLElement
    const el = (outer.classList.contains('is-stacked') ? outer : outer.querySelector('.todo-panel-list')) as HTMLElement
    const r = el.getBoundingClientRect()
    return Array.from(el.querySelectorAll('.todo-panel-item[data-task-id]'))
      .map((row) => ({ id: row.getAttribute('data-task-id')!, rect: row.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.top >= r.top && rect.bottom <= r.bottom)
      .map(({ id, rect }) => [id, rect.top] as [string, number])
  })
  return new Map(rows)
}

/** Every row still drawn sits within 3px of where it was; most of them are still drawn. */
function expectHeld(now: Map<string, number>, before: Map<string, number>, what: string) {
  const moved: string[] = []
  let kept = 0
  for (const [id, top] of before) {
    const at = now.get(id)
    if (at === undefined) continue
    kept++
    if (Math.abs(at - top) > 3) moved.push(`${id.slice(0, 8)} ${Math.round(top)} -> ${Math.round(at)}`)
  }
  expect(moved, `${what}: rows on screen moved`).toEqual([])
  expect(kept, `${what}: rows on screen left the view`).toBeGreaterThanOrEqual(Math.min(4, before.size))
}

/** Whether a row sits above the top of the scroll box, out of sight. */
const aboveView = (page: Page, id: string) => page.evaluate((rowId) => {
  const outer = document.querySelector('.home-navigation-scroll') as HTMLElement
  const el = (outer.classList.contains('is-stacked') ? outer : outer.querySelector('.todo-panel-list')) as HTMLElement
  const row = el.querySelector(`[data-task-id="${CSS.escape(rowId)}"]`)
  return !!row && row.getBoundingClientRect().bottom <= el.getBoundingClientRect().top
}, id)

/**
 * A project of 24 rows on a short window, opened, and the list scrolled 240px past its header,
 * so its first rows are above the view and the ones on screen are in the middle of it.
 */
async function openScrolledProject(page: Page, baseURL: string, project: string, view?: string): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 640 })
  const ids: string[] = []
  // One at a time, so their order (newest first) is fixed.
  for (let i = 0; i < 24; i++) ids.push(await make(page, `row ${i}`, project))
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'project')
  await openHome(page, baseURL)
  if (view) await chooseViewOption(page, view)
  await openListProject(page, project)
  await expect(page.locator(`[data-task-id="${ids[ids.length - 1]}"]`)).toBeAttached()
  const scrolled = await listProjectHeader(page, project).evaluate((header) => {
    const outer = document.querySelector('.home-navigation-scroll') as HTMLElement
    const el = (outer.classList.contains('is-stacked') ? outer : outer.querySelector('.todo-panel-list')) as HTMLElement
    el.scrollTop += header.getBoundingClientRect().top - el.getBoundingClientRect().top + 240
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
  })
  // Scrolled into the project, with room left below: an end-of-list clamp is another case.
  expect(scrolled.top).toBeGreaterThan(200)
  expect(scrolled.max - scrolled.top).toBeGreaterThan(100)
  await frames(page)
  return ids
}

async function addAndRemoveAbove(page: Page, project: string, ids: string[]) {
  let shown = await rowsOnScreen(page)
  expect(shown.size).toBeGreaterThanOrEqual(6)

  // Another client adds a task: newest first, so it lands at the top of the project, above the view.
  const added = await make(page, 'arrival', project)
  await expect(page.locator(`[data-task-id="${added}"]`)).toBeAttached()
  await frames(page)
  expectHeld(await rowsOnScreen(page), shown, 'one task added above')
  expect(await aboveView(page, added)).toBe(true)

  // Two at once.
  shown = await rowsOnScreen(page)
  const pair = await Promise.all([make(page, 'arrival a', project), make(page, 'arrival b', project)])
  for (const id of pair) await expect(page.locator(`[data-task-id="${id}"]`)).toBeAttached()
  await frames(page)
  expectHeld(await rowsOnScreen(page), shown, 'two tasks added above')

  // Removed again, and one of the project's own rows above the view with them.
  shown = await rowsOnScreen(page)
  const top = ids[ids.length - 1]
  expect(await aboveView(page, top)).toBe(true)
  for (const id of [added, ...pair, top]) {
    await drop(page, id)
    await expect(page.locator(`[data-task-id="${id}"]`)).toHaveCount(0)
    await frames(page)
    expectHeld(await rowsOnScreen(page), shown, `task ${id.slice(0, 8)} removed above`)
  }

  // Past the list's 3 s re-sort debounce: nothing moves late either.
  await page.waitForTimeout(3500)
  expectHeld(await rowsOnScreen(page), shown, 'after the re-sort debounce')
}

test('the All view keeps the rows on screen while tasks come and go above them in an open project', async ({ page, baseURL }) => {
  // Projects are listed by name: "0 …" comes first, with the fixture's other projects below it.
  const project = `0 Keeps place ${tag}`
  const ids = await openScrolledProject(page, baseURL!, project)
  await expect(page.locator('.home-navigation-scroll')).toHaveClass(/is-stacked/)
  await addAndRemoveAbove(page, project, ids)
})

test('the Projects view keeps the rows on screen while tasks come and go above them in an open project', async ({ page, baseURL }) => {
  const project = `0 Keeps place list ${tag}`
  const ids = await openScrolledProject(page, baseURL!, project, 'tasks')
  await expect(page.locator('.home-navigation-scroll')).not.toHaveClass(/is-stacked/)
  await addAndRemoveAbove(page, project, ids)
})
