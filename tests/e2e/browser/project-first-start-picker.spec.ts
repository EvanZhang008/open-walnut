/**
 * The v6 draft's Where picker, design A (experiment project_first_start), part three: Recent and
 * Most used, a search that keeps nothing once cleared, a machine that is only browsed until "Use
 * this folder", the Finder columns (a double click uses the folder clicked, never its child), the
 * levels row that cuts a path back, and the keyboard and focus. How to run: project-first-start.spec.ts.
 */
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openDraft } from './draft-helpers'
import { fixtureFile, HEALTHY, loadFixture, resetServerHostFixture } from './host-problems-fixture-helpers'
import { APP, DEVBOX, fx, minutesAgo, setupFixture } from './project-first-start-fixture'
import { LOCAL_NAME, openHome, openWhere, pickTypedPath, setFlag, shot, watchErrors, whereField, whereMenu, withDirs } from './project-first-start-helpers'

test.skip(process.env.PW_WORKSPACE_FIXTURE !== '1', 'needs PW_WORKSPACE_FIXTURE=1 on its own PW_TEST_PORT')
test.use({ viewport: { width: 1200, height: 794 }, deviceScaleFactor: 1, colorScheme: 'light' })
test.describe.configure({ mode: 'default' })

test.beforeAll(async ({ request }) => { await setupFixture(request) })
test.afterAll(async ({ request }) => {
  await setFlag(request, false)
  await resetServerHostFixture(request)
})

const footer = (menu: Locator) => ({ dest: menu.getByTestId('draft-v6-where-dest'), use: menu.getByTestId('draft-v6-use-path') })
const rows = (menu: Locator) => menu.getByTestId('draft-v6-folder-row')

async function freshDraft(page: Page): Promise<Locator> {
  await openHome(page)
  return openDraft(page)
}

test('Recent and Most used on every machine; a cleared search keeps the saved folder', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  const ws = path.join(fx.home, 'ws-fixture')
  await withDirs(page, [
    { cwd: path.join(ws, 'recent-one'), count: 1, lastUsed: minutesAgo(5) },
    { cwd: path.join(ws, 'busy-one'), count: 50, lastUsed: minutesAgo(600) },
    { cwd: '/srv/elsewhere', host: DEVBOX.key, hostLabel: DEVBOX.label, count: 3, lastUsed: minutesAgo(60) },
  ], { only: true })
  const panel = await freshDraft(page)
  const before = await whereField(panel).getAttribute('aria-label')
  const menu = await openWhere(page, panel)
  await expect(rows(menu).first()).toHaveAttribute('data-name', 'recent-one')
  await expect(rows(menu).filter({ hasText: DEVBOX.label })).toHaveCount(1)
  // Nothing picked at open: the button keeps what the draft has.
  await expect(footer(menu).use).not.toHaveText('Use this folder')
  await menu.getByTestId('draft-v6-where-list').getByText('Most used').click()
  await expect(rows(menu).first()).toHaveAttribute('data-name', 'busy-one')
  await shot(page, 'picker-most-used')
  // A word picks its first hit for Enter; clearing it picks nothing again (review: Enter then saved
  // the last hit instead of the folder the draft had).
  const search = menu.getByTestId('draft-v6-where-search')
  await search.pressSequentially('elsewhere', { delay: 20 })
  await expect(footer(menu).dest).toContainText('/srv/elsewhere')
  await expect(footer(menu).use).toHaveText('Use this folder')
  // A search with no hit saves nothing: Enter keeps the picker open (review round 2).
  await search.fill('zqxjnomatch')
  await expect(menu.getByText('No folder matches “zqxjnomatch”')).toBeVisible({ timeout: 20_000 })
  await expect(footer(menu).use).toBeDisabled()
  await search.press('Enter')
  await expect(whereMenu(page)).toBeVisible()
  await search.fill('')
  await expect(footer(menu).dest).not.toContainText('/srv/elsewhere')
  await search.press('Enter')
  await expect(whereMenu(page)).toHaveCount(0)
  expect(await whereField(panel).getAttribute('aria-label')).toBe(before)
  expect(errors).toEqual([])
})

