/**
 * The Agenda and the Scratchpad beside any page, not only Home (2026-11-06, the user, of the rail's
 * Agenda and Scratchpad: "extract it to global, any page can show this side bar, I find I sometimes
 * need it for the org page"). web/src/components/layout/PageSideBar.tsx, page-side-bar.ts.
 *
 * Scenario matrix:
 *  1. on Org the rail's Agenda opens the day agenda on the page's left edge, the page stays on screen
 *     beside it (no trip home), the toggle reads pressed; its × closes it and gives the focus back to
 *     the toggle; the toggle closes it too; Escape inside it closes it;
 *  2. the Scratchpad opens as its own side bar right of the agenda (never under it: 2026-11-16, the
 *     user: "side bar should be independent, new one on the right, instead of top and bottom"), full
 *     height, with the caret in it, and what is typed
 *     there is saved and is the same note Home's Scratchpad shows; the window has ONE scratchpad
 *     editor wherever it shows, so a line typed on Home whose save is still in flight and a line
 *     typed on Org right after both reach the note (two editors, two savers: one line was lost);
 *  2b. no editor takes typing before the note is read (an empty editor saved over the note), and the
 *     one editor survives a switch to the phone layout with a save under way and newer words pending;
 *  3. each page keeps its own: the agenda open on Org is shut on Notes, Notes' scratchpad is shut on
 *     Org, and both come back as left after another page and a reload;
 *  4. a side bar's width is dragged on its right edge, kept per page across a reload, the other page
 *     keeps the default, and it never takes more than half the window;
 *  4b. with both open each side bar has its own width, handle and scrolling: a drag of one leaves the
 *     other's width, a scroll of one leaves the other's place, both are kept across a reload, and
 *     closing the agenda leaves the scratchpad as wide as it was; Home's two side bars likewise;
 *  5. a full screen sheet on the page lies beside the side bar (it stays usable, like the rail), in a
 *     wide window and in a narrow one, where the side bar lies over the page instead of narrowing it;
 *  6. (with 5) a narrow window lays it over the page instead of narrowing the page;
 *  7. Home is as before: its own side bars right of the task panel, its own flags, no page side bar.
 */
import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/page-side-bar`
const bar = (page: Page) => page.getByTestId('page-side-bar')
const agendaPane = (page: Page) => page.getByTestId('page-side-bar-calendar')
const scratchPane = (page: Page) => page.getByTestId('page-side-bar-scratchpad')
const agendaToggle = (page: Page) => page.getByTestId('sidebar-toggle-calendar')
const scratchToggle = (page: Page) => page.getByTestId('sidebar-toggle-scratchpad')
const area = (page: Page) => page.locator('.main-content-row > .app-content-area')

/**
 * The scratchpad fills its pane and a note taller than the pane scrolls inside it (the moved
 * editor box once sat between them as a plain block, so the note grew past the pane, clipped,
 * with no scrollbar). A tall spacer beside the editor stands for a long note, so the shared
 * fixture note is not rewritten.
 */
async function expectScratchpadScrolls(page: Page, paneTestId: string) {
  const r = await page.evaluate((id) => {
    const pane = document.querySelector(`[data-testid="${id}"]`)!
    const section = pane.querySelector('.global-notes-section')!
    const body = pane.querySelector<HTMLElement>('.global-notes-body')!
    const spacer = document.createElement('div')
    spacer.style.cssText = 'flex: 0 0 4000px; height: 4000px; min-height: 4000px'
    body.appendChild(spacer)
    const out = {
      pane: Math.round(pane.getBoundingClientRect().height), section: Math.round(section.getBoundingClientRect().height),
      client: body.clientHeight, scroll: body.scrollHeight,
    }
    spacer.remove()
    return out
  }, paneTestId)
  expect(Math.abs(r.section - r.pane), `the scratchpad fills its pane (${JSON.stringify(r)})`).toBeLessThanOrEqual(2)
  expect(r.client, 'its body is bounded by the pane').toBeLessThan(r.pane)
  expect(r.scroll, 'and scrolls a long note').toBeGreaterThan(r.client)
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })
test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1440, height: 900 })
})

async function openOrg(page: Page) {
  await page.goto('/org')
  await expect(page.locator('.org-page')).toBeVisible({ timeout: 30_000 })
}

async function goNotes(page: Page) {
  await page.getByTestId('sidebar-core-app-notes').click()
  await expect(page).toHaveURL(/\/notes/)
}

async function goOrg(page: Page) {
  await page.getByTestId('sidebar-org').click()
  await expect(page).toHaveURL(/\/org/)
  await expect(page.locator('.org-page')).toBeVisible()
}

/**
 * The two side bars side by side, the scratchpad right of the agenda, both the row's full height
 * (the guard against their going back to one column, agenda on top).
 */
async function expectSideBySide(page: Page, testId: string) {
  const r = await page.evaluate((id) => {
    const box = (sel: string) => { const b = document.querySelector(`[data-testid="${sel}"]`)!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    return { row: box(id), a: box(`${id}-calendar`), s: box(`${id}-scratchpad`) }
  }, testId)
  const msg = JSON.stringify(r)
  expect(r.s.x, `the scratchpad starts at the agenda's right edge (${msg})`).toBeGreaterThanOrEqual(r.a.x + r.a.w - 2)
  expect(Math.abs(r.s.y - r.a.y), `side by side, not one under the other (${msg})`).toBeLessThanOrEqual(1)
  for (const pane of [r.a, r.s]) expect(Math.abs(pane.h - r.row.h), `each the row's full height (${msg})`).toBeLessThanOrEqual(2)
  expect(Math.abs(r.row.w - (r.a.w + r.s.w)), `the row is the two side bars (${msg})`).toBeLessThanOrEqual(3)
}

