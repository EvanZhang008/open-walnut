/**
 * The Brief's "new" dot goes in every window of the browser the moment the Brief is read in one
 * (2026-11-19: the read mark is kept per browser in localStorage, and a window that was already
 * open kept showing the dot until something else re-rendered it).
 *
 * Both windows read the mark from one store (web/src/components/org/org-brief-model.ts
 * subscribeSeen): a read here moves it at once, and another window's read reaches it through the
 * browser's `storage` event.
 *
 * Scenario matrix (one browser, two windows on the same lead's node in Org, both on Task with the
 * Brief tab marked new):
 *  1. Window B opens the Brief: window A's dot goes inside ONE_SECOND, with no reload and no click
 *     in window A; window B's dot goes as well.
 *  2. The lead rewrites its Brief: the dot comes back in both windows (a read mark covers only the
 *     letter it was made for).
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Brief seen ${STAMP}`
const ONE_SECOND = 1_000
const made: string[] = []
let lead = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function writeBrief(request: APIRequestContext, content: string): Promise<void> {
  const res = await request.put(`/api/v1/tasks/${lead}/brief`, { data: { content } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function openNodeOnTask(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(LED)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await detail.getByTestId('org-top-task').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
}

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Seen ${STAMP}`, project: LED, source: 'local' })
  made.push(task.id)
  // A second task: a project of one task has no lead (its contact is the task itself).
  const other = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Other ${STAMP}`, project: LED, source: 'local' })
  made.push(other.task.id)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: LED })
  lead = contact.task.id
  made.push(lead)
  await post(request, '/api/sessions/quick-start', { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: lead })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  await writeBrief(request, `- <task-ref id="${task.id}" label="Seen"/>: the first letter ${STAMP}.`)
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } }).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

test('a Brief read in one window takes its dot off the other window at once', async ({ context, request }) => {
  const a = await context.newPage()
  const b = await context.newPage()
  await openNodeOnTask(a)
  await openNodeOnTask(b)
  const dotA = a.getByTestId('org-detail').getByTestId('org-top-brief-new')
  const dotB = b.getByTestId('org-detail').getByTestId('org-top-brief-new')
  await expect(dotA).toBeVisible({ timeout: 30_000 })
  await expect(dotB).toBeVisible()

  // Window B reads it; window A is left alone.
  await b.bringToFront()
  await b.getByTestId('org-detail').getByTestId('org-top-brief').click()
  await expect(b.getByTestId('org-detail').getByTestId('org-brief-body')).toContainText(`the first letter ${STAMP}`)
  await expect(dotB).toHaveCount(0)
  await expect(dotA).toHaveCount(0, { timeout: ONE_SECOND })
  await a.screenshot({ path: `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/org-brief-seen-other-window-${test.info().project.name}.png` }).catch(() => {})

  // A new letter is news again, in the window that read the old one too.
  await b.getByTestId('org-detail').getByTestId('org-top-task').click()
  await writeBrief(request, `- the second letter ${STAMP}.`)
  await expect(dotA).toBeVisible({ timeout: 30_000 })
  await expect(dotB).toBeVisible({ timeout: 30_000 })
})
