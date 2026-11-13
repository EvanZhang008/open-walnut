/**
 * A routine run that did not happen, on the Routines page (src/core/cron/run-log.ts, RoutineCard).
 *
 * 2026-11-08: the daily org reflection did not run and no surface said so. Its card now names the
 * missed run and why, runs it now for that time (the row leaves), sets one aside (Dismiss), and
 * opens its run history. The Mac app is a WKWebView: run it in WebKit too
 * (PW_WEBKIT=1 ... --project webkit).
 */
import fs from 'node:fs/promises'
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { openRoutineRow } from './routines-page-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = `${process.env.WALNUT_TASK_DIR || '/tmp'}/shots/routine-missed-runs`
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NO_ROOM = 'Not started: this Mac had no room for 1 minute (4 of 4 starts running).'

test.describe.configure({ timeout: 180_000 })

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, animations: 'disabled' })
}

/**
 * The daily slot's hour: twelve hours from now, so no slot is near the run. A fixed 08:00 put
 * today's slot past the server's 15 minute grace (MISSED_GRACE_MS) and inside this spec's own
 * "over an hour old" cut on every run between 08:15 and 09:00 UTC: a third missed row the test
 * did not make (2026-11-13, CI at 08:20 UTC).
 */
const SLOT_HOUR = (new Date().getUTCHours() + 12) % 24

/** The last three daily slots, oldest first. */
function pastSlots(): number[] {
  const today = new Date()
  let s = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), SLOT_HOUR, 0, 0)
  while (s > Date.now()) s -= DAY
  return [s - 2 * DAY, s - DAY, s]
}

async function json(res: Response): Promise<any> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

test('the Routines card names a missed run, runs it now, sets one aside, and opens the history', async ({ page }) => {
  const stamp = `${Date.now()}`
  const { task } = await json(await fetch(`${API}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `PW missed run target ${stamp}`, source: 'local', project: 'Work' }),
  }))
  const [a, b, c] = pastSlots()
  const { job } = await json(await fetch(`${API}/api/routines`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `PW reflection ${stamp}`, enabled: true, wakeMode: 'now',
      schedule: { kind: 'cron', expr: `0 ${SLOT_HOUR} * * *`, tz: 'UTC' },
      executor: { type: 'session', config: { target: task.id, prompt: 'Reflect.' } },
      // The first slot ran; the second failed for want of room; nothing ran for the third.
      state: {
        expectFromMs: a - HOUR, runLogSinceMs: a - HOUR,
        runLog: [
          { atMs: b + 48_000, slotMs: b, status: 'error', durationMs: 48_000, error: NO_ROOM },
          { atMs: a + 5_000, slotMs: a, status: 'ok', durationMs: 1_200, summary: 'Delivered to the task' },
        ],
      },
    }),
  }))
  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.getByTestId('sidebar-core-app-routines').click()
    await expect(page.locator('.page-title')).toContainText('Routines')
    const card = page.locator('.routine-list .routine-card', { hasText: `PW reflection ${stamp}` }).first()
    // The row's one line says it missed runs; the opened row lists them.
    await expect(card.getByTestId('routine-row-missed')).toHaveText('Missed 2 runs')
    await openRoutineRow(card)
    const rows = card.getByTestId('routine-missed-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0)).toHaveAttribute('data-slot', String(c))
    await expect(rows.nth(0)).toContainText('no run was recorded for this time')
    await expect(rows.nth(1)).toHaveAttribute('data-slot', String(b))
    await expect(rows.nth(1)).toContainText(`Missed`)
    await expect(rows.nth(1)).toContainText(NO_ROOM)
    await shot(card, 'card-missed')

    // History: closed by default, opens with every run.
    const toggle = card.getByTestId('routine-history-toggle')
    await expect(toggle).toHaveText('History (2 runs)')
    await expect(card.getByTestId('routine-history-list')).toHaveCount(0)
    await toggle.click()
    const history = card.getByTestId('routine-history-list')
    await expect(history.locator('li')).toHaveCount(2)
    await expect(history.locator('li').nth(0)).toHaveAttribute('data-failed', 'true')
    await expect(history.locator('li').nth(0)).toContainText(`failed after 48 s: ${NO_ROOM}`)
    await expect(history.locator('li').nth(1)).toContainText('ran, 1.2 s: Delivered to the task')

    // Run it now for the failed slot: the run is made for that time, and its row leaves.
    const runCalls: string[] = []
    page.on('request', (r) => { if (r.url().endsWith(`/api/routines/${job.id}/run`)) runCalls.push(r.postData() ?? '') })
    await rows.nth(1).getByTestId('routine-missed-run').click()
    await expect(rows).toHaveCount(1, { timeout: 60_000 })
    expect(runCalls).toEqual([JSON.stringify({ catchUpMs: b })])
    await expect(rows.nth(0)).toHaveAttribute('data-slot', String(c))
    await expect(history.locator('li').first()).toContainText('catch-up for')
    await shot(card, 'card-caught-up')

    // Dismiss the other: no missed row left.
    await rows.nth(0).getByTestId('routine-missed-dismiss').click()
    await expect(card.getByTestId('routine-missed')).toHaveCount(0)
    const fresh = await json(await fetch(`${API}/api/routines/${job.id}`))
    expect(fresh.job.missed).toBeUndefined()
    expect(fresh.job.state.missedDismissedMs).toEqual([c])

    // The card stays inside the page.
    const box = await card.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  } finally {
    await fetch(`${API}/api/routines/${job.id}`, { method: 'DELETE' }).catch(() => {})
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
  }
})
