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
function seedAnchor(spanMs: number = SEED_SPAN_MS): { startMs: number; date: string } {
  const now = Date.now()
  const start = now - spanMs
  if (localDate(start) === localDate(now)) return { startMs: start, date: localDate(now) }
  // 16:00 yesterday: comfortably inside the day for any span this suite uses.
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
  test('plots the day as one serial ribbon, ranks where it went, and remembers the view', async ({ page, request }) => {
    // Long on purpose: one whole user journey (seed → ribbon → ranking → reload →
    // empty day → today → dark) and every step is a real click.
    test.setTimeout(420_000)

    const token = stamp()
    const title = `Timeline fixture ${token}`
    const taskId = await createTask(request, title)
    const anchor = seedAnchor()

    // Seed HUMAN time through the real route: four adjacent ten-minute windows,
    // which the SERIAL fold joins into one 40-minute segment.
    const samples = Array.from({ length: SEED_SPAN_MS / SEED_SAMPLE_MS }, (_, i) => ({
      ts: new Date(anchor.startMs + i * SEED_SAMPLE_MS).toISOString(),
      durationMs: SEED_SAMPLE_MS,
      kind: 'session',
      taskId,
    }))
    const posted = await request.post('/api/time/heartbeats', { data: { samples } })
    expect(posted.status()).toBe(204)

    await expect.poll(async () => (await blocksFor(request, anchor.date, taskId)).map((b) => b.ms), {
      timeout: 30_000,
      intervals: [500, 500, 1_000],
      message: 'the seeded windows should fold into one 40-minute block',
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

    // ── The tape is the default view: ONE ribbon, our segment labelled in it.
    const seg = tl.locator(`[data-testid="time-tape-seg"][data-time-task-id="${taskId}"]`)
    await expect(seg).toHaveCount(1, { timeout: 20_000 })
    await expect(seg).toContainText(title)
    await expect(tl.locator('[data-testid="time-timeline-human-total"]')).toContainText('40m')

    // ── The ranked list is the tape's key, and hovering it lights the segment.
    const rank = tl.locator('[data-testid="time-tape-rank"]')
    const ourRow = rank.locator(`[data-testid="time-tape-rrow"][data-time-task-id="${taskId}"]`)
    await expect(ourRow).toContainText(title)
    await ourRow.hover()
    await expect(seg).toHaveClass(/is-lit/)

    // ── AGENTS ARE NOT IN THE TAPE AT ALL. The toggle does not even exist here:
    // this view is about a person's attention, and 25 agent minutes in it would
    // be read as the user's own time (that misreading is why this rule exists).
    await expect(tl.locator('[data-testid="time-timeline-agents-toggle"]')).toHaveCount(0)
    await expect(tl.locator(`[data-testid="time-tape-seg"][data-time-task-id="${taskId}"]`)).toHaveCount(1)

    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'timeline-01-tape')

    // ── The chosen view survives a reload (ui-prefs mirrors the key).
    await tl.locator('[data-testid="time-view-lanes"]').click()
    await expect(tl.locator('[data-testid="time-lanes"]')).toBeVisible()
    await page.reload()
    await appReady(page)
    await openTimeSection(page)
    await panel.locator('[data-testid="time-tab-timeline"]').click()
    await expect(tl.locator('[data-testid="time-lanes"]')).toBeVisible({ timeout: 20_000 })
    await tl.locator('[data-testid="time-view-tape"]').click()
    await expect(tl.locator('[data-testid="time-tape"]')).toBeVisible()

    // ── Walk back to a day with nothing on it: an explanation, not an empty box.
    const empty = tl.locator('[data-testid="time-timeline-empty"]')
    for (let i = 0; i < 6; i += 1) {
      if (await empty.isVisible().catch(() => false)) break
      const prev = tl.locator('[data-testid="time-timeline-prev"]')
      if (await prev.isDisabled()) break
      await prev.click()
      await page.waitForTimeout(400)
    }
    await expect(empty).toBeVisible({ timeout: 20_000 })
    await shoot(page, 'timeline-02-empty-day')

    // Today snaps back.
    await tl.locator('[data-testid="time-timeline-today"]').click()
    await expect(tl.locator('[data-testid="time-timeline-date"]')).toContainText('today')
  })
})

