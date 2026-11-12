/**
 * A snoozed task on the Org page (2026-10-30, the user: a snoozed task "still showing here" as a red
 * Needs you card; "if it is snoozed, it is not needs you"). Two tasks of one project hand back to the
 * user; one has a start date two weeks out. Only the other one needs the user: the counts, the
 * alert list and the All tasks sections say so in the one set of names (src/core/user-status.ts), and the
 * snoozed one reads "Snoozed until <date>" under Waiting / snoozed. Moving its start date to the past
 * brings it back as Needs you, live.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { openSection, openTasksBy, sectionCount, taskRow, taskSection, expectChatShown } from './org-view-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Snoozeflow ${STAMP}`
const made: string[] = []
const ids = { lead: '', snoozed: '', plain: '' }
const SHOTS = process.env.PW_SHOT_DIR ?? ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const later = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function patch(request: APIRequestContext, id: string, data: unknown): Promise<void> {
  const res = await request.patch(`/api/tasks/${id}`, { data })
  expect(res.ok(), await res.text()).toBe(true)
}

async function userState(request: APIRequestContext, id: string): Promise<string> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { user_status?: { state: string; snoozed?: unknown } }
  return `${task.user_status?.state ?? ''}${task.user_status?.snoozed ? '+snoozed' : ''}`
}

async function openOrg(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page).toHaveURL(/\/org(\?|$)/)
  await expect(page.getByTestId('org-page')).toBeVisible()
}

test.beforeAll(async ({ request }) => {
  for (const key of ['snoozed', 'plain'] as const) {
    const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `${key} ask ${STAMP}`, project: PROJECT, source: 'local' })
    made.push(task.id)
    ids[key] = task.id
    await patch(request, task.id, { phase: 'NEED_ACTION' })
  }
  await patch(request, ids.snoozed, { start_date: later })
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  await expect.poll(() => userState(request, ids.snoozed), { timeout: 30_000 }).toBe('waiting+snoozed')
  await expect.poll(() => userState(request, ids.plain), { timeout: 30_000 }).toBe('needs')
})

test.afterAll(async ({ request }) => {
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`)
})

test('a snoozed task is not Needs you on the Org page; its date passing brings it back', async ({ page, request }) => {
  await openOrg(page)
  const row = page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.toLowerCase()}"]`)
  // A VP's own row: its badge is its threads (none here), never its tasks' asks.
  await expect(row.getByTestId('org-channel-badge')).toHaveText('0', { timeout: 30_000 })
  await row.click()
  const detail = page.getByTestId('org-detail')
  const counts = detail.getByTestId('org-detail-counts')
  await expect(counts).toContainText('0 threads')
  await expect(counts).toContainText('Waiting / snoozed')
  await expect(counts).not.toContainText(/needs? you/i)
  // A lead opens on its Threads (2026-11-04); its tasks' asks are in Tasks.
  await openTasksBy(detail, 'all')
  const needs = taskSection(detail, 'needs')
  await expect(needs.getByTestId('org-task-section-head')).toContainText('Needs you')
  await expect(sectionCount(detail, 'needs')).toHaveText('1')
  // Only the plain one is asked of the user.
  await expect(needs.locator(`[data-testid="org-alert"][data-task-id="${ids.plain}"]`)).toBeVisible()
  await expect(detail.locator(`[data-testid="org-alert"][data-task-id="${ids.snoozed}"]`)).toHaveCount(0)

  // The snoozed one is under Waiting / snoozed (folded by default), saying until when.
  await openSection(detail, 'waiting')
  await expect(taskSection(detail, 'waiting').getByTestId('org-task-section-head')).toContainText('Waiting / snoozed')
  const snoozedRow = taskRow(detail, ids.snoozed, 'waiting')
  await expect(snoozedRow).toBeVisible()
  await expect(snoozedRow.getByTestId('org-task-note')).toContainText(`Snoozed until ${later}`)
  await expect(taskRow(detail, ids.snoozed)).toHaveCount(1)
  if (SHOTS) await detail.screenshot({ path: `${SHOTS}/org-snoozed-team.png` })

  // The date comes: the start date moves into the past and the task needs the user again, live.
  await patch(request, ids.snoozed, { start_date: '2026-01-01' })
  await expect(needs.locator(`[data-testid="org-alert"][data-task-id="${ids.snoozed}"]`)).toBeVisible({ timeout: 30_000 })
  await expectChatShown(detail)
  await expect(needs.getByTestId('org-alert')).toHaveCount(2, { timeout: 30_000 })
  await expect(sectionCount(detail, 'needs')).toHaveText('2')
  await expect(taskRow(detail, ids.snoozed, 'waiting')).toHaveCount(0)
  if (SHOTS) await detail.screenshot({ path: `${SHOTS}/org-snooze-ended.png` })
})