/** The widths of the two side bars of `testId` (`page-side-bar` or `home-companion`). */
async function paneWidths(page: Page, testId: string) {
  return page.evaluate((id) => ({
    agenda: Math.round(document.querySelector(`[data-testid="${id}-calendar-bar"]`)!.getBoundingClientRect().width),
    scratchpad: Math.round(document.querySelector(`[data-testid="${id}-scratchpad-bar"]`)!.getBoundingClientRect().width),
  }), testId)
}

/** Drag a side bar's right-edge handle `dx` px with a real mouse. */
async function dragHandle(page: Page, handleTestId: string, dx: number) {
  const pane = (await page.getByTestId(handleTestId).locator('..').boundingBox())!
  const x = pane.x + pane.width
  const y = pane.y + pane.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
}

/**
 * A scroll in one side bar leaves the other where it was: the scratchpad's note body and the
 * agenda's own scroller each move alone.
 */
async function expectScrollsApart(page: Page, testId: string) {
  const r = await page.evaluate((id) => {
    const note = document.querySelector<HTMLElement>(`[data-testid="${id}-scratchpad"] .global-notes-body`)!
    const spacer = document.createElement('div')
    spacer.style.cssText = 'flex: 0 0 4000px; height: 4000px; min-height: 4000px'
    note.appendChild(spacer)
    const agenda = [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}-calendar"] *`)]
      .find((el) => el.scrollHeight > el.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(el).overflowY))!
    const agendaBefore = agenda.scrollTop
    note.scrollTop = 600
    const afterNote = { note: note.scrollTop, agenda: agenda.scrollTop }
    agenda.scrollTop = agendaBefore + 120
    const afterAgenda = { note: note.scrollTop, agenda: agenda.scrollTop }
    note.scrollTop = 0
    agenda.scrollTop = agendaBefore
    spacer.remove()
    return { agendaBefore, afterNote, afterAgenda }
  }, testId)
  const msg = JSON.stringify(r)
  expect(r.afterNote.note, msg).toBeGreaterThan(0)
  expect(r.afterNote.agenda, `the note's scroll leaves the agenda (${msg})`).toBe(r.agendaBefore)
  expect(r.afterAgenda.agenda, msg).not.toBe(r.agendaBefore)
  expect(r.afterAgenda.note, `the agenda's scroll leaves the note (${msg})`).toBe(r.afterNote.note)
}

/**
 * In a narrow window the two side bars lie over the page and share what is left of the window
 * (each at 280px they once ran past its right edge); the wide window gets its widths back.
 */
