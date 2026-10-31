/**
 * The Brief above a lead's chat on the Org page (web/src/components/org/OrgBrief.tsx): the short
 * letter the lead's session rewrites at every turn end (FOR_USER_BRIEF, sessions/brief.ts), kept
 * current by Walnut.
 *
 * The fixture's mock CLI writes as its Brief what followed "brief: " in its last message, through
 * the real turn-end self-report.
 *
 * Scenario matrix (2026-10-30, the user: the Brief is only the AI's letter, in three sections, and
 * the Needs you cards belong to the default view, Task, whose four tabs read like the home panel):
 *  1. a lead with a Brief: the node opens on Task, its Needs you tab (Latest, the cards), the switch
 *     offers Brief with a dot for a rewrite not read yet; Brief shows the letter alone, in its three
 *     sections (Needs you, Working, Waiting / snoozed) with each task under its live status, its
 *     pills wearing that status, its time, no Needs you cards; Task brings the cards back; the
 *     Task view's four tabs carry the home panel's names and counts, and a count pill opens its tab;
 *  2. a named task moves: its pill recolors at once and its line moves to its new section, and
 *     nothing is added under the letter;
 *  3. Fold keeps the first lines and survives a reload; a reload opens on Task again;
 *  4. the lead rewrites its Brief while the page is open: the new letter shows with no reload, in
 *     its sections; a line with no task is stored with its issue, and the page shows no notice;
 *  5. a node whose contact keeps no Brief (one team, no lead) has no switch.
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
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

/** The heading of the section a task's pill sits under in the rendered letter. */
async function sectionOf(body: Locator, id: string): Promise<string> {
  const pill = body.locator(`a.task-link[data-task-id="${id}"]`)
  if (await pill.count() !== 1) return `pills: ${await pill.count()}`
  return pill.evaluate((a) => {
    // The last section heading before the pill, in document order.
    const heads = [...(a.closest('[data-testid="org-brief-body"]')?.querySelectorAll('h3') ?? [])]
    const before = heads.filter((h) => h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)
    return before.at(-1)?.textContent ?? `none in: ${a.closest('[data-testid="org-brief-body"]')?.innerHTML.slice(0, 400)}`
  })
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
  // The parser needs the user (a Needs you card on Status); the review has not started (Waiting).
  const res = await request.patch(`/api/tasks/${ids.parser}`, { data: { phase: 'NEED_ACTION' } })
  expect(res.ok(), await res.text()).toBe(true)
  // Written flat, in the wrong order: Walnut stores it in its three sections.
  const letter = [
    `- <task-ref id="${ids.review}" label="Review"/>: waits on the code review.`,
    `- <task-ref id="${ids.parser}" label="Parser"/>: the parser is half done, pick its output format.`,
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

test('a lead opens on Task with its Needs you cards; its Brief is the letter alone, in three sections', async ({ page }) => {
  // Each test has its own browser context, so the switch's memory (localStorage) starts empty.
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const top = detail.getByTestId('org-top')
  await expect(top).toHaveAttribute('data-view', 'task')
  await expect(detail.getByTestId('org-detail-latest')).toBeVisible()
  await expect(detail.locator(`[data-testid="org-alert"][data-task-id="${ids.parser}"]`)).toBeVisible()
  await expect(detail.getByTestId('org-top-brief-new')).toBeVisible()

  await detail.getByTestId('org-top-brief').click()
  await expect(top).toHaveAttribute('data-view', 'brief')
  const body = detail.getByTestId('org-brief-body')
  await expect(body).toContainText('the parser is half done')
  // Three sections in order, each task under its live status, an empty one says so.
  await expect(body.locator('h3')).toHaveText(['Needs you', 'Working', 'Waiting / snoozed'])
  await expect(body.locator('h3[data-brief-section]')).toHaveCount(3)
  await expect.poll(() => sectionOf(body, ids.parser)).toBe('Needs you')
  await expect.poll(() => sectionOf(body, ids.review)).toBe('Waiting / snoozed')
  await expect(body.locator(`a.task-link[data-task-id="${ids.parser}"]`)).toHaveAttribute('data-user-state', 'needs')
  await expect(body.locator(`a.task-link[data-task-id="${ids.review}"]`)).toHaveAttribute('data-user-state', 'waiting')
  await expect(detail.getByTestId('org-brief-foot')).toHaveText(/^Written /)
  // The Brief view is the letter alone: no Needs you cards, no Latest.
  await expect(detail.getByTestId('org-alerts')).toHaveCount(0)
  await expect(detail.getByTestId('org-top-brief-new')).toHaveCount(0)
  await expect(detail.getByTestId('org-detail-latest')).toHaveCount(0)
  await detail.getByTestId('org-top-task').click()
  await expect(detail.locator(`[data-testid="org-alert"][data-task-id="${ids.parser}"]`)).toBeVisible()
  // Four tabs, the home panel's names, Needs you first and open; Waiting / snoozed lists the review.
  // (The lead's own turn ended too, so it may need the user as well: counted, not pinned.)
  const tabs = detail.getByTestId('org-task-tab')
  await expect(tabs).toHaveText([/^Needs you\s*\d+$/, /^Working\s*\d+$/, /^Waiting \/ snoozed\s*\d+$/, /^Completed\s*\d+$/])
  const needsCount = Number((await tabs.first().locator('.org-task-tab-count').textContent()) ?? '-1')
  // Every one is a card, or the chat below holds it (the lead's own ask, its chat being open).
  const cards = await detail.getByTestId('org-alert').count()
  if (cards < needsCount) await expect(detail.getByTestId('org-task-empty')).toHaveText(cards ? `And ${needsCount - cards} in the chat below.` : 'Its ask is in the chat below.')
  await expect(detail.getByTestId('org-pill-needs')).toContainText(String(needsCount))
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-tab', 'needs')
  await detail.getByTestId('org-pill-waiting').click()
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-tab', 'waiting')
  await expect(detail.locator(`[data-testid="org-task-row"][data-task-id="${ids.review}"]`)).toBeVisible()
  await expect(detail.getByTestId('org-alerts')).toHaveCount(0)
})

test('a task the Brief names moves: its pill recolors and its line changes section, and nothing is added under the letter', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'brief')
  const res = await request.patch(`/api/tasks/${ids.review}`, { data: { phase: 'NEED_ACTION' } })
  expect(res.ok(), await res.text()).toBe(true)
  const body = detail.getByTestId('org-brief-body')
  const pill = body.locator(`a.task-link[data-task-id="${ids.review}"]`)
  await expect(pill).toHaveAttribute('data-user-state', 'needs', { timeout: 30_000 })
  // Its line follows it into Needs you, with no new turn of the lead.
  await expect.poll(() => sectionOf(body, ids.review)).toBe('Needs you')
  // Only the letter and its written time: no list of moves, no still-open footer, no cards.
  await expect(detail.getByTestId('org-brief').locator(':scope > *')).toHaveCount(2)
  await expect(detail.getByTestId('org-brief-foot')).toHaveText(/^Written [^·]*$/)
  await expect(detail.getByTestId('org-alerts')).toHaveCount(0)
  const back = await request.patch(`/api/tasks/${ids.review}`, { data: { phase: 'TODO' } })
  expect(back.ok(), await back.text()).toBe(true)
})

