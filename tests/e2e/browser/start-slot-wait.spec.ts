import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test, expect } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'

test('a slot wait is explicit in task details and Cancel removes only its waiting start', async ({ page, request, baseURL }) => {
  const title = `Slot wait ${Date.now()}`
  const made = await request.post('/api/tasks', { data: { title, source: 'local', project: 'Garden' } })
  expect(made.ok()).toBe(true)
  const id = (await made.json()).task.id as string
  const { walnutHome } = await discoverBrowserFixture(Number(process.env.PW_TEST_PORT ?? 3457))
  const db = new DatabaseSync(`${walnutHome}/tasks/tasks.sqlite`)
  const row = db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string | null }
  const payload = JSON.parse(row.payload ?? '{}')
  const reason = 'all 7 slots taken'
  const entry = { at: new Date().toISOString(), parent_id: id, caller_sid: 'fixture-slot-wait', host: '__local__', reason, wait_for_slot: true, params: {} }
  db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run(JSON.stringify({ ...payload, start_queue: entry, team_stop: { at: entry.at, by: 'human', when: 'now', members: [] }, user_status: { state: 'waiting', kind: 'machine', waitingOn: `Waiting for a free slot on this Mac (${reason}): Walnut starts it automatically when there is room` } }), id)
  db.close()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  try {
    await isolateUiPrefs(page)
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
    await page.getByRole('link', { name: 'Open Walnut' }).click()
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await selectSection(page, 'All')
    await page.locator('.todo-search-input').fill(title)
    const task = page.locator(`.todo-panel-item[data-task-id="${id}"]:visible`).first()
    await expect(task).toBeVisible()
    await task.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
    const line = page.getByTestId('task-detail-start-queue')
    await expect(line).toContainText('Waiting for a free slot')
    await expect(line).toContainText('Walnut starts it automatically')
    await expect(page.getByTestId('task-detail-start-queue-now')).toBeVisible()
    const shots = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
    fs.mkdirSync(shots, { recursive: true })
    await page.locator('.task-detail-modal').screenshot({ path: `${shots}/start-slot-wait.png` })
    await page.getByTestId('task-detail-start-queue-cancel').click()
    await expect(line).toHaveCount(0)
    const after = await request.get(`/api/tasks/${id}`)
    const body = await after.json()
    expect((body.task ?? body).start_queue).toBeFalsy()

    await page.getByRole('button', { name: 'Close detail panel' }).click()
    const again = new DatabaseSync(`${walnutHome}/tasks/tasks.sqlite`)
    const current = again.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string }
    again.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(current.payload), start_queue: { ...entry, params: { expectReply: false, message: 'Read the garden release.' } } }), id)
    again.close()
    await page.setViewportSize({ width: 900, height: 700 })
    // Open a fresh page by a real link so the direct fixture write is read again.
    await page.setContent(`<a href="${baseURL}/">Open Walnut again</a>`)
    await page.getByRole('link', { name: 'Open Walnut again' }).click()
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await selectSection(page, 'All')
    await page.locator('.todo-search-input').fill(title)
    await task.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
    await expect(line).toContainText('Waiting for a free slot')
    const startedResponse = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${id}/start-queue/start`) || r.url().endsWith(`/api/v1/tasks/${id}/start-queue/start`))
    await page.getByTestId('task-detail-start-queue-now').click()
    const started = await startedResponse
    expect(started.ok(), await started.text()).toBe(true)
    await expect(line).toHaveCount(0)
    expect(errors).toEqual([])
  } finally { await request.delete(`/api/tasks/${id}?force=true`) }
})
