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
  test('real interaction earns human time for the task and the /time page shows it', async ({ page, request }) => {
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

    // The page renders the row for that task (real SPA nav via the left nav).
    await navigateVia(page, '/time')
    await expect(page.locator('.time-page')).toBeVisible({ timeout: 20_000 })
    const bar = page.locator('.time-bar-row').filter({ hasText: title })
    await expect(bar).toBeVisible({ timeout: 20_000 })
    await expect(bar.locator('.time-bar-track')).toBeVisible()
    await expect(page.locator('.time-stat', { hasText: 'Human today' })).toBeVisible()
    await shoot(page, 'time-01-page')
  })
})
