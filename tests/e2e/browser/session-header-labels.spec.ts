/**
 * The session header's title row: the title, the state pills (the wait, Cron, Trigger,
 * Worker, Leader), ONE folded control for the link tags, and the kebab.
 *
 * 2026-11-02, the user: "idle and running don't need to show ... the tag still noisy, all
 * collapse, user can click". 2026-11-03, the user: "only tag go there, other should still
 * outside, like trigger ... leader ... worker", and "worker when click should not directly
 * jump, should show a list of leader and all worker".
 *
 *   - tags + Trigger + Leader: the row holds trigger, leader, the tags control and the kebab;
 *     the control counts the tags alone and its flyout lists only tags, inside the window;
 *     Escape and an outside click close it, it opens again, a link still opens what it opens;
 *   - only Worker: the row holds worker and the kebab, no tags control; the Worker pill opens
 *     the team (the leader first, then every open worker, this one marked), and a row leads
 *     to that task;
 *   - nothing: the row holds the kebab alone;
 *   - a narrow row draws every state pill as its letter, and the title keeps its room;
 *   - no Running / Idle / Stopped word anywhere in the header, the Ask slot's included.
 *
 * The source half is tests/web/session-header-labels-guard.test.ts. Fixtures:
 * each test makes its own task and session (`ownSession`), and `pw-task-links`
 * (test-server.ts) lends its link tags to one that must carry them.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { REAL_PANEL } from './draft-helpers'
import { discoverBrowserFixture } from './codex-test-audit'

const PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${PORT}`
let fixtureRoot = ''
const SHOT_DIR = '/tmp/session-header-labels'
const litter: string[] = []
const litterRoutines: string[] = []
const restoreParent: string[] = []
const restoreTags: Array<{ id: string; tags: string[]; added: string[] }> = []

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, source: 'local', ...opts })
  litter.push(task.id)
  return task.id
}

/** Give `taskId` the link tags of `pw-task-links` for this test (put back after it). The
 *  fixture with the tags cannot lead: its id is a prefix of another fixture's. */
async function borrowLinkTags(taskId: string): Promise<void> {
  const get = async (id: string) => (await api<{ task: { tags?: string[] } }>('GET', `/api/tasks/${id}`)).task.tags ?? []
  const links = await get('pw-task-links')
  expect(links.length, 'pw-task-links carries its link tags').toBeGreaterThan(1)
  const own = await get(taskId)
  restoreTags.push({ id: taskId, tags: own, added: links.filter((t) => !own.includes(t)) })
  await api('PATCH', `/api/tasks/${taskId}`, { set_tags: links })
}

/** A task of this test's own with a session, so no other spec's subtasks or tags reach its
 *  header (a shared fixture's Leader count moved under a parallel spec). */
async function ownSession(title: string): Promise<{ taskId: string; sessionId: string }> {
  const taskId = await createTask(title, { project: 'Walnut', pinned: false })
  const { sessionId } = await api<{ sessionId: string }>('POST', '/api/sessions/quick-start', {
    cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Ready.', taskId,
  })
  return { taskId, sessionId }
}

async function armTrigger(taskId: string): Promise<void> {
  const { job } = await api<{ job: { id: string } }>('POST', '/api/v1/routines/trigger', {
    name: 'Header labels watch', description: 'Watches nothing; it only puts a Trigger pill on the header.',
    run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: taskId,
  })
  litterRoutines.push(job.id)
}

async function openHome(page: Page) {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function openTaskSession(page: Page, taskId: string, sessionId: string, search: string): Promise<Locator> {
  await page.locator('.todo-search-input').fill(search)
  const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 45_000 })
  await expect(panel.locator('.session-panel-title-meta .task-kebab-btn')).toBeVisible()
  await expect(panel.locator('.session-panel-header-top', { hasText: 'Loading...' })).toHaveCount(0, { timeout: 15_000 })
  return panel
}

