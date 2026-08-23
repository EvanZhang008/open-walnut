/**
 * Playwright browser tests for the two features shipped together on 2026-08-22:
 * `<suggest>` action cards in the Personal AI chat, and two-clock time tracking.
 *
 * Both are verified as a human uses them — no route mocks, no seeded localStorage,
 * no synthetic DOM events. The only stand-in is the fixture's mock main-agent CLI
 * (tests/providers/mock-main-agent.mjs), which answers a message carrying
 * `SUGGEST_CARD_FIXTURE <taskId>` with a card offering a real registry op. The
 * click, the invoke route, the op, and the persisted receipt are all real.
 *
 * Time tracking is deliberately verified through its NATURAL flush (the tracker's
 * 30s interval) rather than by faking a visibilitychange: a forged tab-hide edge
 * would pass even if the interval never fired, which is the one thing that would
 * silently lose every recorded second in production.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SHOT_DIR = '/tmp/action-cards-time'

/** Unique per run so parallel workers sharing the fixture server never collide. */
function stamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function shoot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false })
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title, source: 'local', project: 'Action Card Spec' },
  })
  expect(res.status()).toBe(201)
  const body = await res.json() as { task: { id: string } }
  return body.task.id
}

async function pinnedIds(request: APIRequestContext): Promise<string[]> {
  const res = await request.get('/api/v1/focus/tasks')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { pinned_tasks?: string[] }
  return body.pinned_tasks ?? []
}

interface TaskDayTime { taskId: string; humanMs: number; agentMs: number }
interface TimeSummary { days: Array<{ date: string; tasks: TaskDayTime[] }>; today: string }

async function humanMsFor(request: APIRequestContext, taskId: string): Promise<number> {
  const res = await request.get('/api/time/summary', { params: { days: 1 } })
  expect(res.ok()).toBe(true)
  const body = await res.json() as TimeSummary
  const today = body.days.find((d) => d.date === body.today)
  return today?.tasks.find((t) => t.taskId === taskId)?.humanMs ?? 0
}

/** Sidebar nav is the only SPA navigation used here — never page.goto. */
async function navigateVia(page: Page, href: string): Promise<void> {
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
  }
  await page.locator(`.sidebar-nav a[href="${href}"]`).click()
}

/**
 * The Time panel is a Settings section, not a left-nav page: reach it the way a
 * person does — sidebar → Settings → the "Time Tracking" nav entry, which scrolls
 * the section into view. Two real clicks, no page.goto.
 */
async function openTimeSection(page: Page): Promise<void> {
  await navigateVia(page, '/settings')
  const navEntry = page.locator('[data-testid="settings-nav-time"]')
  await expect(navEntry).toBeVisible({ timeout: 20_000 })
  await navEntry.click()
}

test.describe('suggest action cards', () => {
  test('card renders, its button runs the real op, and the receipt survives a reload', async ({ page, request }) => {
    test.setTimeout(120_000)

    const taskId = await createTask(request, `Action card fixture ${stamp()}`)
    // The op has not run yet — otherwise "it worked" would prove nothing.
    expect(await pinnedIds(request)).not.toContain(taskId)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const composer = page.locator('.main-page-chat .chat-input-textarea')
    await expect(composer).toBeVisible({ timeout: 20_000 })
    await composer.click()
    await composer.fill(`SUGGEST_CARD_FIXTURE ${taskId}`)
    await composer.press('Enter')

    const card = page.locator('.main-page-chat .sug-card').filter({ hasText: 'Pin this task' }).first()
    await expect(card).toBeVisible({ timeout: 45_000 })
    // Prose around the card still renders as prose (the card is a sibling run).
    await expect(page.locator('.main-page-chat')).toContainText('That task is not pinned yet.')

    const pinBtn = card.locator('button.sug-btn', { hasText: 'Pin it' })
    const dismissBtn = card.locator('button.sug-btn', { hasText: 'Not now' })
    await expect(pinBtn).toBeEnabled()
    await expect(dismissBtn).toBeVisible()
    await shoot(page, 'cards-01-rendered')

    await pinBtn.click()

    // The op ACTUALLY ran: the task is pinned server-side.
    await expect.poll(async () => (await pinnedIds(request)).includes(taskId), {
      timeout: 30_000,
      intervals: [500, 500, 1000],
      message: 'task_pin_set should have pinned the task through /api/v1/actions/invoke',
    }).toBe(true)

    // Applied state: a receipt, not a re-armed button, and a settled card.
    const receipt = card.locator('.sug-receipt-done')
    await expect(receipt).toBeVisible({ timeout: 15_000 })
    await expect(receipt).toContainText('Pin it')
    await expect(card).toHaveClass(/sug-card-settled/)
    await shoot(page, 'cards-02-applied')

    // Reload: the card comes back from chat history (the legacy no-blocks render
    // path) and the receipt is read from persisted state, not re-armed.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const reloaded = page.locator('.main-page-chat .sug-card').filter({ hasText: 'Pin this task' }).first()
    await expect(reloaded).toBeVisible({ timeout: 45_000 })
    await expect(reloaded.locator('.sug-receipt-done')).toContainText('Pin it', { timeout: 15_000 })
    await expect(reloaded.locator('button.sug-btn', { hasText: 'Pin it' })).toHaveCount(0)
    await shoot(page, 'cards-03-after-reload')
  })
})

