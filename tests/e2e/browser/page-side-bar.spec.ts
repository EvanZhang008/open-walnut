/**
 * The Agenda and the Scratchpad beside any page, not only Home (2026-11-06, the user, of the rail's
 * Agenda and Scratchpad: "extract it to global, any page can show this side bar, I find I sometimes
 * need it for the org page"). web/src/components/layout/PageSideBar.tsx, page-side-bar.ts.
 *
 * Scenario matrix:
 *  1. on Org the rail's Agenda opens the day agenda on the page's left edge, the page stays on screen
 *     beside it (no trip home), the toggle reads pressed; its × closes it and gives the focus back to
 *     the toggle; the toggle closes it too; Escape inside it closes it;
 *  2. the Scratchpad opens under the agenda in the same column with the caret in it, and what is typed
 *     there is saved and is the same note Home's Scratchpad shows; the window has ONE scratchpad
 *     editor wherever it shows, so a line typed on Home whose save is still in flight and a line
 *     typed on Org right after both reach the note (two editors, two savers: one line was lost);
 *  3. each page keeps its own: the agenda open on Org is shut on Notes, Notes' scratchpad is shut on
 *     Org, and both come back as left after another page and a reload;
 *  4. the column's width is dragged on its right edge, kept per page across a reload, the other page
 *     keeps the default, and it never takes more than half the window;
 *  5. a full screen sheet on the page lies beside the side bar (it stays usable, like the rail), in a
 *     wide window and in a narrow one, where the side bar lies over the page instead of narrowing it;
 *  6. (with 5) a narrow window lays it over the page instead of narrowing the page;
 *  7. Home is as before: its own column right of the task panel, its own flags, no page side bar.
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
  await expect(agendaToggle(page)).toHaveClass(/\bactive\b/)
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

test('the Scratchpad opens under the agenda, takes the caret, and is the same note as Home\'s', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await scratchToggle(page).click()
  await expect(scratchPane(page)).toBeVisible()
  const editor = scratchPane(page).locator('.notes-editor .tiptap')
  await expect(editor).toBeFocused()
  // Agenda on top, scratchpad below, one column.
  const a = (await agendaPane(page).boundingBox())!
  const s = (await scratchPane(page).boundingBox())!
  expect(s.y).toBeGreaterThanOrEqual(a.y + a.height - 1)
  expect(Math.round(s.x)).toBe(Math.round(a.x))

  const line = `side bar line ${Date.now().toString(36)}`
  const saved = page.waitForResponse(res => new URL(res.url()).pathname === '/api/notes/global' && res.request().method() === 'PUT')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(line)
  await saved
  await expect.poll(async () => (await (await page.request.get('/api/notes/global')).json()).content).toContain(line)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-both.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })

  // Home's Scratchpad is the same note, and the same editor: one in the window.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(bar(page)).toBeHidden()
  const home = page.getByTestId('home-companion-scratchpad')
  if (!(await home.isVisible())) await scratchToggle(page).click()
  await expect(home.locator('.notes-editor .tiptap')).toContainText(line)
  await expect(page.locator('.global-notes-section')).toHaveCount(1)

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
  const handle = page.getByTestId('page-side-bar-resize')
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

test('a full screen sheet lies beside the side bar, and a narrow window overlays the page', async ({ page }) => {
  await openOrg(page)
  await agendaToggle(page).click()
  await expect(agendaPane(page)).toBeVisible()
  // What the sheets read for the page area's left edge is the side bar's right edge.
  const gap = () => page.evaluate(() => {
    const left = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fullscreen-left')) || 0
    return Math.round(left - document.querySelector('[data-testid="page-side-bar"]')!.getBoundingClientRect().right)
  })
  await expect.poll(gap).toBe(0)

  await page.setViewportSize({ width: 1000, height: 800 })
  await expect.poll(async () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="page-side-bar"]')!).position)).toBe('absolute')
  const e = await edges(page)
  expect(e.areaLeft, 'the page keeps its width under the overlay').toBe(e.barLeft)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect.poll(gap, 'the full screen area starts at the overlay\'s right edge').toBe(0)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-org-narrow.png` })

  // A real full screen sheet (the Org node's side bar) leaves the side bar usable.
  const full = page.getByTestId('org-rail-fullscreen')
  // The node on screen may have no side bar of its own: pick one that has.
  const channels = page.getByTestId('org-channel')
  for (let i = 0; i < await channels.count() && !(await full.isVisible()); i++) {
    await channels.nth(i).click()
    await full.waitFor({ timeout: 3_000 }).catch(() => {})
  }
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
