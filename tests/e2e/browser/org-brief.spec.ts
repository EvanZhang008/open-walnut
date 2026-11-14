/**
 * The Brief above a lead's chat on the Org page (web/src/components/org/OrgBrief.tsx): the short
 * letter the lead's session keeps itself (brief_write = PUT /api/v1/tasks/:id/brief,
 * sessions/brief-write.ts), kept current by Walnut.
 *
 * The lead's writes go through the route its brief_write op calls, as its session would.
 *
 * Scenario matrix (2026-10-30, the user: the Brief is only the AI's letter, in three sections, and
 * the Needs you cards belong to the default view, Task, whose sections read like the home panel):
 *  1. a lead with a Brief: the node opens on Threads (tabs Threads, Tasks, Brief); Task shows All
 *     tasks with its Needs you section open (Latest, the cards), the switch
 *     offers Brief with a dot for a rewrite not read yet; Brief shows the letter alone, in its three
 *     sections (Needs you, Working, Waiting / snoozed) with each task under its live status, its
 *     pills wearing that status, its time, no Needs you cards; Task brings the cards back; the
 *     Task view's sections carry the home panel's names and counts, in its order, what waits folded,
 *     and a count pill opens its section in the same list;
 *  2. a named task moves: its pill recolors at once, its line moves to its new section and shows
 *     the task's words now, marked as moved, and the head says how many lines moved since; opening
 *     a stale Brief asks the lead for a refresh and the page says it is updating; a task asking the
 *     user that the letter leaves out is added in its own words; a named task that finishes leaves;
 *  3. Fold keeps the first lines and survives a reload; a reload opens on the view it was left on,
 *     and a section folded on the node stays folded;
 *  4. the lead rewrites its Brief while the page is open: the new letter shows with no reload, in
 *     its sections, no longer moved or updating; a line with no task is stored with its issue, and
 *     the page shows no notice;
 *  5. a node whose contact keeps no Brief (one team, no lead) has no switch.
 * The fixture is shared, so this file makes its own projects and removes what it made.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { sectionCount, taskRow, taskSection } from './org-view-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Brief led ${STAMP}`
const SOLO = `Brief solo ${STAMP}`
const made: string[] = []
const ids = { lead: '', parser: '', review: '', extra: '', solo: '' }
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

/** The lead's session writing its Brief (its brief_write op calls this route). */
async function writeBrief(request: APIRequestContext, data: unknown): Promise<{ issues: string[] }> {
  const res = await request.put(`/api/v1/tasks/${ids.lead}/brief`, { data })
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as { issues: string[] }
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
    const res = await request.delete(`/api/tasks/${id}?force=true`)
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
  // The lead has a session (its chat), whose turn ended; it writes its Brief itself.
  await post(request, '/api/sessions/quick-start', { cwd, message: 'snapshot-clean-turn:Started.', taskId: ids.lead })
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  await writeBrief(request, { content: letter })
  const stored = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.brief as { text: string }
  expect(stored.text).toContain('the parser is half done')
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
  // 2026-11-04, the user: "this thread shoudl also be the first ... and default ooen this".
  await expect(top).toHaveAttribute('data-view', 'threads')
  expect(await detail.locator('.org-top-tabs .org-top-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid'))))
    .toEqual(['org-top-threads', 'org-top-task', 'org-top-brief'])
  await detail.getByTestId('org-top-task').click()
  await expect(top).toHaveAttribute('data-view', 'task')
  // Beside the chat (design 10 of the ten the user was shown).
  await expect(detail.getByTestId('org-rail')).toHaveAttribute('data-placement', 'side')
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
  await expect(detail.getByTestId('org-brief-head')).toHaveText(/^Written [^·]*$/)
  await expect(body.locator('[data-brief-moved], [data-brief-added]')).toHaveCount(0)
  await detail.screenshot({ path: `test-results/org-brief-letter-${test.info().project.name}.png` })
  // The Brief view is the letter alone: no Needs you rows, no task sections.
  await expect(detail.getByTestId('org-alerts')).toHaveCount(0)
  await expect(detail.getByTestId('org-task-sections')).toHaveCount(0)
  await expect(detail.getByTestId('org-top-brief-new')).toHaveCount(0)
  await detail.getByTestId('org-top-task').click()
  await expect(detail.locator(`[data-testid="org-alert"][data-task-id="${ids.parser}"]`)).toBeVisible()
  // All tasks is one list (2026-11-12): Watching first (Home's watched tasks of this node's work,
  // org-pins.ts), then the home panel's names, To read folded into Needs you (5ef179d98: no section of
  // its own); a section with nothing in it is left out. Not started lists the review, nobody started it
  // (2026-11-09: its own section, out of Waiting / snoozed; the Brief keeps its three sections). What is
  // in front of the user now is open, what waits and what is done start folded. (The lead's own turn
  // ended too, so it may need the user as well: counted, not pinned.)
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')
  const ORDER = ['watching', 'needs', 'working', 'waiting', 'notstarted', 'done']
  const shownTabs = await detail.getByTestId('org-task-section').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab') ?? ''))
  expect(shownTabs, 'sections in the home panel\'s order').toEqual(ORDER.filter((t) => shownTabs.includes(t)))
  expect(shownTabs).toEqual(expect.arrayContaining(['needs', 'notstarted']))
  const LABELS: Record<string, RegExp> = { watching: /^Watching\s*\d+$/, needs: /^Needs you\s*\d+$/, working: /^Working\s*\d+$/, waiting: /^Waiting \/ snoozed\s*\d+$/, notstarted: /^Not started\s*\d+$/, done: /^Completed\s*\d+$/ }
  await expect(detail.getByTestId('org-task-section-head')).toHaveText(shownTabs.map((t) => LABELS[t]!))
  await expect(taskSection(detail, 'needs')).toHaveAttribute('data-open', '1')
  await expect(taskSection(detail, 'needs').getByTestId('org-task-section-head')).toHaveAttribute('aria-expanded', 'true')
  await expect(taskSection(detail, 'notstarted')).toHaveAttribute('data-open', '0')
  await expect(taskRow(detail, ids.review)).toHaveCount(0)
  const needsCount = Number((await sectionCount(detail, 'needs').textContent()) ?? '-1')
  // Every one is a card, the lead's own ask included (the first, named for the node).
  await expect(detail.getByTestId('org-alert')).toHaveCount(needsCount)
  const own = detail.locator('[data-testid="org-alert"][data-own="1"]')
  if (await own.count()) {
    await expect(detail.getByTestId('org-alert').first()).toHaveAttribute('data-own', '1')
    await expect(own.getByTestId('org-ask-own')).toContainText('asks you')
  }
  // The node's header counts its threads, never its tasks' asks (those are this section).
  await expect(detail.getByTestId('org-pill-needs')).toHaveCount(0)
  await expect(detail.getByTestId('org-pill-threads')).toHaveText(/^\d+ threads?$/)
  // A count in the header opens its section in the same list; Needs you stays open beside it.
  await detail.getByTestId('org-pill-notstarted').click()
  await expect(detail.getByTestId('org-task-view')).toHaveAttribute('data-mode', 'all')
  await expect(taskSection(detail, 'notstarted')).toHaveAttribute('data-open', '1')
  await expect(taskRow(detail, ids.review, 'notstarted')).toBeVisible()
  await expect(taskSection(detail, 'needs')).toHaveAttribute('data-open', '1')
  await detail.screenshot({ path: `test-results/org-task-waiting-${test.info().project.name}.png` })
})

