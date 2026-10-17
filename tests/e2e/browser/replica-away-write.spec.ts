/**
 * The console writes through a host replica while the Mac sleeps
 * (docs/plan/walnut-replica-servers-impl.md, WP10; rows W2, W3, W4 and W7 of
 * section 10 in a real browser). Fixture: replica-server.ts (a real Mac, a host
 * daemon twin, the replica it supervises, a fake tunnel in front of the replica);
 * config replica.config.ts, all four projects, WebKit first.
 *
 *   1. through the tunnel: sign in with a code the Mac made; the Mac made two tasks
 *      for this project and gave the Release plan Board a thread
 *   2. the Mac sleeps: the away line comes
 *   3. away, with real clicks: a rename, a new task, a complete, a post in the
 *      Board's thread; each is kept on the host (the host daemon's journal) and
 *      shows "Syncs when your Mac is back" on its row (on the Board for the post),
 *      while the replica's copy stays the Mac's (it changes only by the Mac's puts)
 *   4. the Mac wakes and drains the journal: the marks go with no reload, and the
 *      Mac's stores on disk hold each change exactly once
 *
 * The first load of the tunnel address is a `goto`: opening a link is what the
 * person does. Everything after it is a click. Screenshots:
 * /tmp/replica-plan/replica-away-write/<project>-<step>.png (1280 px wide at most).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { openListProject } from './todo-panel-helpers'

test.setTimeout(300_000)

const PORT = Number(process.env.PW_TEST_PORT ?? 3472)
const CONTROL = `http://127.0.0.1:${PORT + 1}`
const SHOTS = path.join('/tmp/replica-plan', path.basename(import.meta.filename, '.spec.ts'))
/** WALNUT_LEADER_QUIET_MS of the fixture (tests/helpers/replica-cluster.ts WINDOWS). */
const QUIET_MS = 6_000
const AWAY_SYNC = 'Syncs when your Mac is back'
/** The Release plan Board with a thread to post in (its #build line is the read spec's). */
const BOARD_HTML = '<h1>Release</h1><p id="build">Build: green</p><walnut-thread id="drill" title="Drill"></walnut-thread>'

interface Ready { ids: { board: string; other: string; macSid: string; hostSid: string } }