/**
 * ── The dense day: 19 tasks, mixed 22s-25m slices, long mixed-script titles,
 * overlapping bursts, and one REAL idle gap so the day has more than one chapter.
 *
 * Two constraints on WHERE this day sits, both learned the hard way:
 *
 * 1. It must stay in the past — a sample in the future is silently rejected by the
 *    sanitizer, and an earlier version of this test quietly lost five of its tasks.
 * 2. It must not overlap the journey test above, which seeds the last 40 minutes of
 *    the same day. Both tests share one fixture server and one day file, and in a
 *    SERIAL fold an overlapping block legitimately swallows whatever is inside it —
 *    which silently ate this test's whole second chapter.
 *
 * So: 160 minutes back, with every sample inside the first 95 of them.
 */
const DENSE_SPAN_MS = 160 * 60_000

const DENSE_TASKS: Array<{ title: string; slices: Array<[offsetMin: number, seconds: number]> }> = [
  { title: '重构会话时间轴渲染管线 — timeline rendering pipeline refactor', slices: [[0, 1500], [30, 900]] },
  { title: 'Investigate flaky provider reconnect under load 排查重连抖动', slices: [[6, 1200]] },
  { title: '写周报与季度目标对齐文档 quarterly planning writeup', slices: [[26, 780]] },
  { title: 'Review pull request for the search indexing worker', slices: [[14, 420]] },
  { title: '修复移动端消息回执丢失的问题 mobile receipt loss', slices: [[20, 300]] },
  { title: 'Pair on the daemon capability gate 与队友结对', slices: [[44, 260]] },
  { title: 'Triage inbox and reschedule blocked items 收件箱清理', slices: [[10, 150]] },
  { title: 'Answer questions in the release thread 回复发布讨论', slices: [[13, 200]] },
  { title: 'Check overnight cron output 检查夜间任务输出', slices: [[16, 190]] },
  { title: 'Update the onboarding checklist for new hosts', slices: [[18, 175]] },
  { title: 'Skim the incident report from yesterday 事故回顾', slices: [[22, 165]] },
  { title: 'Reply to the design review comment 设计评审回复', slices: [[24, 48]] },
  { title: 'Rename a project and fix its stale references', slices: [[34, 44]] },
  { title: 'Look at the cache hit-rate panel 缓存命中率', slices: [[36, 40]] },
  { title: 'Bump a dependency and read its changelog', slices: [[38, 36]] },
  { title: 'File a follow-up task for the parser edge case', slices: [[40, 33]] },
  { title: 'Glance at the notification centre 通知中心', slices: [[42, 31]] },
  { title: 'Confirm the backup finished 确认备份完成', slices: [[46, 30]] },
  // After a 17-minute break: the second chapter of the day.
  { title: '深度调试守护进程重连 deep debugging session', slices: [[66, 360], [74, 540]] },
]