async function expectNarrowFits(page: Page, testId: string) {
  const before = await paneWidths(page, testId)
  for (const width of [1000, 800]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(async () => page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
      return Math.round(row.right) <= window.innerWidth
    }, testId), `the side bars stay inside a ${width}px window`).toBe(true)
    const w = await paneWidths(page, testId)
    expect(Math.min(w.agenda, w.scratchpad), `both stay readable at ${width}px`).toBeGreaterThan(150)
    await expectSideBySide(page, testId)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(() => paneWidths(page, testId)).toEqual(before)
}

/** The bar's right edge and the page area's left edge, read in one frame. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const aside = document.querySelector('[data-testid="page-side-bar"]')!.getBoundingClientRect()
    const content = document.querySelector('.main-content-row > .app-content-area')!.getBoundingClientRect()
    return { barLeft: Math.round(aside.left), barRight: Math.round(aside.right), barWidth: Math.round(aside.width), areaLeft: Math.round(content.left) }
  })
}

test('the Agenda opens beside the Org page and closes three ways', async ({ page }) => {
  await openOrg(page)
  const before = (await area(page).boundingBox())!
  await agendaToggle(page).click()
  await expect(page).toHaveURL(/\/org$/)
  await expect(agendaPane(page)).toBeVisible()
  await expect(agendaPane(page).getByTestId('cal-side-panel')).toBeVisible()
  await expect(agendaToggle(page)).toHaveAttribute('aria-pressed', 'true')
  // The page moves over by the column's width and stays on screen beside it.
  await expect.poll(async () => { const e = await edges(page); return e.areaLeft - e.barRight }).toBeLessThanOrEqual(1)
  const e = await edges(page)
  expect(e.barLeft).toBe(Math.round(before.x))
  expect(e.barWidth).toBe(400)
  await expect(page.locator('.org-page')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-agenda.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })

  // ×: shut, and the focus goes back to the toggle.
  await agendaPane(page).locator('[title="Close calendar panel"]').click()
  await expect(agendaPane(page)).toBeHidden()
  await expect(agendaToggle(page)).toBeFocused()
  await expect(agendaToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => Math.round((await area(page).boundingBox())!.x)).toBe(Math.round(before.x))

  // The toggle opens and shuts it.
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeVisible()
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeHidden()

  // Escape inside the agenda shuts it.
  await agendaToggle(page).click()
  await expect(agendaPane(page).locator('[title="Close calendar panel"]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(agendaPane(page)).toBeHidden()
})

test('the Scratchpad opens right of the agenda, takes the caret, and is the same note as Home\'s', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await scratchToggle(page).click()
  await expect(scratchPane(page)).toBeVisible()
  const editor = scratchPane(page).locator('.notes-editor .tiptap')
  await expect(editor).toBeFocused()
  await expectScratchpadScrolls(page, 'page-side-bar-scratchpad')
  await expectSideBySide(page, 'page-side-bar')

  const line = `side bar line ${Date.now().toString(36)}`
  const saved = page.waitForResponse(res => new URL(res.url()).pathname === '/api/notes/global' && res.request().method() === 'PUT')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(line)
  await saved
  await expect.poll(async () => (await (await page.request.get('/api/notes/global')).json()).content).toContain(line)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-both.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })

  // Back from another app the note is read again; the next edit, even one keystroke, is saved
  // (a flag waiting for the reload's own update swallowed it, and the next reload wrote over it).
  await page.waitForTimeout(2100)
  const reread = page.waitForResponse(res => new URL(res.url()).pathname === '/api/notes/global' && res.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await reread
  const afterFocus = page.waitForResponse(res => new URL(res.url()).pathname === '/api/notes/global' && res.request().method() === 'PUT', { timeout: 10_000 })
  // The caret at the end of that line (it went in where the caret opened, not always last).
  await editor.locator('p', { hasText: line }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await afterFocus
  await expect.poll(async () => (await (await page.request.get('/api/notes/global')).json()).content).toContain(`${line}!`)

  // Home's Scratchpad is the same note, and the same editor: one in the window.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(bar(page)).toBeHidden()
  const home = page.getByTestId('home-companion-scratchpad')
  if (!(await home.isVisible())) await scratchToggle(page).click()
  await expect(home.locator('.notes-editor .tiptap')).toContainText(line)
  await expect(page.locator('.global-notes-section')).toHaveCount(1)
  await expectScratchpadScrolls(page, 'home-companion-scratchpad')

  // A line typed on Home whose save is held, then a line typed on Org at once: both are kept.
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let holding = true
  await page.route('**/api/notes/global', async (route) => {
    if (route.request().method() === 'PUT' && holding) { holding = false; await held }
    await route.continue()
  })
  const statuses: number[] = []
  page.on('response', (res) => { if (new URL(res.url()).pathname === '/api/notes/global' && res.request().method() === 'PUT') statuses.push(res.status()) })
  const homeLine = `home pending ${Date.now().toString(36)}`
  const orgLine = `org right after ${Date.now().toString(36)}`
  const homeEditor = home.locator('.notes-editor .tiptap')
  // The caret at the end of the note's last line.
  await homeEditor.locator('p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(homeLine)
  await expect.poll(() => holding, 'the Home save is on its way and held').toBe(false)
  await goOrg(page)
  await expect(scratchPane(page)).toBeVisible()
  await expect(page.locator('.global-notes-section')).toHaveCount(1)
  const orgEditor = scratchPane(page).locator('.notes-editor .tiptap')
  await expect(orgEditor).toContainText(homeLine)
  await orgEditor.locator('p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(orgLine)
  release()
  await expect.poll(async () => (await (await page.request.get('/api/notes/global')).json()).content as string, { timeout: 15_000 })
    .toMatch(new RegExp(`${homeLine}\\n+${orgLine}`))
  expect(statuses.filter((s) => s === 409), 'no save raced another').toEqual([])
  await expect(orgEditor).toContainText(homeLine)
  await expect(orgEditor).toContainText(orgLine)
})

