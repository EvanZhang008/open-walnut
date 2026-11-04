/**
 * The task panel's status folds open and fold by one rule (web/src/components/tasks/
 * section-fold-rule.ts; 2026-11-04, the user: "this should by default auto collapse, and then if
 * user open it after 15min, auto collapse; only thing need open constantly is watch and need me
 * ... by default we open in the first time, but follow user's state"):
 *
 *   - first visit: Needs you open, Working, Waiting / snoozed and Completed folded;
 *   - an opened fold folds again 15 minutes after it was opened, also across a reload, but not
 *     while the pointer is inside it (then once it leaves);
 *   - Needs you folded stays folded across a reload and any time; opened again, it stays open;
 *   - By project's per-project folds follow the same 15 minutes.
 *
 * Time runs on Playwright's clock, so 15 minutes take no wall time.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { pausePageClock } from './page-clock'
import { LS_STATUS_SECTIONS_KEY, endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn, statusSection, statusSectionRows, statusSectionToggle } from './status-section-helpers'

const MIN = 60_000
const made: string[] = []
const turns: string[] = []
test.afterEach(async ({ request }) => {
  for (const sid of turns.splice(0)) await endRunningTurn(request, sid)
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

async function seed(page: Page, project: string, title: string, patch: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  if (Object.keys(patch).length) expect((await page.request.patch(`/api/tasks/${id}`, { data: patch })).ok()).toBe(true)
  return id
}

/** The pointer well away from the panel (on the app's navigation rail), so no fold is under it. */
const pointerAway = (page: Page) => page.mouse.move(5, (page.viewportSize()?.height ?? 800) - 5)
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as Record<string, unknown>, LS_STATUS_SECTIONS_KEY)
/** The panel's scroller around a row: its nearest ancestor that scrolls (window.__foldScroller). */
const defineScrollerOf = (page: Page) => page.addInitScript(() => {
  (window as unknown as { __foldScroller: (el: Element) => HTMLElement }).__foldScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p
    }
    return document.scrollingElement as HTMLElement
  }
})
type FoldWin = Window & { __foldScroller: (el: Element) => HTMLElement }
/** Is some of it (more than its 8 px edge) inside the visible part of the panel's scroller? */
const headingInView = (el: Locator) => el.evaluate((node) => {
  const s = (window as FoldWin).__foldScroller(node).getBoundingClientRect(), r = node.getBoundingClientRect()
  return Math.min(r.bottom, innerHeight, s.bottom) - Math.max(r.top, 0, s.top) >= Math.min(8, r.height)
})
/** Scroll the panel so `el`'s top shows `dy` px below the scroller's top edge (negative: above it). */
const scrollTopTo = (el: Locator, dy: number) => el.evaluate((node, d) => {
  const scroller = (window as FoldWin).__foldScroller(node)
  scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top - d
}, dy)
/** The first card of a section that shows inside the panel's scroller. */
const firstCardInView = (rows: Locator) => rows.evaluate((list) => {
  const s = (window as FoldWin).__foldScroller(list).getBoundingClientRect()
  const card = [...list.querySelectorAll('[data-task-id]')].find((c) => { const r = c.getBoundingClientRect(); return r.top >= s.top && r.bottom <= Math.min(innerHeight, s.bottom) })
  return card?.getAttribute('data-task-id') ?? null
})

