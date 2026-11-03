/**
 * A row under a status section renames like every task row: double-click its title, type,
 * Enter saves; Escape puts the old title back (2026-11-03, the user, on a row under Watching:
 * "whhy the preivosu avaiible text edit cna't be done here?"). The source guard is
 * tests/web/task-row-title-edit.test.ts; this walks the real rows of Watching, Needs you,
 * Waiting / snoozed and Completed.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, type StatusSectionKey } from './status-section-helpers'

const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

async function seed(page: Page, project: string, title: string, patch: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  const p = await page.request.patch(`/api/v1/tasks/${id}`, { data: patch })
  expect(p.ok(), await p.text()).toBe(true)
  return id
}

async function titleOf(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/api/v1/tasks/${id}`)
  return ((await res.json()) as { task: { title: string } }).task.title
}

test('a status section row renames on a double-click of its title', async ({ page }) => {
  test.setTimeout(180_000)
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  const stamp = Date.now()
  const project = `Rename${stamp}`
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  const rows: Array<[StatusSectionKey, string]> = [
    ['watching', await seed(page, project, `rename watched ${stamp}`, { phase: 'TODO', watched_at: new Date().toISOString() })],
    ['needs', await seed(page, project, `rename needs ${stamp}`, { phase: 'NEED_ACTION' })],
    ['waiting', await seed(page, project, `rename parked ${stamp}`, { phase: 'WAITING', wait_until: new Date(Date.now() + 6 * 3600e3).toISOString() })],
    ['done', await seed(page, project, `rename done ${stamp}`, { phase: 'COMPLETE' })],
  ]
  await page.reload()
  const panel = page.locator('.todo-panel').first()

  for (const [key, id] of rows) {
    await setStatusSectionOpen(panel, key, true)
    const card = await showSectionCard(panel, key, id)
    const title = card.locator('.todo-pinned-title')
    const before = (await title.textContent()) ?? ''

    // Escape keeps the old title.
    await title.dblclick()
    await expect(title, `${key}: editing`).toHaveAttribute('contenteditable', 'true')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(`${before} x`)
    await page.keyboard.press('Escape')
    await expect(title).toHaveAttribute('contenteditable', 'false')
    await expect(title).toHaveText(before)

    // Enter saves.
    await title.dblclick()
    // The caret lands where the pointer was; select the title and type it whole.
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(`${before} renamed`)
    await page.keyboard.press('Enter')
    await expect(title).toHaveAttribute('contenteditable', 'false')
    await expect.poll(() => titleOf(page, id), { message: `${key}: saved` }).toBe(`${before} renamed`)
    await expect(card.locator('.todo-pinned-title')).toHaveText(`${before} renamed`)
  }
})
