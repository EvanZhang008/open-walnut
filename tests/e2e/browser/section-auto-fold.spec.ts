/**
 * The task panel's status folds open and fold by one rule (web/src/components/tasks/
 * section-fold-rule.ts). 2026-11-04, the user: "only thing need open constantly is watch and need
 * me ... by default we open in the first time, but follow user's state"; 2026-11-06: "the complete
 * and working snooze need to auto collapse in 60s if no action ... no action means people not
 * actively scrolling, click in the side bar":
 *
 *   - first visit: Needs you open, Working, Waiting / snoozed and Completed folded;
 *   - an opened fold folds again 15 minutes after it was opened, also across a reload, but not
 *     so any more: since 2026-11-06 it folds 60 s after the later of the opening and the last
 *     click, scroll, key or touch in the panel, and a resting pointer or an open task row does
 *     not hold it (only typing in it or a menu open from one of its rows does);
 *   - Needs you folded stays folded across a reload and any time; opened again, it stays open;
 *   - By project's per-project folds and the sections of a project jump follow the same 60 s.
 *
 * Time runs on Playwright's clock, so the waits take no wall time.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { pausePageClock, wheelSeenByPage } from './page-clock'
import { LS_STATUS_SECTIONS_KEY, endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn, statusSection, statusSectionCard, statusSectionRows, statusSectionToggle } from './status-section-helpers'

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

  test('Flat: folded by default; an opened fold folds 60 s after the last action in the panel, a resting pointer or an open row notwithstanding, across a reload', async ({ page }) => {
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

    // Opened, Waiting folds 60 s later, not a moment before.
    await setStatusSectionOpen(panel, 'waiting', true)
    await expect(await showSectionCard(panel, 'waiting', parked)).toBeVisible()
    expect(typeof (await stored(page)).waiting).toBe('number')
    await pointerAway(page)
    await page.clock.fastForward(55_000)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(7_000)
    await expect(statusSectionToggle(panel, 'waiting')).toHaveAttribute('aria-expanded', 'false')
    expect((await stored(page)).waiting).toBeUndefined()

    // The user's report: Completed opened, its row the task open, the pointer resting on it and no
    // click or scroll since. That is no action: it folds at 60 s.
    await setStatusSectionOpen(panel, 'done', true)
    const doneRow = await showSectionCard(panel, 'done', done)
    await doneRow.click()
    await expect(doneRow).toBeVisible()
    await doneRow.hover()
    await page.clock.fastForward(62_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')

    // A scroll (wheel) or a click in the panel gives it 60 s from then; a pointer that only moves
    // there does not.
    const toolbarBox = (await panel.locator('.todo-panel-toolbar').first().boundingBox())!
    const onToolbar = () => page.mouse.move(Math.round(toolbarBox.x + 20), Math.round(toolbarBox.y + toolbarBox.height / 2))
    for (const act of ['wheel', 'click'] as const) {
      await setStatusSectionOpen(panel, 'done', true)
      await page.clock.fastForward(40_000)
      await statusSection(panel, 'done').hover()
      if (act === 'wheel') await wheelSeenByPage(page, 0, 40)
      else await panel.locator('.todo-panel-toolbar').first().click({ position: { x: 4, y: 4 } })
      await page.clock.fastForward(40_000)
      await expect(statusSectionToggle(panel, 'done'), `${act} 40 s ago`).toHaveAttribute('aria-expanded', 'true')
      await onToolbar()
      await page.mouse.move(Math.round(toolbarBox.x + 60), Math.round(toolbarBox.y + toolbarBox.height / 2))
      await statusSection(panel, 'done').hover()
      await page.clock.fastForward(22_000)
      await expect(statusSectionToggle(panel, 'done'), `${act} 62 s ago`).toHaveAttribute('aria-expanded', 'false')
    }

    // A menu open from one of its rows waits (folding would take the menu's row away); once it
    // closes, the fold has its 60 s again.
    await setStatusSectionOpen(panel, 'done', true)
    const doneCard = await showSectionCard(panel, 'done', done)
    await doneCard.hover()
    await doneCard.locator('.task-kebab-btn').first().click()
    await expect(panel.locator('.task-kebab-wrapper[data-menu-open]').first()).toBeAttached()
    await page.clock.fastForward(90_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(panel.locator('.task-kebab-wrapper[data-menu-open]')).toHaveCount(0)
    await pointerAway(page)
    await page.clock.fastForward(30_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(32_000)
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')

    // The clock is the stored opening time: a reload 30 s in keeps it open and it still folds at
    // 60 s; a reload after its time opens folded.
    await setStatusSectionOpen(panel, 'working', true)
    await expect(await showSectionCard(panel, 'working', working)).toBeVisible()
    await page.clock.fastForward(30_000)
    await page.reload()
    await selectSection(page, 'All')
    await pointerAway(page)
    await expect(statusSectionToggle(panel, 'working')).toHaveAttribute('aria-expanded', 'true', { timeout: 30_000 })
    // Picking the tab again after the reload is an action in the panel: 60 s from it at the latest.
    await page.clock.fastForward(62_000)
    await expect(statusSectionToggle(panel, 'working')).toHaveAttribute('aria-expanded', 'false')
    await setStatusSectionOpen(panel, 'working', true)
    await page.clock.fastForward(2 * MIN)
    await page.reload()
    await selectSection(page, 'All')
    await expect(statusSectionToggle(panel, 'working')).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 })
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
    // The pointer resting on a row below it: that is no action either, and the row keeps its place.
    await pointerAway(page)
    await page.clock.fastForward(62_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(Math.round((await toggle.boundingBox())!.y - before)).toBe(0)
  })

  test('a group scrolled above the panel folds under a resting pointer', async ({ page }) => {
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
    await page.clock.fastForward(20_000)
    await setStatusSectionOpen(panel, 'done', true)
    await showSectionCard(panel, 'done', done[0])
    // All of Waiting scrolled up past the panel's top edge, Completed's heading right below it.
    const toggle = statusSectionToggle(panel, 'waiting')
    await scrollTopTo(statusSectionToggle(panel, 'done'), 4)
    expect(await headingInView(panel.locator('section.status-section-block-waiting'))).toBe(false)
    const id = await firstCardInView(statusSectionRows(panel, 'done'))
    expect(id, 'a Completed card in view below Waiting').toBeTruthy()
    const row = statusSectionRows(panel, 'done').locator(`[data-task-id="${id}"]`)
    const box = (await row.boundingBox())!
    await page.mouse.move(Math.round(box.x + 40), Math.round(box.y + box.height / 2))
    // 60 s after the last click (Completed's toggle): both fold together with the pointer resting
    // on a row.
    await page.clock.fastForward(40_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(22_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(statusSectionToggle(panel, 'done')).toHaveAttribute('aria-expanded', 'false')
  })

  test('a project jump opens every section, and they fold by the same 60 s', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    await page.clock.install()
    const stamp = Date.now()
    const project = `Jumpland${stamp}`
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const needs = await seed(page, project, `jump needs ${stamp}`, { phase: 'NEED_ACTION' })
    const parked = await seed(page, project, `jump parked ${stamp}`, { phase: 'WAITING' })
    const done = await seed(page, project, `jump done ${stamp}`, { phase: 'COMPLETE' })
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    const needsRow = panel.locator(`[data-testid="status-section-needs-rows"] [data-task-id="${needs}"]`)
    await expect(needsRow).toBeVisible({ timeout: 30_000 })
    const savedFolds = () => page.evaluate((k) => localStorage.getItem(k), LS_STATUS_SECTIONS_KEY)
    const savedBefore = await savedFolds()
    await needsRow.getByTestId('row-project-link').click()
    for (const key of ['waiting', 'done'] as const) await expect(statusSectionToggle(panel, key)).toHaveAttribute('aria-expanded', 'true')
    await expect(statusSectionCard(panel, 'waiting', parked)).toBeVisible()
    await expect(statusSectionCard(panel, 'done', done)).toBeVisible()
    await pointerAway(page)
    await page.clock.fastForward(62_000)
    for (const key of ['waiting', 'done'] as const) await expect(statusSectionToggle(panel, key)).toHaveAttribute('aria-expanded', 'false')
    // Needs you keeps the user's choice inside the jump too, and the saved folds were never written.
    await expect(statusSectionToggle(panel, 'needs')).toHaveAttribute('aria-expanded', 'true')
    expect(await savedFolds()).toBe(savedBefore)
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
    await page.clock.fastForward(1_000)
    await setStatusSectionOpen(panel, 'done', true)
    const lastClickAt = await page.evaluate(() => Date.now())
    await pointerAway(page)
    // Completed's click is the panel's last action, so Waiting's 60 s run from it too: just past
    // them, on a paused clock, one timer folds both.
    await pausePageClock(page, { notBefore: lastClickAt + MIN, leadMs: 500 })
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

  test('By project: a per-project fold folds again 60 s after the last action', async ({ page }) => {
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
    await page.clock.fastForward(55_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.clock.fastForward(7_000)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(folds.locator(`[data-task-id="${parked}"]`)).toHaveCount(0)
  })
})