test('a task the Brief names moves: its line shows it now, the head counts it, a refresh is asked; a new ask is added, a finished line leaves', async ({ page, request }) => {
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
  // Its line follows it into Needs you, with no new turn of the lead, and says where it is now.
  await expect.poll(() => sectionOf(body, ids.review)).toBe('Needs you')
  const line = body.locator('li', { has: page.locator(`a.task-link[data-task-id="${ids.review}"]`) })
  await expect(line).toHaveAttribute('data-brief-moved', 'needs')
  await expect(line.getByTestId('org-brief-now')).toHaveText(/^Now: /)
  await expect(detail.getByTestId('org-brief-moved')).toHaveText(' · 1 line moved since')
  // The user is looking at a stale Brief: one refresh is asked of the lead, and the page says so.
  await expect(detail.getByTestId('org-brief-updating')).toBeVisible({ timeout: 20_000 })
  const asked = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.brief_refresh as { by: string; moved: number }
  expect(asked).toMatchObject({ by: 'web', moved: 1 })
  await detail.screenshot({ path: `test-results/org-brief-moved-${test.info().project.name}.png` })
  // A task that asks the user and is not in the letter: Walnut adds it, in its own words.
  ids.extra = await createTask(request, `Extra ${STAMP}`, LED)
  const ask = await request.patch(`/api/tasks/${ids.extra}`, { data: { phase: 'NEED_ACTION' } })
  expect(ask.ok(), await ask.text()).toBe(true)
  const added = body.locator(`li[data-brief-added]`, { has: page.locator(`a.task-link[data-task-id="${ids.extra}"]`) })
  await expect(added).toBeVisible({ timeout: 30_000 })
  await expect(added.getByTestId('org-brief-now')).toHaveText(/^Added by Walnut/)
  await expect.poll(() => sectionOf(body, ids.extra)).toBe('Needs you')
  // A named task that finishes leaves the letter.
  const done = await request.patch(`/api/tasks/${ids.extra}`, { data: { phase: 'COMPLETE' } })
  expect(done.ok(), await done.text()).toBe(true)
  await expect(body.locator(`a.task-link[data-task-id="${ids.extra}"]`)).toHaveCount(0, { timeout: 30_000 })
  // Only the head and the letter: no list of moves under it, no cards.
  await expect(detail.getByTestId('org-brief').locator(':scope > *')).toHaveCount(2)
  await expect(detail.getByTestId('org-alerts')).toHaveCount(0)
  const back = await request.patch(`/api/tasks/${ids.review}`, { data: { phase: 'TODO' } })
  expect(back.ok(), await back.text()).toBe(true)
})