test('the scratchpad takes no typing before the note is read, and a phone-width switch loses nothing', async ({ page }) => {
  // Hold every read of the note until released: the pane says it is loading and offers no editor.
  let releaseRead!: () => void
  const readHeld = new Promise<void>((r) => { releaseRead = r })
  await page.route('**/api/notes/global', async (route) => {
    if (route.request().method() === 'GET') await readHeld
    await route.continue()
  })
  await openOrg(page)
  await scratchToggle(page).click()
  await expect(scratchPane(page).getByTestId('global-notes-loading')).toBeVisible()
  await expect(scratchPane(page).locator('.tiptap')).toHaveCount(0)
  const before = (await (await page.request.get('/api/notes/global')).json()).content as string
  releaseRead()
  const editor = scratchPane(page).locator('.notes-editor .tiptap')
  await expect(editor).toBeVisible()
  // The open asked for the caret: it lands once the editor is there.
  await expect(editor).toBeFocused()
  // It opens on the note as stored, never empty over a stored one.
  const words = before.replace(/^---[\s\S]*?---/, '').match(/[A-Za-z]{4,}/)?.[0]
  if (words) await expect(editor).toContainText(words)
  await page.unroute('**/api/notes/global')

  // A save under way, newer words waiting behind it, then the window goes phone width.
  let releaseSave!: () => void
  const saveHeld = new Promise<void>((r) => { releaseSave = r })
  let holdSave = true
  await page.route('**/api/notes/global', async (route) => {
    if (route.request().method() === 'PUT' && holdSave) { holdSave = false; await saveHeld }
    await route.continue()
  })
  const a = `phone switch a ${Date.now().toString(36)}`
  const b = `phone switch b ${Date.now().toString(36)}`
  await editor.locator('p').last().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(a)
  await expect.poll(() => holdSave, 'the first save is on its way and held').toBe(false)
  await page.keyboard.press('Enter')
  await page.keyboard.type(b)
  await page.setViewportSize({ width: 700, height: 900 })
  await expect(bar(page)).toHaveCount(0)
  // The editor waits in the document, so the save still under way is seen before a reload.
  await expect(page.locator('.scratchpad-parking .global-notes-section')).toHaveCount(1)
  releaseSave()
  await expect.poll(async () => (await (await page.request.get('/api/notes/global')).json()).content as string, { timeout: 15_000 })
    .toMatch(new RegExp(`${a}\\n+${b}`))
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(scratchPane(page)).toBeVisible()
  await expect(scratchPane(page).locator('.notes-editor .tiptap')).toContainText(b)
  await expect(page.locator('.global-notes-section')).toHaveCount(1)
})