async function control<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(CONTROL + p, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const json = await res.json() as T
  if (!res.ok) throw new Error(`control ${method} ${p}: ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * A task row whose title is exactly `title` (the title element, not any text in the row):
 * a project list row, or a card on the pinned board (a task a person makes is pinned).
 */
const row = (page: Page, title: string) => page.locator('.todo-panel .todo-panel-item, .todo-panel .todo-pinned-card, .todo-panel .todo-focus-card')
  .filter({ has: page.locator('.todo-item-title, .todo-pinned-title', { hasText: new RegExp(`^\\s*${escapeRe(title)}\\s*$`) }) }).first()
const isPhone = () => test.info().project.name.endsWith('-phone')

/** A fresh browser shows the project folded: open it as the person does (replica-away-read.spec.ts openAcme). */
async function openAcme(page: Page): Promise<void> {
  if (!isPhone()) return openListProject(page, 'Acme')
  const header = page.locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name').filter({ hasText: /^Acme$/ }) }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  const chevron = header.locator('.collapse-chevron')
  if (!(await chevron.evaluate((el) => el.classList.contains('expanded')))) {
    await header.click()
    await expect(chevron).toHaveClass(/expanded/)
  }
}

/** Back to the task list: a phone closes its layers with Back; a desktop leaves a full-screen Board. */
async function backToTasks(page: Page): Promise<void> {
  if (!isPhone()) {
    const exit = page.getByRole('button', { name: 'Exit full screen' })
    for (let i = 0; i < 3 && (await exit.count()) > 0; i++) {
      await exit.first().click()
      await page.waitForTimeout(300)
    }
    await expect(exit).toHaveCount(0, { timeout: 15_000 })
    await expect(row(page, 'Release plan')).toBeVisible({ timeout: 15_000 })
    return
  }
  const layers = page.locator('.is-phone-layer:visible')
  for (let i = 0; i < 4 && (await layers.count()) > 0; i++) {
    const back = page.locator('.phone-topbar').getByRole('button', { name: 'Back' })
    if (await back.isVisible()) await back.click()
    else await page.goBack()
    await page.waitForTimeout(400)
  }
  await expect(layers).toHaveCount(0, { timeout: 15_000 })
  await expect(row(page, 'Release plan')).toBeVisible({ timeout: 15_000 })
}

/** Signs in through the tunnel with a code the Mac made, and opens the project. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 120_000 })
  const before = (await control<{ count: number }>('GET', '/control/devices')).count
  const { code } = await control<{ code: string }>('GET', '/control/code')
  await page.getByTestId('unpaired-code-input').fill(code)
  await page.getByTestId('unpaired-code-submit').click()
  await expect(notice).toBeHidden({ timeout: 60_000 })
  // The device round reaches the replica before the Mac sleeps (it checks this browser's token then).
  await expect.poll(async () => (await control<{ count: number }>('GET', '/control/devices')).count, { timeout: 60_000 }).toBeGreaterThan(before)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 120_000 })
  await openAcme(page)
  await expect(row(page, 'Release plan')).toBeVisible({ timeout: 60_000 })
}

/** On a phone a task is renamed and completed in its detail page, from the row's menu. */
async function openDetails(page: Page, title: string): Promise<void> {
  await row(page, title).getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-item').filter({ has: page.locator('span', { hasText: /^Details$/ }) }).first().click()
  await expect(page.locator('.phone-detail-head .phone-detail-title')).toHaveValue(title)
}

// A test that fails while the Mac sleeps must not hand the next one a sleeping Mac.
test.afterEach(async () => {
  const { asleep } = await control<{ asleep: boolean }>('GET', '/control/ready')
  if (asleep) await control('POST', '/control/wake')
  await control('POST', '/control/drain')
})

test('the console writes while the Mac sleeps: each write is kept on the host with its mark, and lands on the Mac once', async ({ page }) => {
  const project = test.info().project.name
  const { ids } = await control<Ready>('GET', '/control/ready')
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  const editTitle = `Rename me (${project})`
  const renamed = `${editTitle}, renamed away`
  const doneTitle = `Complete me (${project})`
  const madeTitle = `Made away (${project})`
  const posted = `Posted away from ${project}`
  const edit = await control<{ id: string }>('POST', '/control/mac-task', { title: editTitle, project: 'Acme' })
  const done = await control<{ id: string }>('POST', '/control/mac-task', { title: doneTitle, project: 'Acme' })
  await control('POST', '/control/mac-board', { taskId: ids.board, html: BOARD_HTML })

  await test.step('1. sign in through the tunnel; the Mac answers', async () => {
    await signIn(page)
    await expect(row(page, editTitle)).toBeVisible({ timeout: 30_000 })
    await expect(row(page, doneTitle)).toBeVisible()
    await expect(page.getByTestId('away-sync-mark')).toHaveCount(0)
    await page.evaluate(() => { (window as unknown as { __replicaMarker?: string }).__replicaMarker = 'kept' })
  })

  await test.step('2. the Mac sleeps: the away line comes', async () => {
    const slept = control('POST', '/control/sleep')
    await expect(page.getByTestId('away-line')).toBeVisible({ timeout: QUIET_MS + 5_000 })
    await slept
  })

  await test.step('3a. a rename is kept on the host and marked', async () => {
    if (isPhone()) {
      await openDetails(page, editTitle)
      const title = page.locator('.phone-detail-head .phone-detail-title')
      await title.fill(renamed)
      await title.press('Enter')
      await expect(title).toHaveValue(renamed)
      await shot(page, '1-rename-details')
      await backToTasks(page)
    } else {
      const title = row(page, editTitle).locator('.todo-item-title')
      await title.click()
      await title.click()
      const editing = page.locator('.todo-item-title.editing')
      await expect(editing).toBeVisible({ timeout: 10_000 })
      // The whole new title (End does not move the caret in a Mac WebKit field).
      await editing.fill(renamed)
      await editing.press('Enter')
    }
    await expect(row(page, renamed).getByTestId('away-sync-mark')).toHaveText(AWAY_SYNC, { timeout: 15_000 })
    await shot(page, '1-renamed')
  })

  await test.step('3b. a new task is kept on the host and marked', async () => {
    // The project's menu opens its "Add to" row (a phone's stacked list shows no such row
    // until asked, and a desktop list mounts it under the project's last task).
    const header = page.locator('.todo-group-project-header').filter({ has: page.locator('.todo-group-project-name').filter({ hasText: /^Acme$/ }) }).first()
    // Its menu button takes the pointer only while the row is hovered (home-navigation.css).
    const menu = page.locator('[data-testid="project-ctx-menu"]')
    await expect(async () => {
      await header.hover()
      await header.getByRole('button', { name: 'Acme menu' }).click({ timeout: 2_000 })
      await expect(menu.getByRole('menuitem', { name: 'New task', exact: true })).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    await menu.getByRole('menuitem', { name: 'New task', exact: true }).click()
    const input = page.locator('.focus-inline-add input').first()
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill(madeTitle)
    await input.press('Enter')
    await input.press('Escape')
    await expect(row(page, madeTitle).getByTestId('away-sync-mark')).toHaveText(AWAY_SYNC, { timeout: 15_000 })
    await shot(page, '2-made')
  })

  await test.step('3c. a complete is kept on the host and marked', async () => {
    if (isPhone()) {
      await openDetails(page, doneTitle)
      await page.getByTestId('phone-phase-row').click()
      // No session runs on this task, so there is no "its running session stops" sheet to confirm.
      await page.getByTestId('phone-phase-sheet').getByRole('option', { name: 'Complete' }).click()
      await expect(page.getByTestId('phone-phase-row')).toContainText('Complete', { timeout: 15_000 })
      await shot(page, '3-completed')
      await backToTasks(page)
    } else {
      await row(page, doneTitle).getByRole('button', { name: 'Mark complete' }).click()
      // In view for the completion's grace window, done and marked.
      await expect(row(page, doneTitle).getByTestId('away-sync-mark')).toHaveText(AWAY_SYNC, { timeout: 2_500 })
      await expect(row(page, doneTitle).getByRole('button', { name: 'Reopen (mark To Do)' })).toBeVisible()
      await shot(page, '3-completed')
    }
    await expect.poll(async () => (await control<{ records: Array<{ kind: string; acked: boolean }> }>('GET', '/control/journal')).records.filter((r) => !r.acked).length, { timeout: 15_000 }).toBe(3)
  })

  await test.step('3d. a post in a Board thread is kept on the host; the Board shows it, marked', async () => {
    await row(page, 'Release plan').locator('.todo-item-title').click()
    const panel = page.locator(`.session-panel[data-session-id="${ids.macSid}"]`).first()
    await expect(panel).toBeVisible({ timeout: 30_000 })
    if (isPhone()) {
      await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
      await page.getByTestId('phone-row-board').click()
    } else {
      await panel.getByTestId('session-board-chip').click()
    }
    const pane = page.getByTestId('task-board-pane')
    await expect(pane).toBeVisible({ timeout: 30_000 })
    const custom = pane.getByTestId('board-view-custom')
    await expect(custom).toBeVisible({ timeout: 15_000 })
    if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
    const frame = page.frameLocator('.task-board-frame')
    const thread = frame.locator('walnut-thread[id="drill"]')
    await expect(thread.locator('.wn-thread-title')).toHaveText('Drill', { timeout: 30_000 })
    await thread.locator('.wn-reply').click()
    const dockInput = pane.getByTestId('board-reply-dock').locator('.chat-input-textarea')
    await dockInput.fill(posted)
    await dockInput.press('Enter')
    const mine = thread.locator('.wn-msg').filter({ has: frame.locator('.wn-text', { hasText: posted }) })
    await expect(mine).toHaveCount(1, { timeout: 15_000 })
    await expect(mine.locator('.wn-who')).toHaveText('You')
    await expect(mine).not.toHaveClass(/wn-pending|wn-failed/, { timeout: 15_000 })
    await expect(pane.getByTestId('away-sync-mark')).toHaveText(AWAY_SYNC, { timeout: 15_000 })
    await shot(page, '4-board-post')
    await backToTasks(page)
  })

  await test.step('3e. the replica\'s copy is the Mac\'s alone: the writes are in the host\'s journal', async () => {
    const stores = await control<{ taskRows: Array<{ id: string; title: string; phase: string }> }>('GET', '/control/stores')
    expect(stores.taskRows.find((t) => t.id === edit.id)?.title).toBe(editTitle)
    expect(stores.taskRows.find((t) => t.id === done.id)?.phase).not.toBe('COMPLETE')
    expect(stores.taskRows.some((t) => t.title === madeTitle)).toBe(false)
    const { records } = await control<{ records: Array<{ kind: string; acked: boolean; fields?: string[] }> }>('GET', '/control/journal')
    // Opening a task the Mac marked unread marks it read: that is the console's own write,
    // kept like any other (it comes only when the Release plan was unread).
    const asked = records.filter((r) => !r.acked && !(r.kind === 'task-fields' && r.fields?.join(',') === 'unread'))
    expect(asked.map((r) => r.kind).sort()).toEqual(['board', 'task-create', 'task-fields', 'task-fields'])
    // Every mark is on the page still.
    await expect(row(page, renamed).getByTestId('away-sync-mark')).toBeVisible()
    await expect(row(page, madeTitle).getByTestId('away-sync-mark')).toBeVisible()
  })

  await test.step('4. the Mac wakes and drains: the marks go with no reload; the Mac holds each change once', async () => {
    await control('POST', '/control/wake')
    await expect(page.getByTestId('away-line')).toHaveCount(0, { timeout: 60_000 })
    await control('POST', '/control/drain')
    await expect(row(page, renamed)).toBeVisible({ timeout: 30_000 })
    await expect(row(page, madeTitle)).toBeVisible()
    await expect(page.getByTestId('away-sync-mark')).toHaveCount(0, { timeout: 60_000 })
    expect(await page.evaluate(() => (window as unknown as { __replicaMarker?: string }).__replicaMarker)).toBe('kept')
    await shot(page, '5-back')
    const { tasks } = await control<{ tasks: Array<{ id: string; title: string; phase: string }> }>('GET', '/control/mac-tasks')
    expect(tasks.find((t) => t.id === edit.id)?.title).toBe(renamed)
    expect(tasks.filter((t) => t.title === madeTitle)).toHaveLength(1)
    expect(tasks.find((t) => t.id === done.id)?.phase).toBe('COMPLETE')
    const board = await control<{ threads?: Record<string, Array<{ text: string; author: string }>> }>('GET', `/control/mac-board?taskId=${ids.board}`)
    expect((board.threads?.drill ?? []).filter((m) => m.text === posted)).toEqual([expect.objectContaining({ author: 'user' })])
  })

  expect(pageErrors).toEqual([])
})