/** What the title row holds besides the title area, by kind; anything unknown is named. */
async function titleRowParts(panel: Locator): Promise<string[]> {
  return panel.locator('.session-panel-header-top').evaluate((row) => {
    const kinds: string[] = []
    const kindOf = (c: HTMLElement): string => {
      if (c.matches('[data-testid="session-header-labels"]')) return 'tags'
      if (c.querySelector('.task-kebab-btn') || c.classList.contains('task-kebab-btn')) return 'kebab'
      if (c.matches('[data-testid="task-trigger-pill"]')) return 'trigger'
      if (c.matches('[data-testid="leader-pill"]')) return 'leader'
      if (c.matches('[data-testid="pr-pill"]')) return 'pr'
      if (c.matches('[data-testid="subtask-pill"]')) return 'worker'
      if (c.matches('.session-cron-pill')) return 'cron'
      if (c.matches('.task-waiting-chip')) return 'wait'
      if (c.matches('[data-header-pill="embedded"]')) return 'embedded'
      return `UNKNOWN:${c.className || c.tagName}`
    }
    for (const el of Array.from(row.children) as HTMLElement[]) {
      if (el.classList.contains('session-panel-title-area')) continue
      if (el.classList.contains('session-panel-header-leading')) { kinds.push('leading'); continue }
      if (el.classList.contains('thread-mode-pill-slot')) { kinds.push('thread-mode'); continue }
      if (el.classList.contains('session-panel-title-meta')) {
        for (const c of Array.from(el.children) as HTMLElement[]) kinds.push(kindOf(c))
        continue
      }
      kinds.push(`UNKNOWN:${el.className || el.tagName}`)
    }
    // The title area holds the unread dot, the phase circle and the title, nothing else.
    const area = row.querySelector(':scope > .session-panel-title-area')
    for (const c of Array.from(area?.children ?? []) as HTMLElement[]) {
      const ok = c.classList.contains('session-panel-title') || c.classList.contains('session-panel-title-input')
        || c.classList.contains('task-unread-dot') || c.classList.contains('task-quick-actions')
      if (!ok) kinds.push(`UNKNOWN-in-title-area:${c.className || c.tagName}`)
    }
    return kinds
  })
}

const MATRIX = /matrix r5/i

const STATUS_WORDS = /\b(Running|Idle|Stopped|Not available)\b/

async function expectNoStatus(panel: Locator) {
  const text = await panel.locator('.session-panel-header').innerText()
  expect(text).not.toMatch(STATUS_WORDS)
}

async function expectInViewport(page: Page, el: Locator) {
  const box = (await el.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5)
}

/** The title keeps its room: it is at least `share` of the row. */
async function expectTitleRoom(panel: Locator, share: number) {
  const row = (await panel.locator('.session-panel-header-top').boundingBox())!
  const title = (await panel.locator('.session-panel-title-area').boundingBox())!
  expect(title.width, `title ${title.width}px of a ${row.width}px row`).toBeGreaterThan(row.width * share)
}

// Each test makes its own task and session (ownSession); pw-task-links lends its link tags.

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(PORT))
})