test('each page keeps its own side bar, across pages and a reload', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeVisible()

  await goNotes(page)
  await expect(bar(page)).toBeHidden()
  await expect(agendaToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await scratchToggle(page).click()
  await expect(scratchPane(page)).toBeVisible()
  await expect(agendaPane(page)).toBeHidden()

  await goOrg(page)
  await expect(agendaPane(page)).toBeVisible()
  await expect(scratchPane(page)).toBeHidden()
  await expect(scratchToggle(page)).toHaveAttribute('aria-pressed', 'false')
  // Coming back to a page that keeps a pane open takes no focus from it.
  await expect(agendaPane(page).locator('[title="Close calendar panel"]')).not.toBeFocused()

  await page.reload()
  await expect(page.locator('.org-page')).toBeVisible({ timeout: 30_000 })
  await expect(agendaPane(page)).toBeVisible()
  await expect(scratchPane(page)).toBeHidden()
  // A reload that restores it open takes no focus from the page.
  await expect(agendaPane(page).locator('[title="Close calendar panel"]')).not.toBeFocused()
  await goNotes(page)
  await expect(scratchPane(page)).toBeVisible()
  await expect(agendaPane(page)).toBeHidden()
  await scratchToggle(page).click()
  await expect(bar(page)).toBeHidden()
  await goOrg(page)
  await agendaToggle(page).click()
  await expect(bar(page)).toBeHidden()
})

test('the width is dragged on its edge and kept per page', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeVisible()
  const handle = page.getByTestId('page-side-bar-calendar-resize')
  const box = (await bar(page).boundingBox())!
  const x = box.x + box.width
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 60, y, { steps: 4 })
  await page.mouse.move(x + 120, y, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => (await edges(page)).barWidth).toBe(520)
  expect(await handle.count()).toBe(1)
  await expect.poll(async () => { const e = await edges(page); return e.areaLeft - e.barRight }).toBeLessThanOrEqual(1)

  // Never past half the window, whatever the drag.
  const wide = (await bar(page).boundingBox())!
  await page.mouse.move(wide.x + wide.width, y)
  await page.mouse.down()
  await page.mouse.move(wide.x + wide.width + 900, y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await edges(page)).barWidth).toBe(720)
  await page.setViewportSize({ width: 1200, height: 900 })
  await expect.poll(async () => (await edges(page)).barWidth).toBe(600)
  await page.setViewportSize({ width: 1440, height: 900 })
  // The edge is grabbed where it is once the wide window let it out again (read at once, it was
  // still at 600 and the drag missed the handle).
  await expect.poll(async () => (await edges(page)).barWidth).toBe(720)
  // Back to 520 for the rest.
  const now = (await bar(page).boundingBox())!
  await page.mouse.move(now.x + now.width, y)
  await page.mouse.down()
  await page.mouse.move(now.x + 520, y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await edges(page)).barWidth).toBe(520)

  await page.reload()
  await expect(agendaPane(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await edges(page)).barWidth).toBe(520)
  // The keyboard widens and narrows it too, and that is kept like a drag.
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await edges(page)).barWidth).toBe(536)
  await expect(handle).toHaveAttribute('aria-valuenow', '536')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await edges(page)).barWidth).toBe(520)
  await goNotes(page)
  await agendaToggle(page).click()
  await expect.poll(async () => (await edges(page)).barWidth).toBe(400)
  await agendaToggle(page).click()
  await goOrg(page)
  await agendaToggle(page).click()
  await expect(bar(page)).toBeHidden()
})