test.describe('time tracking', () => {
  test('real interaction earns human time for the task and the Time settings section shows it', async ({ page, request }) => {
    // The tracker flushes on its own 30s interval; the poll below waits for a
    // real one rather than forging the edge that would make it flush early.
    test.setTimeout(180_000)

    const token = stamp()
    const title = `Time tracking fixture ${token}`
    const taskId = await createTask(request, title)
    expect(await humanMsFor(request, taskId)).toBe(0)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const panel = page.locator('.todo-panel')
    await expect(panel).toBeVisible({ timeout: 20_000 })

    // TYPE — real keystrokes into the panel's search box, which also filters the
    // panel down to this one task. That matters: a wheel that lands on a
    // NEIGHBOURING row would silently bill that task instead, and the summary
    // assertion below would read as "time tracking is broken".
    const search = panel.locator('.todo-search-input')
    await expect(search).toBeVisible({ timeout: 20_000 })
    await search.click()
    await search.pressSequentially(token, { delay: 60 })

    const row = panel.locator(`div[data-task-id="${taskId}"]`).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(async () => [...new Set(await panel.locator('div[data-task-id]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id'))))], { timeout: 15_000 })
      .toEqual([taskId])

    // SCROLL over that row: a real wheel input, and the only interaction with no
    // side effect on the task. hover() hit-tests, so a covered row fails loudly
    // instead of quietly attributing the signal somewhere else. Three wheels over
    // ~4s puts the banked window well above the tracker's 250ms noise floor.
    for (let i = 0; i < 3; i++) {
      await row.hover()
      await page.mouse.wheel(0, 10)
      await page.waitForTimeout(1_400)
    }

    // Wait for a NATURAL flush (30s interval, +margin for a loaded machine).
    await expect.poll(() => humanMsFor(request, taskId), {
      timeout: 90_000,
      intervals: [2_000],
      message: 'the 30s heartbeat flush should have recorded human time for the task',
    }).toBeGreaterThan(0)

    // The Settings section renders the row for that task (real SPA nav: sidebar →
    // Settings → the Time Tracking entry).
    await openTimeSection(page)
    const timePanel = page.locator('#time.time-page')
    await expect(timePanel).toBeVisible({ timeout: 20_000 })
    await timePanel.scrollIntoViewIfNeeded()

    // ── Tab 1: My time. Human time ONLY — an agent number in this view is the
    // bug the two-tab split exists to prevent (a user read 8h57m of agent time
    // as their own working day).
    const mine = timePanel.locator('[data-testid="time-view-mine"]')
    await expect(mine).toBeVisible({ timeout: 20_000 })
    await expect(timePanel.locator('[data-testid="time-tab-mine"]')).toHaveClass(/active/)
    await expect(mine.locator('.time-bar-value-agent')).toHaveCount(0)
    await expect(mine.locator('.time-stat', { hasText: 'Focus share' })).toBeVisible()

    // The task is not pinned, so it belongs to the "Other" group, with real minutes.
    const otherGroup = mine.locator('[data-testid="time-group-other"]')
    const timeRow = otherGroup.locator('.time-bar-row').filter({ hasText: title })
    await expect(timeRow).toBeVisible({ timeout: 20_000 })
    // A few seconds of wheeling must read as seconds, never as a rounded "0m"
    // (which reads as "nothing recorded" — the same wrong-data reaction).
    await expect(timeRow.locator('.time-bar-value-human')).toHaveText(/^[1-9]\d*(s|m)$|^\d+h/)
    await shoot(page, 'time-01-my-time')

    // ── A filter interaction, clicked for real. The wheel over a task row earns
    // TRIAGE time, so the triage filter keeps the row and the chat filter drops it.
    await timePanel.locator('[data-testid="time-kind-triage"]').click()
    await expect(timeRow).toBeVisible()
    await timePanel.locator('[data-testid="time-kind-chat"]').click()
    await expect(mine.locator('.time-bar-row').filter({ hasText: title })).toHaveCount(0)
    await timePanel.locator('[data-testid="time-kind-all"]').click()
    await expect(timeRow).toBeVisible()

    // …and the range filter: nothing was earned yesterday.
    await timePanel.locator('[data-testid="time-range-yesterday"]').click()
    await expect(mine.locator('.time-bar-row').filter({ hasText: title })).toHaveCount(0)
    await timePanel.locator('[data-testid="time-range-today"]').click()
    await expect(timeRow).toBeVisible()

    // ── Tab 2: Agents. Agent runtime only, with the parallel-runs caption and
    // never a human number.
    await timePanel.locator('[data-testid="time-tab-agents"]').click()
    const agents = timePanel.locator('[data-testid="time-view-agents"]')
    await expect(agents).toBeVisible({ timeout: 20_000 })
    await expect(mine).toHaveCount(0)
    await expect(agents.locator('[data-testid="time-agent-caption"]'))
      .toContainText('agents can run in parallel')
    await expect(agents.locator('.time-bar-value-human')).toHaveCount(0)
    await expect(agents.locator('.time-stat', { hasText: 'Agent runtime' })).toBeVisible()
    await timePanel.scrollIntoViewIfNeeded()
    await shoot(page, 'time-02-agents')

    // Back to My time — the tab state is real, not a one-way trip.
    await timePanel.locator('[data-testid="time-tab-mine"]').click()
    await expect(mine).toBeVisible()
    await expect(timeRow).toBeVisible()
  })
})

