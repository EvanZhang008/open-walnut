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
import { arrange, chooseViewOption, openHome } from './home-navigation-helpers'

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
async function openScrolledProject(page: Page, baseURL: string, project: string, view?: string, manual = false, past = 240): Promise<string[]> {
  await page.setViewportSize({ width: 1280, height: 640 })
  const ids: string[] = []
  // One at a time, so their order (newest first) is fixed.
  for (let i = 0; i < 24; i++) ids.push(await make(page, `row ${i}`, project))
  // A second project of this spec's own, opened right below (listed by name), keeps the list's end
  // well below the view, so a project another spec removes on the shared fixture never shortens
  // the list under the scroll position (the browser would clamp it and move every row).
  const tail = `${project} tail`
  await Promise.all(Array.from({ length: 24 }, (_, i) => make(page, `tail ${i}`, tail)))
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'project')
  await openHome(page, baseURL)
  if (view) await chooseViewOption(page, view)
  if (manual) await arrange(page, 'Manual')
  await openListProject(page, tail)
  await openListProject(page, project)
  await expect(page.locator(`[data-task-id="${ids[ids.length - 1]}"]`)).toBeAttached()
  const scrolled = await listProjectHeader(page, project).evaluate((header, by) => {
    const outer = document.querySelector('.home-navigation-scroll') as HTMLElement
    const el = (outer.classList.contains('is-stacked') ? outer : outer.querySelector('.todo-panel-list')) as HTMLElement
    el.scrollTop += header.getBoundingClientRect().top - el.getBoundingClientRect().top + by
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
  }, past)
  // Scrolled into the project, far from the end: an end-of-list clamp is another case.
  expect(scrolled.top).toBeGreaterThan(past > 0 ? 200 : 0)
  expect(scrolled.max - scrolled.top).toBeGreaterThan(400)
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

/** The list's scroll position, and each task row wholly on screen with its top, in list order. */
const shownRows = (page: Page) => page.evaluate(() => {
  const outer = document.querySelector('.home-navigation-scroll') as HTMLElement
  const el = (outer.classList.contains('is-stacked') ? outer : outer.querySelector('.todo-panel-list')) as HTMLElement
  const r = el.getBoundingClientRect()
  const rows = Array.from(el.querySelectorAll('.todo-panel-item[data-task-id]'))
    .map((row) => ({ id: row.getAttribute('data-task-id')!, top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom }))
  return {
    scrollTop: el.scrollTop,
    paneTop: r.top,
    // The row a person reads at: the first one that reaches below the box's top edge.
    first: rows.find((row) => row.bottom > r.top)?.id ?? '',
    whole: rows.filter((row) => row.top >= r.top && row.bottom <= r.bottom),
  }
})

test('a drop in a manual project keeps the dropped row on screen and the list where it was', async ({ page, baseURL }) => {
  // The Projects view, its header at the list's top edge: the project's first row, A, is the row
  // the list holds. Other projects come before it. A is dragged down past B, four rows further:
  // the drop moves the held row itself, and the pointer stays clear of the edges that scroll a drag.
  const project = `Keeps place drag ${tag}`
  await openScrolledProject(page, baseURL!, project, 'tasks', true, 0)
  const before = await shownRows(page)
  const a = before.whole.find((r) => r.id === before.first)
  const b = before.whole[before.whole.indexOf(a!) + 4]
  expect(a && b).toBeTruthy()
  const row = (id: string) => page.locator(`.home-navigation-scroll .todo-panel-item[data-task-id="${id}"]`)
  const from = (await row(a!.id).boundingBox())!
  const to = (await row(b.id).boundingBox())!
  const x = from.x + from.width * 0.4
  await page.mouse.move(x, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 4 })
  // A's middle onto B's middle (the pointer holds A by its middle): A takes B's place, after it.
  await page.mouse.move(x, to.y + to.height / 2 - 1, { steps: 16 })
  await frames(page)
  await page.mouse.move(x, to.y + to.height / 2, { steps: 2 })
  await frames(page)
  const atDrop = await shownRows(page)
  await page.mouse.up()
  // The drop landed: A now comes after B.
  await expect.poll(() => row(a!.id).evaluate((el, bId) => {
    const other = document.querySelector(`.home-navigation-scroll .todo-panel-item[data-task-id="${bId}"]`)!
    return !!(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING)
  }, b.id)).toBe(true)
  await page.waitForTimeout(600)
  await frames(page)
  const after = await shownRows(page)
  // C, the row after B, is where it was when A was let go: the list did not scroll after the row
  // the drop moved. Screen places, not scrollTop: on a shared fixture other specs add and remove
  // rows above, and holding the rows on screen then changes scrollTop.
  const c = atDrop.whole.find((r) => r.id === before.whole[before.whole.indexOf(a!) + 5]?.id)
  expect(c, 'the row after B is on screen at the drop').toBeTruthy()
  const cAfter = after.whole.find((r) => r.id === c!.id)
  expect(cAfter, 'the row after B left the view').toBeTruthy()
  expect(Math.abs(cAfter!.top - c!.top), 'the list scrolled after the drop').toBeLessThanOrEqual(30)
  // A shows where it was dropped: right before C in the list, and on screen once the drop has
  // settled (its drop animation rides a transform, slower in WebKit under load).
  expect(await row(c!.id).evaluate((el) => {
    const rows = Array.from(document.querySelectorAll('.home-navigation-scroll .todo-panel-item[data-task-id]'))
    return rows[rows.indexOf(el) - 1]?.getAttribute('data-task-id') ?? ''
  }), 'the dropped row is not right before the row after B').toBe(a!.id)
  await expect.poll(async () => (await shownRows(page)).whole.some((r) => r.id === a!.id), { message: 'the dropped row left the view' }).toBe(true)
})

test('a re-sort that takes the row at the top of the view away does not scroll the list after it', async ({ page, baseURL }) => {
  const project = `0 Keeps place resort ${tag}`
  await openScrolledProject(page, baseURL!, project)
  const before = await shownRows(page)
  expect(before.first).not.toBe('')
  // The row a person reads by once the top one is gone: the second one on screen.
  const next = before.whole.find((r) => r.id !== before.first)!
  expect(next).toBeTruthy()
  // New activity on it: the list holds its place for 3 s, then sorts it to the top of its
  // project, far above the view.
  expect((await page.request.patch(`/api/tasks/${before.first}`, { data: { title: `resorted ${tag}` } })).ok()).toBe(true)
  await expect.poll(() => aboveView(page, before.first), { timeout: 10_000 }).toBe(true)
  await frames(page)
  const after = await shownRows(page)
  // Its row moved up by the re-sorted row's height (that row left the place above it), and no more:
  // the list did not follow the re-sorted row up to its project's top.
  const nextAfter = after.whole.find((r) => r.id === next.id)
  expect(nextAfter, 'the list followed the row it re-sorted').toBeTruthy()
  expect(Math.abs(nextAfter!.top - next.top), 'the list followed the row it re-sorted').toBeLessThanOrEqual(40)
})