test('Fold keeps the first lines and survives a reload; a reload opens on Task', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  await detail.getByTestId('org-brief-fold').click()
  await expect(detail.getByTestId('org-brief')).toHaveClass(/is-folded/)
  await page.reload()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(LED))
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await expect(page.getByTestId('org-detail-latest')).toBeVisible()
  await page.getByTestId('org-top-brief').click()
  await expect(page.getByTestId('org-brief')).toHaveClass(/is-folded/)
  await page.getByTestId('org-brief-fold').click()
  await expect(page.getByTestId('org-brief')).not.toHaveClass(/is-folded/)
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
  const letter = `### Needs you\n- Pick the parser's output format.\n- <task-ref id="${ids.parser}" label="Parser"/>: waits on your pick.`
  const send = await request.post(`/api/v1/sessions/${sid}/messages`, { data: { text: `snapshot-clean-turn:Rewritten.\nbrief: ${letter}` } })
  expect(send.status(), await send.text()).toBeLessThan(300)
  await expect(body).toContainText('waits on your pick', { timeout: 60_000 })
  await expect(body).not.toContainText('the parser is half done')
  await expect(body.locator('h3')).toHaveText(['Needs you', 'Working', 'Waiting / snoozed'])
  await expect(body.locator(`a.task-link[data-task-id="${ids.parser}"]`)).toHaveAttribute('data-user-state', 'needs')
  // Its first line names no task: stored with that issue (brief-rules.ts), which the page does not show.
  const stored = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.brief as { issues?: Array<{ kind: string }> }
  expect(stored.issues?.map((i) => i.kind)).toEqual(['no_task'])
  await expect(detail.getByTestId('org-brief-foot')).toHaveText(/^Written [^·]*$/)
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