test('a machine on the left is only browsed: the footer names it, Cancel leaves the draft as it was', async ({ page, request }) => {
  await setFlag(request, true)
  await loadFixture(request, fixtureFile({ [DEVBOX.key]: { label: DEVBOX.label, hostname: 'dev.example.com', phase: 'connected', claude: HEALTHY } }))
  const errors = watchErrors(page)
  const panel = await freshDraft(page)
  const menu = await openWhere(page, panel)
  await menu.getByTestId(`draft-v6-side-host-${DEVBOX.key}`).click()
  await expect(menu.getByTestId('draft-v6-where-host')).toContainText(DEVBOX.label)
  await expect(footer(menu).dest).toContainText(`${DEVBOX.label}:`)
  await shot(page, 'picker-machine')
  await menu.getByTestId('draft-v6-where-cancel').click()
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(whereField(panel).getByTestId('draft-v6-host')).toContainText(LOCAL_NAME)
  await expect(whereField(panel).getByTestId('draft-v6-where-open')).toBeFocused()
  expect(errors.filter((e) => !/list-dirs/.test(e))).toEqual([])
})

test('columns: a click opens a folder, a double click uses the folder clicked, never the child that appears under the pointer', async ({ page, request }) => {
  await setFlag(request, true)
  await resetServerHostFixture(request)
  const errors = watchErrors(page)
  const panel = await freshDraft(page)
  const menu = await openWhere(page, panel)
  await menu.getByTestId('draft-v6-where-search').fill(`${path.join(fx.home, 'ws-fixture')}/`)
  const app = menu.locator('[data-testid="draft-v6-column-folder"][data-path$="/ws-fixture/app"]')
  await expect(app).toBeVisible({ timeout: 20_000 })
  await app.click()
  await expect(menu.getByTestId('draft-v6-where-columns').getByRole('group', { name: 'app' })).toBeVisible()
  await expect(footer(menu).dest).toContainText('ws-fixture/app')
  await shot(page, 'picker-columns')
  // A real double click, well after the single click: it uses app (never its child pkg, which the
  // first click's new column puts near the pointer), and nothing under the picker gets a click.
  await page.waitForTimeout(600)
  await menu.locator('[data-testid="draft-v6-column-folder"][data-path$="/ws-fixture/app"]').dblclick()
  await expect(panel.locator('.draft-v6-tile[aria-selected="true"]')).toContainText('Start task')
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(panel.getByTestId('draft-v6-folder')).toContainText('app')
  await expect(whereField(panel)).toHaveAttribute('title', APP())
  expect(errors).toEqual([])
})

test('the levels row: pointing at a level strikes out the ones after it, a click cuts the path back to it', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  const panel = await freshDraft(page)
  await pickTypedPath(page, panel, APP())
  const menu = await openWhere(page, panel)
  const levels = menu.getByTestId('draft-v6-typed-crumbs')
  await expect(levels).toContainText('Saved')
  const parent = levels.locator('[data-testid="draft-v6-level"][data-dir$="/ws-fixture"]')
  await parent.hover()
  await expect(levels.locator('[data-testid="draft-v6-level"][data-dir$="/ws-fixture/app"]')).toHaveClass(/is-cut/)
  await shot(page, 'picker-level-cut')
  await parent.click()
  await expect(footer(menu).dest).toContainText('ws-fixture')
  await expect(footer(menu).dest).not.toContainText('ws-fixture/app')
  await footer(menu).use.click()
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(whereField(panel)).toHaveAttribute('title', path.dirname(APP()))
  expect(errors).toEqual([])
})

test('the keyboard: Tab and Shift+Tab stay in the picker, arrows browse, Backspace goes up a level, Escape gives the focus back to Where', async ({ page, request }) => {
  await setFlag(request, true)
  const errors = watchErrors(page)
  const panel = await freshDraft(page)
  const menu = await openWhere(page, panel)
  const inMenu = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="draft-v6-where-menu"]'))
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); expect(await inMenu()).toBe(true) }
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await inMenu()).toBe(true) }
  const search = menu.getByTestId('draft-v6-where-search')
  await search.focus()
  await search.fill(`${path.join(fx.home, 'ws-fixture')}/`)
  await expect(menu.locator('[data-testid="draft-v6-column-folder"][data-path$="/ws-fixture/app"]')).toBeVisible({ timeout: 20_000 })
  await search.fill('')
  await search.fill(`${path.join(fx.home, 'ws-fixture')}/ap`)
  await page.keyboard.press('ArrowDown')
  await expect(footer(menu).dest).toContainText('ws-fixture/app')
  await page.keyboard.press('ArrowRight')
  await expect(menu.getByTestId('draft-v6-typed-crumbs')).toContainText('app')
  // Backspace at a level's end goes up a whole level.
  await page.keyboard.press('Backspace')
  await expect(footer(menu).dest).not.toContainText('ws-fixture/app')
  await page.keyboard.press('Escape')
  await expect(whereMenu(page)).toHaveCount(0)
  await expect(whereField(panel).getByTestId('draft-v6-where-open')).toBeFocused()
  expect(errors).toEqual([])
})