test('the two side bars each keep their own width, handle and scrolling', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await scratchToggle(page).click()
  await expect(scratchPane(page)).toBeVisible()
  await expectSideBySide(page, 'page-side-bar')
  await expectScrollsApart(page, 'page-side-bar')
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 400, scratchpad: 400 })
  // The scratchpad's own edge narrows it alone; the page moves over with it.
  await dragHandle(page, 'page-side-bar-scratchpad-resize', -60)
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 400, scratchpad: 340 })
  // The agenda's edge widens it alone; the scratchpad keeps its width beside it.
  await dragHandle(page, 'page-side-bar-calendar-resize', 20)
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 420, scratchpad: 340 })
  await expectSideBySide(page, 'page-side-bar')
  await expect.poll(async () => { const e = await edges(page); return e.areaLeft - e.barRight }).toBeLessThanOrEqual(1)
  // Two side by side never take more than 30% of the window each.
  await dragHandle(page, 'page-side-bar-scratchpad-resize', 400)
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 420, scratchpad: 432 })
  await dragHandle(page, 'page-side-bar-scratchpad-resize', -92)
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 420, scratchpad: 340 })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-two-bars.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })

  await page.reload()
  await expect(scratchPane(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 420, scratchpad: 340 })
  await expectSideBySide(page, 'page-side-bar')
  await expectNarrowFits(page, 'page-side-bar')
  // Closing the agenda leaves the scratchpad as it was, now first on the edge.
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeHidden()
  await expect.poll(async () => (await edges(page)).barWidth).toBe(340)
  await agendaToggle(page).click()
  await expect.poll(() => paneWidths(page, 'page-side-bar')).toEqual({ agenda: 420, scratchpad: 340 })
  await agendaToggle(page).click()
  await scratchToggle(page).click()
  await expect(bar(page)).toBeHidden()

  // Home's two side bars are the same: side by side right of the task panel, each its own width.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(/\/$/)
  await agendaToggle(page).click()
  await scratchToggle(page).click()
  await expect(page.getByTestId('home-companion-scratchpad')).toBeVisible()
  await expectSideBySide(page, 'home-companion')
  await expectScrollsApart(page, 'home-companion')
  await dragHandle(page, 'home-companion-scratchpad-resize', -48)
  await expect.poll(() => paneWidths(page, 'home-companion')).toEqual({ agenda: 400, scratchpad: 352 })
  await page.reload()
  await expect(page.getByTestId('home-companion-scratchpad')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => paneWidths(page, 'home-companion')).toEqual({ agenda: 400, scratchpad: 352 })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-home-two-bars.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })
  await expectNarrowFits(page, 'home-companion')
  await agendaToggle(page).click()
  await scratchToggle(page).click()
})

test('a full screen sheet lies beside the side bar, and a narrow window keeps it a column', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeVisible()
  // What the sheets read for the page area's left edge is the side bar's right edge.
  const gap = () => page.evaluate(() => {
    const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fullscreen-left')) || 0
    return Math.round(left - document.querySelector('[data-testid="page-side-bar"]')!.getBoundingClientRect().right)
  })
  await expect.poll(gap).toBe(0)

  // The node on screen may have no side bar of its own: pick one that has, while the window is
  // wide (CI, 2026-11-09: the narrow window's old overlay lay over the channel list and took
  // every click on it, until the test timed out).
  const full = page.getByTestId('org-rail-fullscreen')
  // No wait for the node to settle: the page picks its default node once the tasks are in and
  // keeps it (settleDefaultNode), so the sheet opened here stays open (it once jumped from Main to
  // the first VP a moment after load and the sheet went with it).
  const channels = page.getByTestId('org-channel')
  for (let i = 0; i < await channels.count() && !(await full.isVisible()); i++) {
    await channels.nth(i).click()
    await full.waitFor({ timeout: 3_000 }).catch(() => {})
  }
  await expect(full).toBeVisible()

  // A narrow window keeps the side bar a column beside the page, never over it (2026-11-22: over
  // the Notes page at 1024 it hid the tree and its search box); the page keeps half the row.
  await page.setViewportSize({ width: 1000, height: 800 })
  await expect.poll(async () => { const e = await edges(page); return e.areaLeft - e.barRight }).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="page-side-bar"]')!).position)).toBe('static')
  const e = await edges(page)
  const area = (await page.locator('.main-content-row > .app-content-area').boundingBox())!
  expect(area.width, `the page keeps room beside the side bar (${JSON.stringify(e)})`).toBeGreaterThanOrEqual(Math.min(420, (1000 - e.barLeft) / 2) - 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect.poll(gap, 'the full screen area starts at the side bar\'s right edge').toBe(0)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-narrow.png` })

  // A real full screen sheet (the Org node's side bar) leaves the side bar usable.
  await expect(full).toBeVisible()
  await full.click()
  await expect(page.locator('.open-walnut-fullscreen')).toBeVisible()
  const hit = await page.evaluate(() => {
    const side = document.querySelector('[data-testid="page-side-bar"]')!.getBoundingClientRect()
    const sheet = document.querySelector('.open-walnut-fullscreen')!.getBoundingClientRect()
    const at = document.elementFromPoint(side.left + side.width / 2, side.top + 200)
    return { sheetLeft: Math.round(sheet.left), barRight: Math.round(side.right), inBar: !!at?.closest('[data-testid="page-side-bar"]') }
  })
  expect(hit.sheetLeft).toBeGreaterThanOrEqual(hit.barRight)
  expect(hit.inBar, 'a press on the side bar reaches it, not the sheet or its backdrop').toBe(true)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-narrow-fullscreen.png` })
  await agendaPane(page).getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('.open-walnut-fullscreen')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 900 })
})