test.describe('status folds: one rule', () => {
  test.describe.configure({ timeout: 150_000 })

  test('Flat: folded by default, an opened fold folds again after 15 minutes, never under the pointer, across a reload', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Foldland${stamp}`
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const needs = await seed(page, project, `fold needs ${stamp}`, { phase: 'NEED_ACTION' })
    const working = await seed(page, project, `fold working ${stamp}`, { phase: 'IN_PROGRESS' })
    turns.push(await startRunningTurn(page.request, working))
    const parked = await seed(page, project, `fold parked ${stamp}`, { phase: 'WAITING' })
    const done = await seed(page, project, `fold done ${stamp}`, { phase: 'COMPLETE' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()

    // First visit: Needs you open with its row; the others folded, no rows drawn.
    await expect(panel.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${needs}"]`)).toBeVisible({ timeout: 30_000 })
    for (const key of ['working', 'waiting', 'done'] as const) {
      await expect(statusSectionToggle(panel, key)).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
      await expect(panel.getByTestId(`status-section-${key}-rows`)).toHaveCount(0)
    }

    // Opened, Waiting folds again 15 minutes later, not a minute before.
    await setStatusSectionOpen(panel, 'waiting', true)
    await expect(await showSectionCard(panel, 'waiting', parked)).toBeVisible()
    expect(typeof (await stored(page)).waiting).toBe('number')
    await pointerAway(page)
    await page.clock.fastForward(14 * MIN)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(1 * MIN + 1000)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'false')
    expect((await stored(page)).waiting).toBeUndefined()

    // Due while the pointer is inside: it stays open, then folds once the pointer leaves.
    await setStatusSectionOpen(panel, 'done', true)
    await expect(await showSectionCard(panel, 'done', done)).toBeVisible()
    await statusSection(panel, 'done').hover()
    await page.clock.fastForward(16 * MIN)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    // Left the fold but still moving in the panel (its toolbar): it reads on for half a minute,
    // then folds.
    const toolbarBox = (await panel.locator('.todo-panel-toolbar').first().boundingBox())!
    const onToolbar = () => page.mouse.move(Math.round(toolbarBox.x + 20), Math.round(toolbarBox.y + toolbarBox.height / 2))
    await onToolbar()
    await page.clock.fastForward(15_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    // A mousemove where the pointer already is (WebKit sends one whenever the layout under a
    // resting pointer changes) is not the user moving: it does not restart the half minute. Past
    // it, a user who stays still with the group on screen may be reading it: it waits until they
    // act outside the panel.
    await onToolbar()
    await page.clock.fastForward(17_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    await pointerAway(page)
    await page.clock.fastForward(2_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')
    // Left the panel altogether: it folds within a second or two.
    await setStatusSectionOpen(panel, 'done', true)
    await statusSection(panel, 'done').hover()
    await page.clock.fastForward(16 * MIN)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    // On a paused clock no timer runs, so this folds only if leaving itself folds it.
    const pauseHere = async () => pausePageClock(page, { leadMs: 500 })
    await pauseHere()
    await pointerAway(page)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')
    await page.clock.resume()
    // A keyboard user's focus on one of its rows (Tab from the heading) holds it, however long
    // they rest; it folds once the focus moves on.
    await setStatusSectionOpen(panel, 'done', true)
    const doneBlock = panel.locator('section.status-section-block-done')
    const onRow = () => doneBlock.evaluate((el) => el.contains(document.activeElement) && !document.activeElement?.hasAttribute('aria-expanded'))
    await statusSectionToggle(panel, 'done').focus()
    for (let i = 0; i < 4 && !(await onRow()); i++) await page.keyboard.press('Tab')
    expect(await onRow()).toBe(true)
    await pointerAway(page)
    await page.clock.fastForward(16 * MIN)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    await pauseHere()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')
    await page.clock.resume()

    // The clock is the stored opening time: a reload 5 minutes in keeps it open and it still
    // folds at 15; a reload after its 15 minutes opens folded.
    await setStatusSectionOpen(panel, 'working', true)
    await expect(await showSectionCard(panel, 'working', working)).toBeVisible()
    await page.clock.fastForward(5 * MIN)
    await page.reload()
    await selectSection(page, 'All')
    await pointerAway(page)
    await expect(statusSectionToggle(panel, 'working')).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 })
    await page.clock.fastForward(10 * MIN + 1000)
    await expect(statusSectionToggle(panel, 'working')).toHaveAttribute('aria-expanded', 'false')
    await setStatusSectionOpen(panel, 'working', true)
    await page.clock.fastForward(20 * MIN)
    await page.reload()
    await selectSection(page, 'All')
    await expect(statusSectionToggle(panel, 'working')).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
  })

  test('a fold on screen above a resting pointer waits for the pointer to go', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Restland${stamp}`
    await defineScrollerOf(page)
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    for (let i = 0; i < 3; i++) await seed(page, project, `rest parked ${i} ${stamp}`, { phase: 'WAITING' })
    const done = await seed(page, project, `rest done ${stamp}`, { phase: 'COMPLETE' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    await page.clock.fastForward(10 * MIN)
    await setStatusSectionOpen(panel, 'done', true)
    const row = await showSectionCard(panel, 'done', done)
    await row.scrollIntoViewIfNeeded()
    const box = (await row.boundingBox())!
    await page.mouse.move(Math.round(box.x + 40), Math.round(box.y + box.height / 2))
    const before = (await row.boundingBox())!.y
    const waitingOnScreen = await headingInView(panel.locator('section.status-section-block-waiting'))
    // Due 5 minutes on. On screen above the resting pointer, Waiting waits however long: folding
    // it would slide another task under the pointer. Scrolled above the panel, it folds and the
    // row under the pointer stays where it is. Either way that row does not move.
    await page.clock.fastForward(8 * MIN)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', waitingOnScreen ? 'true' : 'false')
    expect(Math.round((await row.boundingBox())!.y - before)).toBe(0)
    // The pointer leaves the panel: it folds.
    await pointerAway(page)
    await page.clock.fastForward(2_000)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'false')
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
  })

  test('a group scrolled above the panel folds under a resting pointer, and the row under it stays', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 })
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Aboveland${stamp}`
    await defineScrollerOf(page)
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    for (let i = 0; i < 3; i++) await seed(page, project, `above parked ${i} ${stamp}`, { phase: 'WAITING' })
    const done: string[] = []
    for (let i = 0; i < 12; i++) done.push(await seed(page, project, `above done ${i} ${stamp}`, { phase: 'COMPLETE' }))
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    await page.clock.fastForward(10 * MIN)
    await setStatusSectionOpen(panel, 'done', true)
    await showSectionCard(panel, 'done', done[0])
    // All of Waiting scrolled up past the panel's top edge (also out from under its toolbar),
    // Completed's heading right below that edge.
    const toggle = statusSectionToggle(panel, 'waiting')
    await scrollTopTo(statusSectionToggle(panel, 'done'), 4)
    expect(await headingInView(panel.locator('section.status-section-block-waiting'))).toBe(false)
    const id = await firstCardInView(statusSectionRows(panel, 'done'))
    expect(id, 'a Completed card in view below Waiting').toBeTruthy()
    const row = statusSectionRows(panel, 'done').locator(`[data-task-id="${id}"]`)
    const box = (await row.boundingBox())!
    await page.mouse.move(Math.round(box.x + 40), Math.round(box.y + box.height / 2))
    // Due 5 minutes on: it folds with the pointer still resting below, and the row stays put.
    await page.clock.fastForward(5 * MIN + 2_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(Math.round((await row.boundingBox())!.y - box.y)).toBe(0)
  })

  test('a group folding on screen near the end of the list keeps its heading where it shows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 })
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Endland${stamp}`
    await defineScrollerOf(page)
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    for (let i = 0; i < 10; i++) await seed(page, project, `end needs ${i} ${stamp}`, { phase: 'NEED_ACTION' })
    for (let i = 0; i < 2; i++) {
      const id = await seed(page, project, `end working ${i} ${stamp}`, { phase: 'IN_PROGRESS' })
      turns.push(await startRunningTurn(page.request, id))
    }
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    // Working is the last open group (Waiting and Completed are folded by default): scrolled to
    // the very end with its heading on screen, folding it leaves too little list to stay there.
    await setStatusSectionOpen(panel, 'waiting', false)
    await setStatusSectionOpen(panel, 'done', false)
    await setStatusSectionOpen(panel, 'working', true)
    const toggle = statusSectionToggle(panel, 'working')
    await toggle.evaluate((el) => { const s = (window as FoldWin).__foldScroller(el); s.scrollTop = s.scrollHeight })
    expect(await headingInView(toggle)).toBe(true)
    const before = (await toggle.boundingBox())!.y
    await pointerAway(page)
    // 15 minutes on, the user long still: it folds, and its heading does not move.
    await page.clock.fastForward(15 * MIN + 2_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(Math.round((await toggle.boundingBox())!.y - before)).toBe(0)
  })

  test('a group on screen waits while the user is still, and folds once they are away', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await seed(page, `Stillland${stamp}`, `still parked ${stamp}`, { phase: 'WAITING' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    await page.clock.fastForward(14 * MIN)
    // A move outside the panel, then nothing: at 15 minutes they may be reading it.
    await pointerAway(page)
    await page.clock.fastForward(MIN + 1_000)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(3 * MIN)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'true')
    // Five minutes with no input anywhere: they are away, and it folds.
    await page.clock.fastForward(MIN + 2_000)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'false')
  })

  test('groups opened a moment apart fold together', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Pairland${stamp}`
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await seed(page, project, `pair parked ${stamp}`, { phase: 'WAITING' })
    await seed(page, project, `pair done ${stamp}`, { phase: 'COMPLETE' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await setStatusSectionOpen(panel, 'waiting', true)
    const openedAt = await page.evaluate(() => Date.now())
    await page.clock.fastForward(1_000)
    await setStatusSectionOpen(panel, 'done', true)
    await pointerAway(page)
    // Half a second past Waiting's 15 minutes, Completed's are half a second off: on a paused
    // clock only Waiting's own timer can run, and it takes Completed with it.
    await pausePageClock(page, { notBefore: openedAt + 15 * MIN, leadMs: 500 })
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'false')
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')
    await page.clock.resume()
  })

  test('Needs you keeps the user choice across a reload and any time, with no clock', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const needs = await seed(page, `Stickyland${stamp}`, `sticky needs ${stamp}`, { phase: 'NEED_ACTION' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    const row = panel.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${needs}"]`)
    await expect(row).toBeVisible({ timeout: 30_000 })

    await setStatusSectionOpen(panel, 'needs', false)
    expect((await stored(page)).needs).toBe(false)
    await page.clock.fastForward(60 * MIN)
    await page.reload()
    await selectSection(page, 'All')
    await expect(statusSectionToggle(panel, 'needs')).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    await expect(row).toHaveCount(0)

    await setStatusSectionOpen(panel, 'needs', true)
    await pointerAway(page)
    await page.clock.fastForward(60 * MIN)
    await expect(statusSectionToggle(panel, 'needs')).toHaveAttribute('aria-expanded', 'true')
    await page.reload()
    await selectSection(page, 'All')
    await expect(row).toBeVisible({ timeout: 30_000 })
    expect((await stored(page)).needs).toBeUndefined()
  })

  test('By project: a per-project fold folds again after 15 minutes', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'project')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Projfold${stamp}`
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await seed(page, project, `pf open ${stamp}`, {})
    const parked = await seed(page, project, `pf parked ${stamp}`, { phase: 'WAITING' })
    await page.reload()
    await selectSection(page, 'All')
    const folds = page.locator(`[data-testid="project-status-folds"][data-project="${project}"]`).first()
    const toggle = folds.getByTestId('project-status-fold-waiting')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(folds.locator(`[data-task-id="${parked}"]`)).toBeVisible()
    await pointerAway(page)
    await page.clock.fastForward(14 * MIN)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(1 * MIN + 1000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(folds.locator(`[data-task-id="${parked}"]`)).toHaveCount(0)
  })
})