// ── The Timeline tab: the day as blocks, human and agent in separate lanes ──

/** Total wall span of the seeded windows. Wide enough to draw a labelled block. */
const SEED_SPAN_MS = 40 * 60_000
/** One heartbeat sample can carry at most ten minutes (the server clamps). */
const SEED_SAMPLE_MS = 10 * 60_000

function localDate(ms: number): string {
  const d = new Date(ms)
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
}

/**
 * Where to seed the day being drawn.
 *
 * Two constraints collide: every window must land inside ONE local day (blocks
 * clip at midnight) and none may be in the future (the server rejects those).
 * Within the first 40 minutes after local midnight neither holds for a 40-minute
 * span on today, so seed yesterday afternoon and let the test walk one day back.
 */
function seedAnchor(): { startMs: number; date: string } {
  const now = Date.now()
  const start = now - SEED_SPAN_MS
  if (localDate(start) === localDate(now)) return { startMs: start, date: localDate(now) }
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const yesterdayAfternoon = midnight.getTime() - 8 * 60 * 60_000
  return { startMs: yesterdayAfternoon, date: localDate(yesterdayAfternoon) }
}

interface Block { taskId: string; kind: string; ms: number }

/**
 * Wait for the shell, not for the network to go quiet.
 *
 * `networkidle` needs 500ms with nothing in flight; on a loaded machine this app
 * never gets there inside a test budget (it polls status routes on mount), and the
 * first run of this test burned its whole timeout on the wait after a reload. The
 * sidebar being visible is the real precondition for every click that follows.
 */
async function appReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 90_000 })
}

async function blocksFor(request: APIRequestContext, date: string, taskId: string): Promise<Block[]> {
  const res = await request.get('/api/time/blocks', { params: { date } })
  expect(res.ok()).toBe(true)
  const body = await res.json() as { blocks: Block[] }
  return body.blocks.filter((b) => b.taskId === taskId)
}

