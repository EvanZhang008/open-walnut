/**
 * A lead's Threads in the browser specs about a lead and a task below it (thread-fold-under-task,
 * thread-result-below): make the tasks and their sessions, flip the pop-up flag, open the lead.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

export const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

export async function send<T>(request: APIRequestContext, method: 'post' | 'patch', url: string, data: unknown, sid?: string): Promise<T> {
  const res = await request[method](url, { data, ...(sid ? { headers: { 'x-walnut-caller-sid': sid } } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

/** The experiment threads_pop_up on or off. */
export async function popUpFlag(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put('/api/config', { data: { experimental: { threads_pop_up: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

export async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

export async function startSession(request: APIRequestContext, taskId: string, fixtureRoot: string): Promise<string> {
  await send(request, 'post', '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId })
  let sid = ''
  await expect.poll(async () => (sid = (await (await request.get(`/api/tasks/${taskId}`)).json()).task?.session_id ?? ''), { timeout: 90_000 }).not.toBe('')
  return sid
}

/** The project's lead, with its Threads open, through the Org page. */
export async function openLead(page: Page, project: string): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(project))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

export const card = (page: Page, id: string) => page.getByTestId('org-rail').locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)

/** The lead's Threads rail as a picture, named for the spec, the step and the browser. */
export async function shot(page: Page, spec: string, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('org-rail').screenshot({ path: `${SHOTS}/${spec}-${name}-${test.info().project.name}.png` })
}