// 2026-11-10, the CEO's reflection: Walnut's lines in a Chinese Brief led with English words, and a
// task the writer then named itself read twice (Walnut's line and the writer's).
test('in a Chinese Brief Walnut writes its line in Chinese, and a task the writer names reads once', async ({ page, request }) => {
  await isolateUiPrefs(page)
  const asker = await createTask(request, `Asker ${STAMP}`, LED)
  const ask = await request.patch(`/api/tasks/${asker}`, { data: { phase: 'NEED_ACTION' } })
  expect(ask.ok(), await ask.text()).toBe(true)
  const none = '- \u65e0'
  const letter = `### Needs you\n${none}\n### Working\n- <task-ref id="${ids.review}" label="Review"/>\uff1a\u5728\u7b49\u4ee3\u7801\u5ba1\u9605\u3002\n### Waiting / snoozed\n${none}`
  await writeBrief(request, { content: letter })
  const stored = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.brief as { text: string; added?: string[]; lang?: string }
  const walnutLine = (stored.added ?? []).find((l) => l.includes(asker))
  expect(walnutLine, stored.text).toBeTruthy()
  expect(stored.lang).toBe('zh')
  expect(walnutLine).not.toMatch(/Decide|Take a look|Can close|Needs you/)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  const body = detail.getByTestId('org-brief-body')
  const pills = body.locator(`a.task-link[data-task-id="${asker}"]`)
  await expect(pills).toHaveCount(1, { timeout: 30_000 })
  const line = body.locator('li', { has: page.locator(`a.task-link[data-task-id="${asker}"]`) })
  await expect(line).toContainText(/[\u4e00-\u9fff]/)
  await expect(line).not.toContainText(/Decide|Take a look|Can close/)
  await detail.screenshot({ path: `test-results/org-brief-walnut-zh-${test.info().project.name}.png` })
  // The writer names the task in its own line, leaving Walnut's line as it was: one line shows.
  const own = `- <task-ref id="${asker}" label="Asker"/>\uff1a\u7b49\u4f60\u770b\u4e00\u4e0b\u63d0\u95ee\u3002`
  await writeBrief(request, { edits: [{ old: '### Working', new: `${own}\n### Working` }] })
  const after = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.brief as { text: string }
  expect(after.text.split('\n').filter((l) => l.includes(asker))).toEqual([own])
  await expect(body.locator('li', { has: page.locator(`a.task-link[data-task-id="${asker}"]`) })).toContainText('\u7b49\u4f60\u770b\u4e00\u4e0b\u63d0\u95ee', { timeout: 30_000 })
  await expect(body.locator(`a.task-link[data-task-id="${asker}"]`)).toHaveCount(1)
  await detail.screenshot({ path: `test-results/org-brief-one-line-${test.info().project.name}.png` })
  await removeTask(request, asker)
  // The lead's letter as the tests after this one expect it.
  await writeBrief(request, { content: [
    `- <task-ref id="${ids.review}" label="Review"/>: waits on the code review.`,
    `- <task-ref id="${ids.parser}" label="Parser"/>: the parser is half done, pick its output format.`,
  ].join('\n') })
})

