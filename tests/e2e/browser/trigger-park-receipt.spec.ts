/**
 * A session's trigger parks its task, and the user reads why in the inbox
 * (2026-10-04: a session asked the user to watch a review it could have watched
 * itself; the user asked that every trigger park the task by default, and that
 * every park write a report to the inbox saying "I put this in wait").
 *
 * The agent side is done the way an agent does it: a REAL quick-start session on
 * the fixture server (mock CLI) calls `POST /api/v1/routines/trigger` with the
 * caller-sid header the ops executor adds. Everything after that is the console:
 *
 *  1. The task leaves the default task list on its own (no reload), and the
 *     footer says a Waiting task is hidden; one click shows it with the hourglass.
 *  2. The receipt is an unread Info letter in the Inbox, subject "Waiting: <title>",
 *     whose reader shows the session's report first and then the stamped facts
 *     (what is watched, when it comes back, how to take it back), with the task
 *     as a pill.
 *
 * Serial + nonce-scoped: the fixture server and its letter store are shared.
 */
import fs from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = '/tmp/trigger-park/shots'
const NONCE = Date.now().toString(36)

test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

let fixtureRoot = ''
const litterTasks: string[] = []
const litterRoutines: string[] = []

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOTS, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all' })
  await page.setViewportSize({ width: 1280, height: 860 })
})