test.describe('time timeline at real density', () => {
  test('all three views hold up on a 19-task day: serial tape, chaptered story, capped lanes', async ({ page, request }) => {
    test.setTimeout(480_000)

    const token = stamp()
    const anchor = seedAnchor(DENSE_SPAN_MS)
    const ids: string[] = []
    const samples: Array<Record<string, unknown>> = []
    for (const [i, spec] of DENSE_TASKS.entries()) {
      const taskId = await createTask(request, `${spec.title} ${token}`)
      ids.push(taskId)
      for (const [offsetMin, seconds] of spec.slices) {
        // Bursts overlap on purpose (offsets collide across tasks). The serial fold
        // has to RESOLVE that rather than draw two things at once.
        samples.push({
          ts: new Date(anchor.startMs + offsetMin * 60_000 + (i % 3) * 20_000).toISOString(),
          durationMs: seconds * 1000,
          kind: i % 4 === 0 ? 'session' : i % 4 === 1 ? 'triage' : 'chat',
          taskId,
        })
      }
    }
    // A late burst of touches UNDER the 30s draw floor — one per task so none of
    // them merges into anything — which is what the user's real day was mostly made
    // of, and what the "not drawn" note has to account for.
    for (let i = 0; i < 10; i++) {
      samples.push({
        ts: new Date(anchor.startMs + (84 + i) * 60_000).toISOString(),
        durationMs: 22_000,
        kind: 'chat',
        taskId: ids[i + 2],
      })
    }

    const posted = await request.post('/api/time/heartbeats', { data: { samples } })
    expect(posted.status()).toBe(204)

    // One long agent run across the same day, so the swimlanes' agent row really has
    // hatched bars to draw rather than just existing.
    const agentSeeded = await seedAgentInterval(anchor.date, anchor.startMs + 5 * 60_000, ids[0]!, 55 * 60_000)
    expect(agentSeeded, 'the dense fixture day file should have been found by task id').toBe(true)

    // The ribbon endpoint is the one both vertical views read.
    await expect.poll(async () => (await request.get('/api/time/blocks', {
      params: { date: anchor.date, raw: '1', kinds: 'session,triage,chat' },
    }).then((r) => r.json() as Promise<{ blocks: unknown[] }>)).blocks.length, {
      timeout: 30_000,
      intervals: [500, 500, 1_000],
      message: 'the dense day should fold into a ribbon of many segments',
    }).toBeGreaterThan(5)

    await page.goto('/')
    await appReady(page)
    await openTimeSection(page)
    const panel = page.locator('#time.time-page')
    await panel.locator('[data-testid="time-tab-timeline"]').click()
    const tl = panel.locator('[data-testid="time-view-timeline"]')
    await expect(tl).toBeVisible({ timeout: 20_000 })
    if (anchor.date !== localDate(Date.now())) {
      await tl.locator('[data-testid="time-timeline-prev"]').click()
    }
    await tl.locator('[data-testid="time-view-tape"]').click()

    // ══ VIEW A: the tape ══
    const segs = tl.locator('[data-testid="time-tape-seg"]')
    await expect.poll(() => segs.count(), { timeout: 20_000 }).toBeGreaterThan(4)

    // THE rule this whole redesign exists for: attention is serial, so no two
    // segments may occupy the same pixels. (A 2px tolerance is the drawn floor for
    // a 30-second stripe, which is the only overdraw the layout allows.)
    const boxes = await segs.evaluateAll((els) => els.map((el) => {
      const s = el as HTMLElement
      return { top: s.offsetTop, height: s.offsetHeight }
    }))
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1]!
      expect(boxes[i]!.top, 'serial ribbon: segments must never overlap').toBeGreaterThanOrEqual(prev.top + prev.height - 2)
    }
    // Big stretches carry their name; nothing carries text it cannot hold.
    const labelled = await segs.evaluateAll((els) => els.filter((el) => !!el.querySelector('.tp-seg-title')).length)
    expect(labelled).toBeGreaterThan(0)
    const overflowing = await segs.evaluateAll((els) => els.filter((el) => el.scrollHeight > el.clientHeight + 1).length)
    expect(overflowing).toBe(0)

    // The ranked list is capped, one line per row, with the quick-touch group.
    const rank = tl.locator('[data-testid="time-tape-rank"]')
    const rows = rank.locator('[data-testid="time-tape-rrow"]')
    expect(await rows.count()).toBeLessThanOrEqual(9)
    // "One line" measured as a WRAP, not as a magic pixel count: a wrapped row is
    // ~1.6x its neighbours, which is what a long mixed-script title would cause.
    const rowHeights = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetHeight))
    expect(Math.max(...rowHeights)).toBeLessThan(Math.min(...rowHeights) * 1.4)
    expect(Math.max(...rowHeights), 'a ranked row is one line of 13px type').toBeLessThanOrEqual(34)
    await expect(rank.locator('[data-testid="time-tape-quick"]')).toContainText('Quick touches')
    await expect(rank.locator('[data-testid="time-tape-more"]')).toContainText('more')
    await expect(tl.locator('[data-testid="time-timeline-notdrawn"]')).toContainText('under 30s')

    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'views-01-tape-dense')

    // ══ VIEW B: chapters ══
    await tl.locator('[data-testid="time-view-chapters"]').click()
    const cards = tl.locator('[data-testid="time-chapters-card"]')
    await expect.poll(() => cards.count(), { timeout: 20_000 }).toBeGreaterThan(1)
    // The 17-minute break really is drawn as a break in the story.
    await expect(tl.locator('[data-testid="time-chapters-idle"]').first()).toContainText('空闲')
    await expect(cards.first().locator('[data-testid="time-chapters-comp"]')).toBeVisible()
    // A composition bar accounts for the whole chapter, so it has real segments.
    const compParts = await cards.first().locator('[data-testid="time-chapters-comp"] i').count()
    expect(compParts).toBeGreaterThan(1)
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'views-02-chapters-dense')

    // Expanding a chapter reveals the same ribbon, zoomed, for just that stretch.
    await cards.first().locator('.tc-head').click()
    const detail = tl.locator('[data-testid="time-chapters-detail"]')
    await expect(detail).toBeVisible()
    expect(await detail.locator('[data-testid="time-tape-seg"]').count()).toBeGreaterThan(0)
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'views-03-chapters-expanded')

    // ══ VIEW C: swimlanes ══
    await tl.locator('[data-testid="time-view-lanes"]').click()
    const taskRows = tl.locator('[data-testid="time-lanes-row-task"]')
    await expect.poll(() => taskRows.count(), { timeout: 20_000 }).toBeGreaterThan(3)
    // Rows are ranked, so the top row is the day's biggest task — asked of the API
    // rather than assumed, because the journey test above shares this day file.
    const ribbon = await request.get('/api/time/blocks', {
      params: { date: anchor.date, raw: '1', kinds: 'session,triage,chat' },
    }).then((r) => r.json() as Promise<{ totals: Array<{ taskId: string; ms: number }>; titles: Record<string, string> }>)
    const biggest = ribbon.titles[ribbon.totals[0]!.taskId]
    expect(biggest, 'the top-ranked task should have a joined title').toBeTruthy()
    await expect(taskRows.first().locator('.tl-nm')).toHaveText(biggest!)
    // …and capped: the tail is ONE aggregated row, never twelve rows of one bar.
    expect(await taskRows.count()).toBeLessThanOrEqual(6)
    const others = tl.locator('[data-testid="time-lanes-row-others"]')
    await expect(others.locator('.tl-nm')).toContainText('其他')
    // Every bar is visible, and no bar carries text (titles live in the column).
    const barWidths = await tl.locator('[data-testid="time-lanes-bar"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).offsetWidth))
    expect(Math.min(...barWidths)).toBeGreaterThanOrEqual(4)
    const barText = await tl.locator('[data-testid="time-lanes-bar"]')
      .evaluateAll((els) => els.filter((e) => (e.textContent ?? '').trim().length > 0).length)
    expect(barText).toBe(0)

    // The agent row exists ONLY with the toggle, and only in this view.
    const agentsToggle = tl.locator('[data-testid="time-timeline-agents-toggle"]')
    await expect(tl.locator('[data-testid="time-lanes-row-agent"]')).toHaveCount(0)
    await agentsToggle.check()
    const agentRow = tl.locator('[data-testid="time-lanes-row-agent"]')
    await expect(agentRow).toBeVisible()
    // Hatched purple, in its own row: never a bar in a task's row.
    expect(await agentRow.locator('[data-testid="time-lanes-bar"]').count()).toBeGreaterThan(0)
    // Non-zero, not an exact figure: the journey test's own agent interval is on
    // this same day, and asserting "55m" would be asserting test isolation we
    // deliberately do not have here.
    await expect(tl.locator('[data-testid="time-timeline-agent-total"]')).not.toContainText('0s')
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'views-04-lanes-dense')
    await agentsToggle.uncheck()
    await expect(tl.locator('[data-testid="time-lanes-row-agent"]')).toHaveCount(0)
    await shoot(page, 'views-05-lanes-no-agents')

    // ══ Dense + dark, on the view the user will live in ══
    await tl.locator('[data-testid="time-view-tape"]').click()
    await page.locator('#general .theme-picker-btn', { hasText: 'Dark' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await panel.locator('[data-testid="time-tab-timeline"]').click()
    await expect(tl.locator('[data-testid="time-tape"]')).toBeVisible()
    await panel.scrollIntoViewIfNeeded()
    await shoot(page, 'views-06-tape-dark')
    await page.locator('#general .theme-picker-btn', { hasText: 'System' }).click()
  })
})
