/**
 * The Brief above a lead's chat on the Org page (web/src/components/org/OrgBrief.tsx): the short
 * letter the lead's session rewrites at every turn end (FOR_USER_BRIEF, sessions/brief.ts), kept
 * current by Walnut.
 *
 * The fixture's mock CLI writes as its Brief what followed "brief: " in its last message, through
 * the real turn-end self-report.
 *
 * Scenario matrix:
 *  1. a lead with a Brief: the node opens on Status as before (Latest, Needs you), the switch
 *     offers Brief with a dot for a rewrite not read yet; Brief shows the letter, its task pills
 *     wearing their live status, its time, and the dot goes;
 *  2. a named task moves: its pill recolors at once and the foot lists it under "Since then",
 *     with no new turn of the lead;
 *  3. Fold keeps the first lines; the pick and the fold survive a reload;
 *  4. the lead rewrites its Brief while the page is open: the new letter shows with no reload;
 *     a needs-you line with no task is flagged under it, and a rewrite that keeps the rules
 *     clears the flag;
 *  5. a node whose contact keeps no Brief (one team, no lead) has no switch.
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Brief led ${STAMP}`
const SOLO = `Brief solo ${STAMP}`
const made: string[] = []
const ids = { lead: '', parser: '', review: '', solo: '' }
let cwd = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`
const row = (page: Page, project: string) => page.locator(`[data-testid="org-channel"][data-key="${rowKey(project)}"]`)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string, project: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project, source: 'local' })
  made.push(task.id)
  return task.id
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function openNode(page: Page, project: string): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await row(page, project).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(project))
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  cwd = `${fixtureRoot}/projects/walnut`
  ids.parser = await createTask(request, `Parser ${STAMP}`, LED)
  ids.review = await createTask(request, `Review ${STAMP}`, LED)
  ids.solo = await createTask(request, `Solo ${STAMP}`, SOLO)
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: LED })
  ids.lead = contact.task.id
  made.push(ids.lead)
  const letter = [
    '**Needs you:** nothing right now.',
    `- <task-ref id="${ids.parser}" label="Parser"/>: the parser is half done.`,
    `- <task-ref id="${ids.review}" label="Review"/>: waits on the code review.`,
  ].join('\n')
  // The lead's session writes it at its turn end, through the real self-report: the fixture's
  // mock CLI answers FOR_USER_BRIEF with what followed "brief: " in its message.
  await post(request, '/api/sessions/quick-start', { cwd, message: `snapshot-clean-turn:Brief written.\nbrief: ${letter}`, taskId: ids.lead })
  let last: Record<string, unknown> = {}
  await expect.poll(async () => {
    last = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task ?? {}
    return (last.brief as { text?: string } | undefined)?.text ?? ''
  }, { timeout: 90_000, message: 'the lead\'s Brief' }).toContain('the parser is half done')
    .catch((err) => { throw new Error(`${err}\nlead: ${JSON.stringify({ org_role: last.org_role, phase: last.phase, status_report: last.status_report, summary: last.summary })}`) })
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test('a lead opens on Status; its Brief is one click away, with live task pills', async ({ page }) => {
  // Each test has its own browser context, so the switch's memory (localStorage) starts empty.
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const top = detail.getByTestId('org-top')
  await expect(top).toHaveAttribute('data-view', 'status')
  await expect(detail.getByTestId('org-detail-latest')).toBeVisible()
  await expect(detail.getByTestId('org-top-brief-new')).toBeVisible()

  await detail.getByTestId('org-top-brief').click()
  await expect(top).toHaveAttribute('data-view', 'brief')
  const body = detail.getByTestId('org-brief-body')
  await expect(body).toContainText('the parser is half done')
  await expect(body).toContainText('Needs you:')
  // Each named task wears its status now: both are not started (waiting).
  await expect(body.locator(`a.task-link[data-task-id="${ids.parser}"]`)).toHaveAttribute('data-user-state', 'waiting')
  await expect(body.locator(`a.task-link[data-task-id="${ids.review}"]`)).toHaveAttribute('data-user-state', 'waiting')
  await expect(detail.getByTestId('org-brief-foot')).toContainText('Written')
  await expect(detail.getByTestId('org-top-brief-new')).toHaveCount(0)
  await expect(detail.getByTestId('org-detail-latest')).toHaveCount(0)
})

test('a task the Brief names moves: its pill recolors and the foot lists it, with no new turn', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'brief')
  const res = await request.patch(`/api/tasks/${ids.parser}`, { data: { phase: 'NEED_ACTION' } })
  expect(res.ok(), await res.text()).toBe(true)
  const pill = detail.getByTestId('org-brief-body').locator(`a.task-link[data-task-id="${ids.parser}"]`)
  await expect(pill).toHaveAttribute('data-user-state', 'needs', { timeout: 30_000 })
  const moved = detail.getByTestId('org-brief-moves')
  await expect(moved).toContainText('Since then:')
  await expect(moved.locator(`[data-task-id="${ids.parser}"]`)).toContainText('needs you')
  await expect(moved.locator(`[data-task-id="${ids.review}"]`)).toHaveCount(0)
})

test('Fold keeps the first lines, and the pick and the fold survive a reload', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  await detail.getByTestId('org-brief-fold').click()
  await expect(detail.getByTestId('org-brief')).toHaveClass(/is-folded/)
  await page.reload()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(LED))
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'brief')
  await expect(page.getByTestId('org-brief')).toHaveClass(/is-folded/)
  await page.getByTestId('org-brief-fold').click()
  await expect(page.getByTestId('org-brief')).not.toHaveClass(/is-folded/)
  await page.getByTestId('org-top-status').click()
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'status')
  await expect(page.getByTestId('org-detail-latest')).toBeVisible()
})

test('a rewrite reaches an open Brief at once, with no reload', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  const body = detail.getByTestId('org-brief-body')
  await expect(body).toContainText('the parser is half done')
  const sid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.session_id as string
  const letter = `**Needs you:** pick the parser's output format.\n- <task-ref id="${ids.parser}" label="Parser"/>: waits on your pick.`
  const send = await request.post(`/api/v1/sessions/${sid}/messages`, { data: { text: `snapshot-clean-turn:Rewritten.\nbrief: ${letter}` } })
  expect(send.status(), await send.text()).toBeLessThan(300)
  await expect(body).toContainText('pick the parser\'s output format', { timeout: 60_000 })
  await expect(body).not.toContainText('the parser is half done')
  await expect(body.locator(`a.task-link[data-task-id="${ids.parser}"]`)).toHaveAttribute('data-user-state', 'needs')
  // Its needs-you line names no task: Walnut stores the Brief with that issue and says so (brief-rules.ts).
  const issues = detail.getByTestId('org-brief-issues')
  await expect(issues).toContainText('1 line breaks the Brief rules (no task)')
  await expect(issues).toHaveAttribute('title', /pick the parser's output format/)
  // A rewrite that keeps the rules clears it (after the triage cooldown, so its turn is reported).
  await page.waitForTimeout(6_000)
  const fixed = `- <task-ref id="${ids.parser}" label="Parser"/>: pick the parser's output format, JSON or CSV.`
  const again = await request.post(`/api/v1/sessions/${sid}/messages`, { data: { text: `snapshot-clean-turn:Fixed.\nbrief: ${fixed}` } })
  expect(again.status(), await again.text()).toBeLessThan(300)
  await expect(body).toContainText('JSON or CSV', { timeout: 60_000 })
  await expect(issues).toHaveCount(0)
})

test('a node whose contact keeps no Brief has no switch', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, SOLO)
  const detail = page.getByTestId('org-detail')
  await expect(detail.getByTestId('org-detail-latest')).toBeVisible()
  await expect(detail.getByTestId('org-top-brief')).toHaveCount(0)
  await expect(detail.getByTestId('org-brief')).toHaveCount(0)
})