/**
 * Append ONE agent interval to the fixture server's own day file.
 *
 * Agent time is derived from a real `session:result` bus event, which needs a
 * live CLI turn this fixture has no session for — so the record is written where
 * the store keeps it, and the route reads it back through its normal path. The
 * dir is found by CONTENT (the run's unique task id), so a leftover fixture dir
 * from another run can never be picked by mistake.
 */
async function seedAgentInterval(date: string, startMs: number, taskId: string, durationMs: number): Promise<boolean> {
  const base = os.tmpdir()
  const dirs = (await fs.readdir(base).catch(() => [] as string[])).filter((d) => d.startsWith('walnut-pw-'))
  for (const dir of dirs) {
    const file = path.join(base, dir, 'time-tracking', `${date}.jsonl`)
    const text = await fs.readFile(file, 'utf-8').catch(() => '')
    if (!text.includes(taskId)) continue
    const rec = {
      date,
      ts: new Date(startMs).toISOString(),
      durationMs,
      kind: 'agent',
      taskId,
      sessionId: `sess-timeline-${taskId}`,
    }
    await fs.appendFile(file, `${JSON.stringify(rec)}\n`, 'utf-8')
    return true
  }
  return false
}

test.describe('time timeline', () => {
  test('plots the day as blocks, keeps agents in their own lane, and remembers the toggle', async ({ page, request }) => {
    // Long on purpose: this is one whole user journey (seed → plot → toggle →
    // reload → empty day → today → dark theme) and every step is a real click.
    test.setTimeout(420_000)

    const token = stamp()
    const title = `Timeline fixture ${token}`
    const taskId = await createTask(request, title)
    const anchor = seedAnchor()

    // Seed HUMAN time through the real route: four adjacent ten-minute windows,
    // which the server folds into ONE forty-minute block.
    const samples = Array.from({ length: SEED_SPAN_MS / SEED_SAMPLE_MS }, (_, i) => ({
      ts: new Date(anchor.startMs + i * SEED_SAMPLE_MS).toISOString(),
      durationMs: SEED_SAMPLE_MS,
      kind: 'session',
      taskId,
    }))
    const posted = await request.post('/api/time/heartbeats', { data: { samples } })
    expect(posted.status()).toBe(204)

    // The fold really produced one block before the UI is touched at all.
    await expect.poll(async () => (await blocksFor(request, anchor.date, taskId)).map((b) => b.ms), {
      timeout: 30_000,
      intervals: [500, 500, 1_000],
      message: 'four adjacent windows should fold into one 40-minute block',
    }).toEqual([SEED_SPAN_MS])

    const agentSeeded = await seedAgentInterval(anchor.date, anchor.startMs, taskId, 25 * 60_000)
    expect(agentSeeded, 'the fixture day file should have been found by task id — check the walnut-pw tmp layout').toBe(true)

    await page.goto('/')
    await appReady(page)
    await openTimeSection(page)
    const panel = page.locator('#time.time-page')
    await expect(panel).toBeVisible({ timeout: 20_000 })

    await panel.locator('[data-testid="time-tab-timeline"]').click()
    const tl = panel.locator('[data-testid="time-view-timeline"]')
    await expect(tl).toBeVisible({ timeout: 20_000 })
    if (anchor.date !== localDate(Date.now())) {
      await tl.locator('[data-testid="time-timeline-prev"]').click()
    }

    // The toggle is persisted (ui-prefs mirrors it server-side), so a rerun of
    // this spec against the same fixture server would inherit the ON state.
    // Put it back to its documented default before asserting the default.
    const agentsToggle = tl.locator('[data-testid="time-timeline-agents-toggle"]')
    if (await agentsToggle.isChecked()) await agentsToggle.uncheck()
    await expect(agentsToggle).not.toBeChecked()

    // ── A block, in the human lane, labelled with the task's own title.
    const humanLane = tl.locator('[data-testid="time-timeline-lane-human"]')
    const block = humanLane.locator(`.tt-block[data-time-task-id="${taskId}"]`)
    await expect(block).toHaveCount(1, { timeout: 20_000 })
    await expect(block).toHaveAttribute('data-time-kind', 'session')
    await expect(block).toContainText(title)
    // The legend decodes the colors without hovering anything.
    await expect(tl.locator('[data-testid="time-timeline-legend"]')).toContainText(title)
    // Agents OFF: no second lane, and no agent rectangle anywhere on the page.
    await expect(tl.locator('[data-testid="time-timeline-lane-agent"]')).toHaveCount(0)
    await expect(tl.locator('.tt-block[data-time-kind="agent"]')).toHaveCount(0)
    await expect(tl.locator('[data-testid="time-timeline-agent-total"]')).toHaveCount(0)

    // Hover reads out the task, the clock range, the duration and the kind.
    await block.hover()
    const detail = tl.locator('[data-testid="time-timeline-detail"]')
    await expect(detail).toContainText(title)
    await expect(detail).toContainText('40m')
    await expect(detail).toContainText('Session')
    await expect(detail).toContainText(/\d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M/)
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'timeline-01-day-with-data')

    // ── Agents ON: a SEPARATE lane. Never the same lane, never the same block.
    // Assertions are scoped to THIS run's task id: other tests in the same fixture
    // server earn their own time on the same day, and a bare count would then be a
    // test that fails for reasons the feature has nothing to do with.
    await agentsToggle.check()
    const agentLane = tl.locator('[data-testid="time-timeline-lane-agent"]')
    await expect(agentLane).toBeVisible()
    const agentBlock = agentLane.locator(`.tt-block[data-time-kind="agent"][data-time-task-id="${taskId}"]`)
    await expect(agentBlock).toHaveCount(1)
    await expect(agentLane.locator(`.tt-block[data-time-kind="session"]`)).toHaveCount(0)
    await expect(humanLane.locator('.tt-block[data-time-kind="agent"]')).toHaveCount(0)
    // The human block did not move, change lane, or absorb the agent's 25 minutes.
    await expect(block).toHaveCount(1)
    await expect(tl.locator('[data-testid="time-timeline-human-total"]')).toBeVisible()
    await expect(tl.locator('[data-testid="time-timeline-agent-total"]')).toBeVisible()
    // The agent's own turn reads as 25 minutes of AGENT time, never as yours.
    await agentBlock.hover()
    await expect(detail).toContainText('25m')
    await expect(detail).toContainText('Agent')
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'timeline-02-agents-on')

    // ── The choice survives a reload (a preference, not a session toggle).
    await page.reload()
    await appReady(page)
    await openTimeSection(page)
    await panel.locator('[data-testid="time-tab-timeline"]').click()
    await expect(tl).toBeVisible({ timeout: 20_000 })
    await expect(tl.locator('[data-testid="time-timeline-agents-toggle"]')).toBeChecked()

    // ── A day with nothing on it explains itself instead of drawing an empty grid.
    const empty = tl.locator('[data-testid="time-timeline-empty"]')
    for (let i = 0; i < 4 && (await empty.count()) === 0; i++) {
      await tl.locator('[data-testid="time-timeline-prev"]').click()
      await page.waitForTimeout(400)
    }
    await expect(empty).toBeVisible({ timeout: 20_000 })
    await expect(empty).toContainText('Nothing tracked')
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'timeline-03-empty-day')

    // ── "Today" comes back to the day with the work on it.
    await tl.locator('[data-testid="time-timeline-today"]').click()
    if (anchor.date !== localDate(Date.now())) {
      await tl.locator('[data-testid="time-timeline-prev"]').click()
    }
    await expect(block).toHaveCount(1, { timeout: 20_000 })

    // ── Dark theme, through the real theme picker.
    await page.locator('#general .theme-picker-btn', { hasText: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await panel.scrollIntoViewIfNeeded()
    await expect(block).toBeVisible()
    await shoot(page, 'timeline-04-dark')
    await page.locator('#general .theme-picker-btn', { hasText: 'System' }).click()

    // Leave the persisted preference at its default for the next run.
    await panel.locator('[data-testid="time-tab-timeline"]').click()
    const finalToggle = tl.locator('[data-testid="time-timeline-agents-toggle"]')
    if (await finalToggle.isChecked()) await finalToggle.uncheck()
  })
})