test.beforeEach(async ({ page }) => {
  litter.length = 0
  litterRoutines.length = 0
  restoreParent.length = 0
  restoreTags.length = 0
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litterRoutines) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const id of restoreParent) await api('PATCH', `/api/tasks/${id}`, { parent_task_id: '' }).catch(() => undefined)
  for (const { id, added } of restoreTags) await api('PATCH', `/api/tasks/${id}`, { remove_tags: added }).catch(() => undefined)
  for (const id of [...litter].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

for (const width of [1440, 900]) {
  test(`tags fold into one control, Trigger and Leader stay on the row, at ${width}px`, async ({ page, browserName }) => {
    test.setTimeout(150_000)
    await page.setViewportSize({ width, height: 860 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const { taskId: lead, sessionId } = await ownSession(`Header tags lead ${stamp}`)
    await borrowLinkTags(lead)
    await createTask(`Header tags worker A ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: lead })
    await createTask(`Header tags worker B ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: lead })
    await armTrigger(lead)
    await openHome(page)
    const panel = await openTaskSession(page, lead, sessionId, `Header tags lead ${stamp}`)

    const tags = panel.locator('[data-testid="session-header-labels"]')
    await expect(panel.locator('.session-panel-title-meta [data-testid="task-trigger-pill"]')).toBeVisible({ timeout: 20_000 })
    await expect(panel.locator('.session-panel-title-meta [data-testid="leader-pill"]')).toHaveText(/^Leader · 2$/, { timeout: 20_000 })
    await expect(tags).toBeVisible({ timeout: 20_000 })
    // pw-task-links' tags include a pull request, whose status pill is a state pill: on the row.
    expect(await titleRowParts(panel)).toEqual(['trigger', 'pr', 'leader', 'tags', 'kebab'])
    await expectNoStatus(panel)
    // No tag is drawn on the row itself: they all live in the control.
    await expect(panel.locator('.session-panel-header-top .task-tag-pills')).toHaveCount(0)
    await expectTitleRoom(panel, 0.35)
    await fs.mkdir(SHOT_DIR, { recursive: true })
    await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-${width}-closed.png`, animations: 'disabled' })

    // The count is the tags the flyout lists, and the flyout lists tags alone.
    const count = Number(await tags.locator('.session-header-labels-count').innerText())
    expect(count).toBeGreaterThan(1)
    await tags.click()
    const flyout = page.locator('[data-testid="session-header-labels-flyout"]:visible')
    await expect(flyout).toHaveCount(1)
    await expect(tags).toHaveAttribute('aria-expanded', 'true')
    await expect(flyout.locator('.tag-chip')).toHaveCount(count)
    await expect(flyout.locator('.task-trigger-pill, .task-team-pill, .session-cron-pill, .task-waiting-chip')).toHaveCount(0)
    await expectInViewport(page, flyout)
    // The plan file's tag, by its name (the display name lives on pw-task-links alone).
    await expect(flyout).toContainText(MATRIX)
    await page.screenshot({ path: `${SHOT_DIR}/${browserName}-${width}-open.png`, animations: 'disabled' })

    // Escape closes, a click on the control opens again, an outside click closes. A toast's
    // status line mounting on <body> meanwhile is no layer of the list (it once swallowed Escape).
    await page.evaluate(() => {
      const live = document.createElement('div')
      live.id = 'pw-live-region'
      live.setAttribute('role', 'status')
      live.textContent = 'Saved'
      document.body.appendChild(live)
    })
    await page.keyboard.press('Escape')
    await expect(flyout).toHaveCount(0)
    await page.evaluate(() => document.getElementById('pw-live-region')?.remove())
    await expect(tags).toHaveAttribute('aria-expanded', 'false')
    for (let round = 0; round < 3; round++) {
      await tags.click()
      await expect(flyout).toHaveCount(1)
      await page.mouse.click(5, 855)
      await expect(flyout).toHaveCount(0)
    }
    // From the keyboard the focus goes into the list.
    await tags.focus()
    await page.keyboard.press('Enter')
    await expect(flyout).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="session-header-labels-flyout"]'))).toBe(true)
    // Escape closes one layer at a time: the focused tag's own card, when it opened, then the list.
    // What sits on <body> names the layer that kept it open, should one ever do so.
    const bodyKids = () => page.evaluate(() => Array.from(document.body.children).map((el) =>
      `${el.tagName}.${(el as HTMLElement).className}[${el.getAttribute('role') ?? ''}] rects=${el.getClientRects().length}`).join(' ; '))
    // The focused tag is a link: its card shows a moment later and takes the first Escape.
    const hoverCard = page.locator('[data-testid="link-hover-card"]')
    await expect(hoverCard).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(hoverCard).toHaveCount(0)
    await expect(flyout).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => flyout.count(), { message: `the list stayed open; body: ${await bodyKids()}` }).toBe(0)

    // The Leader pill on the row still lists its workers, and a press on it closes the open
    // tags list: one flyout at a time (every pill stops its own pointerdown).
    await tags.click()
    await expect(flyout).toHaveCount(1)
    await panel.locator('.session-panel-title-meta [data-testid="leader-pill"]').click()
    const subs = page.locator('[data-testid="leader-subtasks-flyout"]')
    await expect(subs.locator('[data-testid="leader-sub-row"]')).toHaveCount(2)
    await expect(flyout).toHaveCount(0)
    await expectInViewport(page, subs)
    // And the other way round: the Trigger pill closes the Leader's list.
    await panel.locator('.session-panel-title-meta [data-testid="task-trigger-pill"]').click()
    await expect(subs).toHaveCount(0)
    await expect(page.locator('.trigger-jobs-flyout')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.trigger-jobs-flyout')).toHaveCount(0)

    // A link in the list still opens what it opens (a file opens in Files).
    await tags.click()
    await flyout.locator('.tag-chip', { hasText: MATRIX }).first().click()
    await expect(panel.locator('.session-action-chip-active', { hasText: 'Files' }).or(panel.locator('[data-header-id="files"].session-action-chip-active'))).toHaveCount(1, { timeout: 10_000 })
    expect(errors).toEqual([])
  })
}

test('only a Worker: no tags control, and the Worker pill opens its team', async ({ page, browserName }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const leader = await createTask(`Header team lead ${stamp}`, { project: 'Walnut', pinned: false })
  const fellow = await createTask(`Header team fellow ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: leader })
  const { taskId: self, sessionId } = await ownSession(`Header team self ${stamp}`)
  await openHome(page)
  const panel = await openTaskSession(page, self, sessionId, `Header team self ${stamp}`)
  // Made a worker while its chat is open: the header takes the pill as it happens.
  await api('PATCH', `/api/tasks/${self}`, { parent_task_id: leader })
  restoreParent.push(self)
  const worker = panel.locator('.session-panel-title-meta [data-testid="subtask-pill"]')
  await expect(worker).toContainText('Worker', { timeout: 20_000 })
  expect(await titleRowParts(panel)).toEqual(['worker', 'kebab'])
  await expectNoStatus(panel)
  await expectTitleRoom(panel, 0.6)
  // The whole board again, so the leader's row is there to be located at the end.
  await page.locator('.todo-search-input').fill('')

  await worker.click()
  const team = page.locator('[data-testid="worker-team-flyout"]')
  await expect(team).toBeVisible()
  await expectInViewport(page, team)
  await expect(team.locator('[data-testid="worker-team-leader"]')).toHaveAttribute('data-task-id', leader)
  const rows = team.locator('[data-testid="worker-team-row"]')
  await expect(rows).toHaveCount(2)
  await expect(team.locator(`[data-testid="worker-team-row"][data-task-id="${self}"]`)).toHaveAttribute('aria-current', 'true')
  await expect(team.locator(`[data-testid="worker-team-row"][data-task-id="${self}"]`)).toContainText('This task')
  await expect(team.locator(`[data-testid="worker-team-row"][data-task-id="${fellow}"]`)).toContainText(`Header team fellow ${stamp}`)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${SHOT_DIR}/${browserName}-worker-team.png`, animations: 'disabled' })
  // Escape closes it, an outside click too.
  await page.keyboard.press('Escape')
  await expect(team).toHaveCount(0)
  await worker.click()
  await expect(team).toBeVisible()
  await page.mouse.click(5, 855)
  await expect(team).toHaveCount(0)
  // From the keyboard the focus goes into the list (a portal Tab would never reach).
  await worker.focus()
  await page.keyboard.press('Enter')
  await expect(team).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="worker-team-flyout"]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(team).toHaveCount(0)
  // The leader's row leads to the leader.
  await worker.click()
  await team.locator('[data-testid="worker-team-leader"]').click()
  await expect(team).toHaveCount(0)
  await expect(page.locator(`.todo-panel-item[data-task-id="${leader}"]`)).toHaveClass(/task-focused/, { timeout: 10_000 })

  // Released from the team, nothing is left beside the title but the kebab.
  await api('PATCH', `/api/tasks/${self}`, { parent_task_id: '' })
  await expect(worker).toHaveCount(0, { timeout: 20_000 })
  expect(await titleRowParts(panel)).toEqual(['kebab'])
})

test('a narrow row puts the labels on a line under the title, each in full', async ({ page, browserName }) => {
  // 2026-11-04, the user, on a narrow column whose title read "Aut..." beside "Wait un...":
  // "maybe we shoud make the lable another line if the space is narrow".
  test.setTimeout(150_000)
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const { taskId: lead, sessionId } = await ownSession(`Header narrow lead ${stamp}`)
  await createTask(`Header narrow worker ${stamp}`, { project: 'Walnut', pinned: false, parent_task_id: lead })
  await armTrigger(lead)
  await page.setViewportSize({ width: 1440, height: 860 })
  await openHome(page)
  const panel = await openTaskSession(page, lead, sessionId, `Header narrow lead ${stamp}`)
  const row = panel.locator('.session-panel-header-top')
  const trigger = row.locator('[data-testid="task-trigger-pill"]')
  await expect(trigger).toBeVisible({ timeout: 20_000 })
  // Narrow the panel itself (the column) below the row's fold width.
  await panel.evaluate((el) => { (el as HTMLElement).style.width = '400px'; (el as HTMLElement).style.flex = 'none' })
  await expect(row).toHaveAttribute('data-header-fit', 'tight')
  const title = (await panel.locator('.session-panel-title-area').boundingBox())!
  for (const pill of [trigger, row.locator('[data-testid="leader-pill"]')]) {
    // The word, not a letter, on the line under the title.
    await expect(pill.locator('.task-pill-long')).toBeVisible()
    expect(await pill.evaluate((el) => el.scrollWidth - el.clientWidth), 'the pill shows its whole label').toBeLessThanOrEqual(1)
    expect((await pill.boundingBox())!.y, 'the label sits under the title').toBeGreaterThanOrEqual(title.y + title.height - 1)
  }
  // The kebab stays on the title's line, at its end.
  const kebab = (await row.locator('.task-kebab-btn').last().boundingBox())!
  expect(kebab.y).toBeLessThan(title.y + title.height)
  expect(kebab.x).toBeGreaterThanOrEqual(title.x + title.width - 1)
  // The title has the whole first line but the kebab.
  await expectTitleRoom(panel, 0.8)
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-narrow.png`, animations: 'disabled' })
  // Wide again: the words come back.
  await panel.evaluate((el) => { (el as HTMLElement).style.width = '700px' })
  await expect(row).not.toHaveAttribute('data-header-fit', 'tight')
  await expect(trigger.locator('.task-pill-long')).toBeVisible()
})

test('the Ask Walnut slot header shows no run status and no unknown part', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 860 })
  await openHome(page)
  const panel = await openTaskSession(page, 'pw-task-links', 'pw-links-session', 'Linked plans fixture')
  await expectNoStatus(panel)
  // Every session panel on the page, the slot's included, keeps the same row.
  const panels = page.locator('.session-panel[data-session-id]:visible')
  const n = await panels.count()
  for (let i = 0; i < n; i++) {
    const p = panels.nth(i)
    if (await p.locator('.session-panel-header-top').count() === 0) continue
    const parts = await titleRowParts(p)
    expect(parts.filter((k) => k.startsWith('UNKNOWN'))).toEqual([])
    await expect(p.locator('.session-panel-header-top .task-tag-pills')).toHaveCount(0)
    await expectNoStatus(p)
  }
})
