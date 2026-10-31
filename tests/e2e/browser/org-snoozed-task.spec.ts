/**
 * A snoozed task on the Org page (2026-10-30, the user: a snoozed task "still showing here" as a red
 * Needs you card; "if it is snoozed, it is not needs you"). Two tasks of one project hand back to the
 * user; one has a start date two weeks out. Only the other one needs the user: the counts, the
 * alert list and the Team tab say so in the one set of names (src/core/user-status.ts), and the
 * snoozed one reads "Snoozed until <date>" under Waiting / snoozed. Moving its start date to the past
 * brings it back as Needs you, live.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

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
  for (const id of made) await request.delete(`/api/tasks/${id}`)
})

test('a snoozed task is not Needs you on the Org page; its date passing brings it back', async ({ page, request }) => {
  await openOrg(page)
  const row = page.locator(`[data-testid="org-channel"][data-key="project:${PROJECT.toLowerCase()}"]`)
  await expect(row.getByTestId('org-channel-badge')).toHaveText('1', { timeout: 30_000 })
  await row.click()
  const detail = page.getByTestId('org-detail')
  const counts = detail.getByTestId('org-detail-counts')
  await expect(counts).toContainText('1 Needs you')
  await expect(counts).toContainText('Waiting / snoozed')
  await expect(counts).not.toContainText('need you')
  // Only the plain one is asked of the user.
  await expect(detail.locator(`[data-testid="org-alert"][data-task-id="${ids.plain}"]`)).toBeVisible()
  await expect(detail.locator(`[data-testid="org-alert"][data-task-id="${ids.snoozed}"]`)).toHaveCount(0)

  await detail.getByTestId('org-tab-team').click()
  const col = (key: string) => detail.locator(`[data-testid="org-team-col"][data-column="${key}"]`)
  await expect(col('needs').locator('.org-team-head')).toContainText('Needs you')
  await expect(col('needs').locator(`[data-task-id="${ids.plain}"]`)).toBeVisible()
  await expect(col('waiting').locator('.org-team-head')).toContainText('Waiting / snoozed')
  const snoozedItem = col('waiting').locator(`[data-task-id="${ids.snoozed}"]`)
  await expect(snoozedItem).toBeVisible()
  await expect(snoozedItem.getByTestId('org-team-note')).toContainText(`Snoozed until ${later}`)
  if (SHOTS) await detail.screenshot({ path: `${SHOTS}/org-snoozed-team.png` })

  // The date comes: the start date moves into the past and the task needs the user again, live.
  await patch(request, ids.snoozed, { start_date: '2026-01-01' })
  await expect(col('needs').locator(`[data-task-id="${ids.snoozed}"]`)).toBeVisible({ timeout: 30_000 })
  await detail.getByTestId('org-tab-chat').click()
  await expect(counts).toContainText('2 Needs you', { timeout: 30_000 })
  if (SHOTS) await detail.screenshot({ path: `${SHOTS}/org-snooze-ended.png` })
})