test('the Org page with no node named shows none while the tasks load, then one that stays', async ({ page }) => {
  // Nothing saved for the page: it opens on its default node.
  await page.addInitScript(() => localStorage.removeItem('walnut.org.place'))
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let holding = true
  await page.route(/\/api\/tasks(\?|$)/, async (route) => {
    if (holding && route.request().method() === 'GET') await held
    await route.continue()
  })
  await openOrg(page)
  // While the tasks load no node is drawn, never Main for a moment before the first VP.
  await expect(page.locator('.org-detail-pane')).toHaveAttribute('aria-busy', 'true')
  await expect(page.getByTestId('org-detail-title')).toHaveCount(0)
  holding = false
  release()
  const name = page.getByTestId('org-detail-title').first()
  await expect(name).toBeVisible({ timeout: 30_000 })
  const first = await name.textContent()
  // It stays on that node as the list settles (statuses arrive, rows re-sort).
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(500)
    expect(await name.textContent()).toBe(first)
  }
})

test('the Org page whose first task load fails shows no node, tries again, and settles once it lands', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('walnut.org.place'))
  let failing = true
  let failed = 0
  await page.route(/\/api\/tasks(\?|$)/, async (route) => {
    // A network failure, never an answer of the test's own (task-list-stub-ratchet.test.ts).
    if (failing && route.request().method() === 'GET') { failed++; return route.abort('failed') }
    await route.continue()
  })
  await openOrg(page)
  // The store tries a failed load 3 more times (2, 4, 6 s) before it gives up on it.
  await expect.poll(() => failed, { timeout: 30_000 }).toBeGreaterThanOrEqual(4)
  await page.waitForTimeout(1500)
  // The load failed: no node is drawn (it settled on Main here before, and stayed there).
  await expect(page.getByTestId('org-detail-title')).toHaveCount(0)
  failing = false
  // The page tries the load again by itself, and the node settles once it lands.
  const name = page.getByTestId('org-detail-title')
  await expect(name).toBeVisible({ timeout: 20_000 })
  const first = await name.textContent()
  await page.waitForTimeout(1500)
  expect(await name.textContent()).toBe(first)
})

test('Home keeps its own column and flags', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeVisible()
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(bar(page)).toBeHidden()
  // The Org page's open agenda says nothing about Home's.
  await expect(agendaToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await agendaToggle(page).click()
  await expect(page.getByTestId('home-companion-calendar')).toBeVisible()
  await expect(bar(page)).toBeHidden()
  await expect.poll(() => page.evaluate(() => {
    const todo = document.querySelector('.main-page-todo')!.getBoundingClientRect()
    return Math.round(document.querySelector('.home-companion')!.getBoundingClientRect().x - todo.right)
  })).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-home-calendar-visible'))).toBe('true')
  await agendaToggle(page).click()
  await expect(page.getByTestId('home-companion-calendar')).toBeHidden()
  // And Org's is as it was left.
  await goOrg(page)
  await expect(agendaPane(page)).toBeVisible()
  await agendaToggle(page).click()
  await expect(bar(page)).toBeHidden()
})