test('Fold keeps the first lines and survives a reload; each node opens on the view it was left on', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  // A node seen for the first time opens on Threads.
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
  await detail.getByTestId('org-top-brief').click()
  await detail.getByTestId('org-brief-fold').click()
  await expect(detail.getByTestId('org-brief')).toHaveClass(/is-folded/)
  // A reload comes back on the Brief, still folded (2026-11-01, the user: "Walnut needs to
  // remember what was open last time, permanently, on every page").
  // Every view the top shows from the first frame on, with the task list answering late: never
  // Task for a moment before the Brief.
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __topViews: string[] }).__topViews = seen
    new MutationObserver(() => {
      const v = document.querySelector('[data-testid="org-top"]')?.getAttribute('data-view')
      if (v && seen[seen.length - 1] !== v) seen.push(v)
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-view'] })
  })
  await page.route('**/api/tasks?*', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue() })
  await page.reload()
  // A whole new mount (the dev bundle again, the task list held 1.5 s above): the first load's
  // budget, not the 5 s default (CI: one attempt ran out on a loaded runner). What is graded is
  // the order of the views, which __topViews records from the first frame however long it takes.
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(LED), { timeout: 30_000 })
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'brief')
  await page.waitForTimeout(2_000)
  expect(await page.evaluate(() => (window as unknown as { __topViews: string[] }).__topViews)).toEqual(['brief'])
  await page.unroute('**/api/tasks?*')
  await expect(page.getByTestId('org-brief')).toHaveClass(/is-folded/)
  await page.getByTestId('org-brief-fold').click()
  await expect(page.getByTestId('org-brief')).not.toHaveClass(/is-folded/)
  // The view is the node's own: Main opens on its own (Task: before Main has started it shows its
  // tasks alone), and the lead's Brief waits for it.
  await page.getByTestId('org-channel-main').click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', 'main')
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await openNode(page, LED)
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'brief')
  // The Task view's folds too: Needs you (open by default, the parser asks) folded, another page, back.
  await page.getByTestId('org-top-task').click()
  const needs = taskSection(page, 'needs')
  await expect(needs).toHaveAttribute('data-open', '1')
  await needs.getByTestId('org-task-section-head').click()
  await expect(needs).toHaveAttribute('data-open', '0')
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await openNode(page, LED)
  await expect(page.getByTestId('org-top')).toHaveAttribute('data-view', 'task')
  await expect(needs).toHaveAttribute('data-open', '0')
  await expect(needs.getByTestId('org-task-section-head')).toHaveAttribute('aria-expanded', 'false')
})

test('a rewrite reaches an open Brief at once, with no reload', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-brief').click()
  const body = detail.getByTestId('org-brief-body')
  await expect(body).toContainText('the parser is half done')
  const letter = `### Needs you\n- Pick the parser's output format.\n- <task-ref id="${ids.parser}" label="Parser"/>: waits on your pick.`
  const { issues } = await writeBrief(request, { content: letter })
  expect(issues).toHaveLength(1)
  await expect(body).toContainText('waits on your pick', { timeout: 30_000 })
  await expect(body).not.toContainText('the parser is half done')
  await expect(body.locator('h3')).toHaveText(['Needs you', 'Working', 'Waiting / snoozed'])
  await expect(body.locator(`a.task-link[data-task-id="${ids.parser}"]`)).toHaveAttribute('data-user-state', 'needs')
  // Its first line names no task: stored with that issue (brief-rules.ts), which the page does not show.
  const stored = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.brief as { issues?: Array<{ kind: string }> }
  expect(stored.issues?.map((i) => i.kind)).toEqual(['no_task'])
  await expect(detail.getByTestId('org-brief-head')).toHaveText(/^Written [^·]*$/)
  await expect(body.locator('[data-brief-moved], [data-brief-added]')).toHaveCount(0)
  // An edit of one line, as brief_write's edits do.
  await writeBrief(request, { edits: [{ old: 'waits on your pick.', new: 'waits on your pick of the format.' }] })
  await expect(body).toContainText('waits on your pick of the format.', { timeout: 30_000 })
})

