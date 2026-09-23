/**
 * /tasks: the column chooser, and the page remembering where it was.
 *
 * Two user complaints (2026-09-23), one spec:
 *   1. "how to add more col?" — the table showed Title/Due/Session/Project and no way to
 *      see created/updated time. The header's chooser toggles optional columns
 *      (Phase, Start, Tags, Created, Updated, Completed, …); header cells, row cells
 *      and grid tracks come from ONE list so they cannot misalign.
 *   2. "task now doesn't [persist]" — the route unmounts on navigation, so the selected
 *      project, the query and the search text came back reset. All three, plus the
 *      column choice, now survive a Home round-trip AND a reload.
 *
 * Reached by real sidebar clicks (never page.goto). Fixtures: the `pw-tq-*` tasks in
 * test-server.ts, project Lantern, with fixed ages off the server's seed instant.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openHome } from './home-navigation-helpers'

const SHOTS = '/tmp/tasks-page-columns'
test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 })
test.setTimeout(150_000)

// Lantern, IN_PROGRESS, created 3d ago, updated 2h ago — visible under the default
// "open tasks" query, and every optional column has a value to assert on.
const OPEN_RECENT = 'pw-tq-open-recent'

const TABLE = '[data-testid="tasks-table"]'
const table = (page: Page) => page.locator(TABLE)
const headers = (page: Page) => page.locator(`${TABLE} .tp-thead .tp-th`)
const row = (page: Page, id: string) => page.locator(`${TABLE} .tp-row[data-task-id="${id}"]`)
const menu = (page: Page) => page.getByTestId('tasks-columns-menu')
const chip = (page: Page, text: string) => page.locator('.tasks-page .tp-toolbar .tp-chip', { hasText: text })

async function headerLabels(page: Page): Promise<string[]> {
  // Strip the sort arrow so "Created ▲" reads as "Created".
  return (await headers(page).allTextContents()).map((t) => t.replace(/[▲▼]/g, '').trim())
}

/** Header tracks and row cells must agree: Title + N columns each. */
async function expectAligned(page: Page, id: string): Promise<void> {
  const headerCells = await page.locator(`${TABLE} .tp-thead .tp-th`).count()
  const rowCells = await row(page, id).locator(':scope > *').count()
  expect(rowCells, 'row cells = header cells').toBe(headerCells)
  const tracks = await table(page).evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--tp-cols').trim().replace(/minmax\([^)]*\)/g, 'T').split(/\s+/).length)
  expect(tracks, 'grid tracks = header cells').toBe(headerCells)
}

async function gotoTasks(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-tasks').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(table(page)).toBeVisible({ timeout: 30_000 })
}

async function gotoHome(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
}

async function openColumns(page: Page): Promise<void> {
  await page.getByTestId('tasks-columns-btn').click()
  await expect(menu(page)).toBeVisible()
}

async function setColumn(page: Page, id: string, on: boolean): Promise<void> {
  const box = menu(page).locator(`[data-column="${id}"] input`)
  if (on) await box.check(); else await box.uncheck()
}

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test('column chooser adds Created / Updated / Phase, drops Session, stays aligned', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await gotoTasks(page)

  // Shipped layout: no timestamp columns, Session present.
  const before = await headerLabels(page)
  expect(before).toContain('Title')
  expect(before).toContain('Session')
  expect(before).not.toContain('Created')
  await expect(row(page, OPEN_RECENT)).toBeVisible({ timeout: 15_000 })
  await expectAligned(page, OPEN_RECENT)
  await page.screenshot({ path: `${SHOTS}/01-default-columns.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } })

  await openColumns(page)
  await page.screenshot({ path: `${SHOTS}/02-chooser-open.png`, clip: { x: 0, y: 0, width: 1280, height: 520 } })
  // Title is not offered — it cannot be turned off.
  await expect(menu(page).locator('[data-column="title"]')).toHaveCount(0)
  await setColumn(page, 'created', true)
  await setColumn(page, 'updated', true)
  await setColumn(page, 'phase', true)
  await setColumn(page, 'session', false)

  // The table re-lays out live behind the open menu.
  const after = await headerLabels(page)
  expect(after).toEqual(expect.arrayContaining(['Title', 'Phase', 'Created', 'Updated']))
  expect(after).not.toContain('Session')
  // Display order is fixed: Phase precedes Due, timestamps come last.
  expect(after.indexOf('Phase')).toBeLessThan(after.indexOf('Due'))
  expect(after.indexOf('Created')).toBeLessThan(after.indexOf('Updated'))

  const r = row(page, OPEN_RECENT)
  await expect(r.locator('[data-col="created"]')).toHaveText(/^\d+d ago$/)
  await expect(r.locator('[data-col="updated"]')).toHaveText(/^\d+h ago$/)
  await expect(r.locator('[data-col="phase"]')).toHaveText('In Progress')
  await expect(r.locator('[data-col="session"]')).toHaveCount(0)
  // Tooltip carries the full timestamp.
  expect(await r.locator('[data-col="created"]').getAttribute('title')).toMatch(/\d/)
  await expectAligned(page, OPEN_RECENT)

  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
  await page.screenshot({ path: `${SHOTS}/03-extra-columns.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } })

  // New columns sort: one click on Created = ascending.
  await headers(page).filter({ hasText: 'Created' }).click()
  await expect(page.locator(`${TABLE} .tp-thead .tp-th.on`)).toContainText('Created')
  await expect(page.locator(`${TABLE} .tp-thead .tp-th.on .tp-th-arrow`)).toHaveText('▲')
  // Tags has no sort key: it is a plain label, not a button.
  await openColumns(page)
  await setColumn(page, 'tags', true)
  await page.keyboard.press('Escape')
  await expect(page.locator(`${TABLE} .tp-thead .tp-th-static`)).toHaveText('Tags')
  await expectAligned(page, OPEN_RECENT)

  // Reset to default restores the shipped layout.
  await openColumns(page)
  await menu(page).getByRole('button', { name: 'Reset to default' }).click()
  await page.keyboard.press('Escape')
  const reset = await headerLabels(page)
  expect(reset).toContain('Session')
  expect(reset).not.toContain('Created')
  expect(reset).not.toContain('Tags')
  await expectAligned(page, OPEN_RECENT)
})

