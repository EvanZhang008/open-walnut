/**
 * An ask answered from its Org row stays answered on the page while the answer is on its way, however
 * long that takes (2026-11-19: the page predicted Working for 10 s; an answer that reached its session
 * later than that put the row back under Needs you, and a moment later the server's Working took it
 * away again, a visible flicker).
 *
 * The prediction is now held while the answer is on its way (OrgPage answers.start: predictStatus
 * with `holds` and a 60 s `keepMs`, web/src/components/org/org-answered.ts), and the server derives
 * a turn that starts on its fast lane (src/core/user-status-sync.ts sessionMovesNow).
 *
 * Scenario matrix (a lead's Tasks, a decision letter's two actions in its row):
 *  1. Answered with the answer POST held for 12 s (past the old 10 s): the row goes on the click and
 *     is drawn in no frame while the answer is held; the Home row of the task reads no Needs you
 *     either; after the release the answer is on record.
 *  2. A refused answer bringing the row back with its reason is org-alert-answer.spec.ts's.
 * The fixture is shared, so this file makes its own project and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { showTasks } from './org-view-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Org held answer ${STAMP}`
const HOLD_MS = 12_000
const made: string[] = []
const ids = { lead: '', letter: '' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`
const alertRow = (page: Page, id: string) => page.locator(`[data-testid="org-alert"][data-task-id="${id}"]`)

async function post<T>(request: APIRequestContext, url: string, data: unknown, headers?: Record<string, string>): Promise<T> {
  const res = await request.post(url, { data, ...(headers ? { headers } : {}) })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Lease ${STAMP}`, project: PROJECT, source: 'local' })
  ids.letter = task.id
  made.push(task.id)
  // A second task: a project of one task has no lead (its contact is the task itself).
  const other = await post<{ task: { id: string } }>(request, '/api/tasks', { title: `Deposit ${STAMP}`, project: PROJECT, source: 'local' })
  made.push(other.task.id)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
  await post(request, '/api/sessions/quick-start', { cwd, message: `Held lead ready ${STAMP}`, taskId: ids.lead })
  const { sessionId } = await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message: `Lease ready ${STAMP}`, taskId: ids.letter })
  const sent = await request.post('/api/v1/human-inbox', {
    headers: { 'x-walnut-caller-sid': sessionId },
    data: { subject: `Sign the lease ${STAMP}?`, type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes', markdown: 'Pick one.', actions: [{ id: 'sign', label: 'Sign it' }, { id: 'wait', label: 'Not yet' }] },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  expect((await request.patch(`/api/tasks/${ids.letter}`, { data: { phase: 'NEED_ACTION' } })).ok()).toBe(true)
  await expect.poll(async () => ((await (await request.get(`/api/tasks/${ids.letter}`)).json()).task?.user_status?.source ?? ''), { timeout: 60_000 }).toBe('letter')
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } }).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

/** Record, every animation frame from now on, whether the task's ask row is drawn. */
async function watchRow(page: Page, id: string): Promise<() => Promise<boolean[]>> {
  await page.evaluate((taskId) => {
    const seen = new Set<boolean>()
    const w = window as unknown as { __heldSeen?: Set<boolean> }
    w.__heldSeen = seen
    const tick = () => {
      if (w.__heldSeen !== seen) return
      seen.add(!!document.querySelector(`[data-testid="org-alert"][data-task-id="${taskId}"]`))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, id)
  return () => page.evaluate(() => [...((window as unknown as { __heldSeen?: Set<boolean> }).__heldSeen ?? [])])
}

test('an answer held past ten seconds never puts its row back under Needs you', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.getByTestId('org-search').fill(PROJECT)
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  await expect(page.getByTestId('org-detail-title')).toHaveText(`${PROJECT} VP`)
  await showTasks(page)
  const row = alertRow(page, ids.letter)
  await expect(row).toBeVisible({ timeout: 60_000 })

  let sent = 0
  let answered = 0
  const held: Route[] = []
  await page.route('**/api/v1/human-inbox/*/answer', (route) => { sent += 1; held.push(route) })
  const inline = page.locator(`[data-testid="org-answer-inline"][data-answer-task="${ids.letter}"]`)
  await inline.getByTestId('org-answer-letter').getByTestId('org-answer-option').filter({ hasText: 'Sign it' }).click()
  await expect(row).toHaveCount(0, { timeout: 700 })
  const seen = await watchRow(page, ids.letter)
  await page.waitForTimeout(HOLD_MS)
  expect(sent).toBeGreaterThanOrEqual(1)
  expect(answered).toBe(0)
  expect(await seen(), 'the answered row was drawn again while its answer was held').toEqual([false])
  await page.screenshot({ path: `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots/org-answer-held-${test.info().project.name}.png` }).catch(() => {})

  for (const r of held.splice(0)) { await r.continue(); answered += 1 }
  await page.unroute('**/api/v1/human-inbox/*/answer')
  await expect.poll(async () => {
    const list = ((await (await request.get('/api/v1/human-inbox')).json()).letters ?? []) as Array<{ subject: string; answered?: { actionId: string } }>
    return list.find((l) => l.subject === `Sign the lease ${STAMP}?`)?.answered?.actionId ?? ''
  }, { timeout: 30_000 }).toBe('sign')
})