test('a subtask\'s ask sits under its top-level task in the Task view, once', async ({ page, request }) => {
  const sub = await createTask(request, `Sub ${STAMP}`, LED)
  const linked = await request.patch(`/api/tasks/${sub}`, { data: { parent_task_id: ids.parser } })
  expect(linked.ok(), await linked.text()).toBe(true)
  // A worker asks the user something concrete (a bare hand-back of a worker waits on its lead).
  const ask = await request.put(`/api/v1/tasks/${sub}/report`, { data: { state: 'needs', ask: 'Which three screenshots?' } })
  expect(ask.ok(), await ask.text()).toBe(true)
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  // A node opens on Threads; the asks are in its Tasks.
  await detail.getByTestId('org-top-task').click()
  const card = detail.locator(`[data-testid="org-alert"][data-task-id="${sub}"]`)
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  await expect(card.getByTestId('org-ask-via')).toHaveText(`Parser ${STAMP} ›`)
  // Right after its top-level task's own card.
  const order = await detail.getByTestId('org-alert').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
  expect(order.indexOf(sub)).toBe(order.indexOf(ids.parser) + 1)
  await detail.screenshot({ path: `test-results/org-ask-via-${test.info().project.name}.png` })
  // The breadcrumb opens the top-level task itself, on Home (a task reference, useOpenTask): it has
  // no session, so Home's list has it selected; nothing opens beside the Org page.
  await card.getByTestId('org-ask-via').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  await expect(page.locator(`#home-task-navigation [data-task-id="${ids.parser}"]`).and(page.locator('.task-focused, .todo-pinned-card-active'))).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('org-side')).toHaveCount(0)
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await removeTask(request, sub)
})

test('a node whose contact keeps no Brief has no switch', async ({ page }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, SOLO)
  const detail = page.getByTestId('org-detail')
  await expect(detail.getByTestId('org-task-view')).toBeVisible()
  await expect(detail.getByTestId('org-top-brief')).toHaveCount(0)
  await expect(detail.getByTestId('org-brief')).toHaveCount(0)
})

test('the rail sits beside the chat at full height, or above it on a narrow window; they never overlap', async ({ page }) => {
  // 2026-10-31: the user picked the rail beside the chat ("10"); before it, prod WebKit showed the
  // chat running up under its own header right below the Task panel, read as the two overlapping.
  await isolateUiPrefs(page)
  await loadHome(page)
  await openNode(page, LED)
  const detail = page.getByTestId('org-detail')
  const rail = detail.getByTestId('org-rail')
  // The chat draws no header of its own here (the node's one header holds its controls): its
  // composer stands for it being drawn.
  const header = detail.locator('[data-testid="org-chat"] .chat-input-textarea')
  await expect(header).toBeVisible({ timeout: 30_000 })
  const boxes = () => page.evaluate(() => {
    const rect = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null
    const r = rect('[data-testid="org-rail"]')!
    const chat = rect('[data-testid="org-chat"]')!
    const history = rect('[data-testid="org-chat"] .session-history')!
    return { railLeft: r.left, railRight: r.right, railTop: r.top, railBottom: r.bottom, chatLeft: chat.left, chatRight: chat.right, chatTop: chat.top, chatBottom: chat.bottom, historyTop: history.top }
  })
  for (const [width, height, placement] of [[1280, 800, 'side'], [1280, 560, 'side'], [900, 800, 'top']] as const) {
    await page.setViewportSize({ width, height })
    await expect(rail).toHaveAttribute('data-placement', placement)
    for (const view of ['org-top-task', 'org-top-brief'] as const) {
      await detail.getByTestId(view).click()
      await expect(header).toBeVisible()
      await expect.poll(async () => {
        const b = await boxes()
        const apart = placement === 'side' ? b.chatRight <= b.railLeft + 0.5 && b.chatTop <= b.railTop + 0.5 : b.railBottom <= b.chatTop + 0.5
        return apart && b.historyTop >= b.chatTop - 0.5
      }, { message: `${view} at ${width}x${height}: ${JSON.stringify(await boxes())}` }).toBe(true)
      await detail.screenshot({ path: `test-results/org-rail-${placement}-${view}-${height}-${test.info().project.name}.png` })
    }
  }
})