test.afterEach(async () => {
  for (const id of litterRoutines.splice(0)) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const id of litterTasks.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

async function taskOf(id: string): Promise<any> {
  const res = await fetch(`${API}/api/tasks/${id}`)
  return ((await res.json()) as { task: unknown }).task
}

/** A real session whose first turn has ended, and its task. */
async function startSession(request: APIRequestContext, message: string): Promise<{ sid: string; taskId: string }> {
  const res = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const body = await res.json() as { sessionId: string; taskId: string }
  litterTasks.push(body.taskId)
  await expect.poll(async () => (await taskOf(body.taskId)).phase, { timeout: 60_000 }).toBe('NEED_ACTION')
  return { sid: body.sessionId, taskId: body.taskId }
}

async function shot(target: Page | Locator, name: string, browserName: string): Promise<void> {
  await target.screenshot({ path: `${SHOTS}/${browserName}-${name}.png` })
}

test('a session\'s trigger parks its task off the list, and the receipt reads in the inbox', async ({ page, request, browserName }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const { sid, taskId } = await startSession(request, `Get PR 123 merged ${NONCE} ${browserName}`)
  // A unique title, so the inbox subject below is this run's.
  const title = `Park receipt ${NONCE} ${browserName}`
  expect((await request.patch(`/api/tasks/${taskId}`, { data: { title } })).ok()).toBeTruthy()

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const anyRow = page.locator(`[data-task-id="${taskId}"]`)
  await expect(anyRow.first()).toBeVisible({ timeout: 15_000 })

  // ── The agent arms its trigger (the default parks the task) ──
  const report = `PR 123 is pushed and CI is green (${NONCE}).\n\nWaiting for the review. When a reviewer comments I make the change; when it is approved I merge it.`
  const created = await request.post('/api/v1/routines/trigger', {
    headers: { 'x-walnut-caller-sid': sid },
    data: {
      run: 'bash ~/.open-walnut/triggers/pr-123/check.sh', every: '5m',
      prompt: 'Read the review on PR 123 and do the next step.',
      description: 'Checks PR 123 for a review every 5 minutes; the session makes the requested change or merges it.',
      wait_report: report,
    },
  })
  expect(created.status(), await created.text()).toBe(201)
  const out = await created.json() as { job: { id: string }; wait: { parked: boolean; letter_id?: string } }
  litterRoutines.push(out.job.id)
  expect(out.wait.parked).toBe(true)
  expect(out.wait.letter_id).toBeTruthy()

  // 1. It leaves the list live, and the footer says so.
  await expect(anyRow).toHaveCount(0, { timeout: 15_000 })
  const footer = page.getByTestId('todo-filter-footer')
  const waitingChip = footer.getByTestId('todo-filter-footer-waiting')
  await expect(waitingChip).toHaveText(/^\d+ Waiting hidden$/)
  // Revealing adds a Status chip, so the filter row appears above the list. A
  // list at its top stays there: the revealed card is drawn, not slid under the
  // Pinned heading (toBeVisible alone passes for a covered card).
  const scrollTop = () => page.evaluate(() => document.querySelector('.home-navigation-scroll')?.scrollTop ?? 0)
  expect(await scrollTop()).toBe(0)
  // A DOM click: Playwright's own click scrolls its target into view first.
  await waitingChip.evaluate((el) => (el as HTMLElement).click())
  await expect(anyRow.first()).toBeVisible({ timeout: 15_000 })
  await expect(anyRow.first().getByTitle('Waiting: click to complete')).toBeVisible()
  await page.waitForTimeout(500)
  expect(await scrollTop()).toBe(0)
  const onTop = await anyRow.first().evaluate((card) => {
    const r = card.getBoundingClientRect()
    return card.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  expect(onTop, 'the revealed card is covered by something').toBe(true)
  await shot(page.locator('.todo-panel'), 'list-waiting-shown', browserName)
  await waitingChip.click()
  await expect(anyRow).toHaveCount(0)

  // 2. The receipt, in the inbox.
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  const inboxRail = panel.locator('.nfc-rail-btn', { hasText: 'Inbox' })
  await inboxRail.click()
  await expect(inboxRail).toHaveAttribute('aria-current', 'true')
  const envelope = panel.locator('.hib-row').filter({ hasText: `Waiting: ${title}` })
  await expect(envelope).toBeVisible({ timeout: 15_000 })
  await expect(envelope).toHaveClass(/hib-unread/)
  await expect(envelope.locator('.hib-type')).toHaveText('Info')
  await expect(envelope.locator('.hib-preview')).toContainText(`PR 123 is pushed and CI is green (${NONCE}).`)
  await shot(envelope, 'inbox-envelope', browserName)

  await envelope.click()
  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 15_000 })
  await expect(reader.locator('.hib-reader-subject')).toHaveText(`Waiting: ${title}`)
  const body = reader.locator('.hib-md-body')
  await expect(body).toContainText(`PR 123 is pushed and CI is green (${NONCE}).`)
  await expect(body).toContainText('This task is parked: it is off your task list until something happens. Nothing is needed from you.')
  await expect(body).toContainText('Watching:')
  await expect(body).toContainText('Checks PR 123 for a review every 5 minutes; the session makes the requested change or merges it. (every 5 min)')
  await expect(body).toContainText(/Back by: .+ at the latest, even if nothing happens\./)
  await expect(body).toContainText('To take it back now: send a message in its session.')
  // The report leads, the facts follow.
  const text = (await body.textContent()) ?? ''
  expect(text.indexOf('PR 123 is pushed')).toBeLessThan(text.indexOf('This task is parked'))
  await expect(reader.locator('.hib-taskrefs')).toBeVisible()
  await shot(reader, 'inbox-reader', browserName)

  expect(pageErrors).toEqual([])
})

test('wait:false arms the trigger and leaves the task on the list, with no letter', async ({ page, request, browserName }) => {
  const { sid, taskId } = await startSession(request, `Still working ${NONCE} ${browserName}`)
  const before = await (await request.get('/api/v1/human-inbox')).json() as { letters: Array<{ taskRefs?: string[] }> }
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const anyRow = page.locator(`[data-task-id="${taskId}"]`)
  await expect(anyRow.first()).toBeVisible({ timeout: 15_000 })

  const created = await request.post('/api/v1/routines/trigger', {
    headers: { 'x-walnut-caller-sid': sid },
    data: {
      run: 'bash ~/.open-walnut/triggers/ci/check.sh', every: '5m', prompt: 'Look at the CI result.',
      description: 'Checks the CI run every 5 minutes; the session reads the result.', wait: false,
    },
  })
  expect(created.status()).toBe(201)
  const out = await created.json() as { job: { id: string }; wait: { parked: boolean; reason: string } }
  litterRoutines.push(out.job.id)
  expect(out.wait).toMatchObject({ parked: false, reason: 'wait_false' })

  // Nothing moves: give a live update time to arrive, then check.
  await page.waitForTimeout(1_500)
  await expect(anyRow.first()).toBeVisible()
  expect((await taskOf(taskId)).phase).toBe('NEED_ACTION')
  const after = await (await request.get('/api/v1/human-inbox')).json() as { letters: Array<{ taskRefs?: string[] }> }
  const refs = (l: { letters: Array<{ taskRefs?: string[] }> }) => l.letters.filter((x) => (x.taskRefs ?? []).includes(taskId)).length
  expect(refs(after)).toBe(refs(before))
})