test('project, filter, search and columns survive leaving the page and a reload', async ({ page, baseURL }) => {
  await isolateUiPrefs(page)
  await openHome(page, baseURL!)
  await gotoTasks(page)

  // Make four distinct choices.
  await openColumns(page)
  await setColumn(page, 'updated', true)
  await setColumn(page, 'session', false)
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="tasks-rail"] .tp-rail-item', { hasText: 'Lantern' }).click()
  await expect(page.locator('.tasks-page .tp-title')).toHaveText('Lantern')
  await chip(page, 'Done').click()
  await expect(chip(page, 'Done')).toHaveClass(/\bon\b/)
  await page.locator('.tasks-page .tp-search').fill('recent')
  await expect(row(page, OPEN_RECENT)).toBeVisible()
  const hitsBefore = await page.locator(`${TABLE} .tp-row`).count()
  await page.screenshot({ path: `${SHOTS}/04-choices-made.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } })

  const assertRestored = async (label: string) => {
    await expect(page.locator('.tasks-page .tp-title'), label).toHaveText('Lantern')
    await expect(page.locator('.tasks-page .tp-search'), label).toHaveValue('recent')
    await expect(chip(page, 'Done'), label).toHaveClass(/\bon\b/)
    await expect(chip(page, 'Todo'), label).toHaveClass(/\bon\b/)
    const labels = await headerLabels(page)
    expect(labels, label).toContain('Updated')
    expect(labels, label).not.toContain('Session')
    // A per-project board has no Project column, chosen or not.
    expect(labels, label).not.toContain('Project')
    await expect(row(page, OPEN_RECENT), label).toBeVisible()
    expect(await page.locator(`${TABLE} .tp-row`).count(), label).toBe(hitsBefore)
    await expect(page.locator('[data-testid="tasks-rail"] .tp-rail-item.active'), label).toHaveText(/Lantern/)
  }

  // Away and back: the route unmounted in between.
  await gotoHome(page)
  await gotoTasks(page)
  await assertRestored('after Home round-trip')
  await page.screenshot({ path: `${SHOTS}/05-restored-after-roundtrip.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } })

  // Reload: a fresh document, localStorage only.
  await page.reload()
  await expect(table(page)).toBeVisible({ timeout: 30_000 })
  await assertRestored('after reload')

  // Clearing is remembered too: back to All Tasks / no search → stays cleared.
  await page.locator('[data-testid="tasks-rail"] .tp-rail-item', { hasText: 'All Tasks' }).click()
  await page.locator('.tasks-page .tp-search').fill('')
  await gotoHome(page)
  await gotoTasks(page)
  await expect(page.locator('.tasks-page .tp-title')).toHaveText('All Tasks')
  await expect(page.locator('.tasks-page .tp-search')).toHaveValue('')
  // Project column is back now that we are on All Tasks — still chosen, was just scoped out.
  expect(await headerLabels(page)).toContain('Project')
})
