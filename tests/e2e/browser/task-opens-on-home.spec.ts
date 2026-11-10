/**
 * A task opens on Home, from anywhere, and its details are edited in Home's popup.
 *
 * 2026-11-02, the user: "why I click task it open this page, nonono it should always, anywhere,
 * go to home page ... don't have this stupid page ... for ever". The separate `/tasks/:id` page
 * is gone (web/src/utils/task-path.ts); `/tasks/:id` is a shim that selects the task in the task
 * panel and opens its session. tests/web/task-page-guard.test.ts fails on new code that builds
 * the path by hand; this spec walks the entries a person uses and the old links.
 *
 * The same day's screenshot showed the old page on "Saving...": opening a task's description
 * wrote the editor's re-serialization of it back (a mail task's `<sender@host>` came back as a
 * mailto link). Opening is not an edit, so the popup's editors must write nothing until typed in.
 */
import { expect, test, type Page } from '@playwright/test'
import { revealInTasksTable } from './tasks-table-helpers'
import { selectSection } from './todo-panel-helpers'

const TASK_ID = 'pw-task-store-sync'
const TITLE = 'Store sync fixture task'

// The first page of a fresh fixture server waits on Vite's cold transform, which takes tens of
// seconds on a loaded machine; the app's own work after it is fast.
test.describe.configure({ timeout: 90_000 })

const located = (page: Page, id: string) =>
  page.locator(`#home-task-navigation [data-task-id="${id}"]`).and(page.locator('.task-focused, .todo-pinned-card-active'))

/**
 * The task panel never changes its tab by itself (6b083a264, 2026-11-04): a task opened from
 * outside that the tab does not draw leaves the user on their tab with a note saying where it is,
 * and the note's "Show in …" goes there. Which tab a fresh browser opens on is the fixture's shared
 * ui-prefs (ui-prefs-sync mirrors walnut-todo-active-section), so another spec's pick decides it
 * (2026-11-05 CI shard 14: task-move-project.spec.ts had just picked Focus): either way is the rule.
 */
async function expectOnHome(page: Page, id: string): Promise<void> {
  // The shim moves the address once the app has loaded, which on a cold fixture page waits on
  // Vite's first transform (above): the same minute the task gets.
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/')
  const note = page.locator('#home-task-navigation [data-testid="todo-offview-note"]')
  await expect.poll(async () => (await located(page, id).count()) + (await note.count()), { timeout: 60_000 }).toBeGreaterThan(0)
  if (await located(page, id).count() === 0) {
    await expect(note).toContainText(`${TITLE} is not in `)
    await note.getByTestId('todo-offview-show').click()
    await expect(note).toHaveCount(0)
  }
  await expect(located(page, id)).toHaveCount(1, { timeout: 20_000 })
  await expect(located(page, id)).toBeInViewport()
}

test('an old /tasks/<id> link and an old task pop-out link open the task on Home', async ({ page }) => {
  await page.goto(`/tasks/${TASK_ID}`)
  await expectOnHome(page, TASK_ID)

  await page.goto(`/popout?view=task&id=${TASK_ID}`)
  await expectOnHome(page, TASK_ID)
})

test('an old link opened on a tab that does not draw the task: the note says so, and Show in brings the task into view', async ({ page }) => {
  await page.goto('/')
  await selectSection(page, 'Focus')
  try {
    await page.goto(`/tasks/${TASK_ID}`)
    const note = page.locator('#home-task-navigation [data-testid="todo-offview-note"]')
    await expect(note).toContainText(`${TITLE} is not in Focus.`, { timeout: 60_000 })
    await expect(located(page, TASK_ID)).toHaveCount(0)
    // The tab it opens renders in a transition: the scroll waits for it (TodoPanel showAfterSwitchRef).
    await note.getByTestId('todo-offview-show').click()
    await expect(note).toHaveCount(0)
    await expect(located(page, TASK_ID)).toHaveCount(1, { timeout: 20_000 })
    await expect(located(page, TASK_ID)).toBeInViewport()
  } finally {
    // The tab is shared through the fixture's ui-prefs: leave it on All, the default.
    await selectSection(page, 'All')
  }
})

test('a task clicked on the Tasks page opens on Home, and its menu\'s Details opens the popup there', async ({ page }) => {
  await page.goto('/')
  await page.locator('a[href="/tasks"]').first().click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/tasks')
  // The table draws only the rows in view once the shared fixture holds many tasks.
  const title = page.locator('.tp-row-title', { hasText: TITLE }).first()
  await revealInTasksTable(page, title)
  await expect(title).toBeVisible({ timeout: 20_000 })
  await title.click()
  await expectOnHome(page, TASK_ID)
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)

  await page.locator('a[href="/tasks"]').first().click()
  const row = page.locator(`.tp-row-title`, { hasText: TITLE }).first().locator('xpath=ancestor::*[@data-task-id][1]')
  await revealInTasksTable(page, row)
  await row.hover()
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  await expectOnHome(page, TASK_ID)
  await expect(page.locator('.task-detail-modal .todo-detail-title')).toHaveText(TITLE)
})

test('opening a task\'s details writes nothing; typing in its description saves', async ({ page, request }) => {
  // Text the editor re-serializes differently (an email autolink): an open that wrote it back
  // would show here as a PUT with no keystroke.
  const created = await request.post('/api/tasks', { data: { title: 'No write on open fixture', project: '' } })
  expect(created.ok()).toBe(true)
  const id = ((await created.json()) as { task: { id: string } }).task.id
  const original = 'From: Team <notify@example.com> Sent: today\n\n> quoted line'
  expect((await request.put(`/api/tasks/${id}/description`, { data: { content: original } })).ok()).toBe(true)

  const writes: string[] = []
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes(`/api/tasks/${id}`)) writes.push(`${r.method()} ${new URL(r.url()).pathname}`) })

  await page.goto('/')
  await page.locator('.todo-search-input').fill('No write on open fixture')
  const row = page.locator(`.todo-panel-item[data-task-id="${id}"]:visible`).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  const editor = modal.locator('[data-testid="task-detail-description"] .ProseMirror')
  await expect(editor).toContainText('quoted line')
  await page.waitForTimeout(2_000)
  expect(writes, 'opening the popup wrote the task').toEqual([])
  expect(((await (await request.get(`/api/tasks/${id}`)).json()) as { task: { description: string } }).task.description).toBe(original)
  await expect(modal.locator('[data-testid="task-detail-description"] .notes-save-status')).not.toHaveText('Saving...')

  await editor.locator('blockquote').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' typed')
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: { description: string } }).task.description, { timeout: 10_000 })
    .toContain('quoted line typed')

  await request.delete(`/api/tasks/${id}?force=true`)
})
