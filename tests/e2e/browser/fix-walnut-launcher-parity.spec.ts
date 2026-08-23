/**
 * "fix walnut" pill → the launch must follow the SAME launcher settings as a
 * regular quick session.
 *
 * Reported bug (2026-07-30): the pill hardcoded pinTier:'focus' and always reset
 * the model to Auto, ignoring the launcher default and the checkout dir's
 * remembered model — unlike every other quick-session launch. The pill skips the
 * path picker, so it must seed the launcher defaults itself (freshLauncherMeta +
 * per-dir launch memory). This REPLACES the earlier contract that pinned repairs
 * to Focus unconditionally — user direction.
 *
 * Drives the real UI (pill click → type → Enter) and asserts on the quick-start
 * payload + the focus API (the same source the tiers render from).
 */

import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

test('fix walnut pill inherits the launcher tier instead of forcing Focus', async ({ page }) => {
  // Nothing to seed: the launcher tier is no longer sticky, so the value the pill
  // must inherit is the plain default (Satellite). Focus is what the bug produced,
  // so 'satellite' vs 'focus' is still the discriminating assertion.
  await page.goto('/')

  const pill = page.getByRole('button', { name: /fix walnut/i })
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()

  // The quick-start bar confirms the repair intent (and that no path picker opened).
  const bar = page.locator('.quick-start-bar')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await expect(bar.locator('.qsb-label')).toContainText('Fix Walnut')

  // Capture the launch payload: the pill skips the picker, so the frontend must
  // still send the launcher defaults with the remembered tier applied.
  const launchRequest = page.waitForRequest(req =>
    req.url().includes('/api/sessions/quick-start') && req.method() === 'POST')

  const report = `sticky tier parity probe ${Date.now()}`
  const input = page.locator('.chat-input-textarea')
  await input.click()
  await input.fill(report)
  await input.press('Enter')

  const payload = (await launchRequest).postDataJSON() as {
    intent?: string
    taskMeta?: { pinTier?: string | null }
  }
  expect(payload.intent).toBe('fix-walnut')
  expect(payload.taskMeta?.pinTier).toBe('satellite')

  // Find the task the launch created. Title is server-built as "Fix Walnut: <report>".
  const titleNeedle = report.slice(0, 40)
  const findTask = async (): Promise<{ id: string } | null> => {
    const res = await fetch(`${API}/api/tasks?limit=200`)
    if (!res.ok) return null
    const body = (await res.json()) as { tasks?: Array<{ id: string; title?: string; project?: string }> }
    return body.tasks?.find(t => t.project === 'Walnut' && t.title?.includes(titleNeedle)) ?? null
  }
  await expect.poll(findTask, { timeout: 20_000, message: 'fix-walnut task was never created' })
    .not.toBeNull()
  const taskId = (await findTask())!.id

  // The focus API is exactly what the tier UI renders from: the task must land in
  // the launcher's default tier (satellite), not in focus.
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/focus/tasks`)
    if (!res.ok) return 'api-error'
    const body = (await res.json()) as { focus_tasks?: string[]; satellite_tasks?: string[]; wait_tasks?: string[] }
    if (body.focus_tasks?.includes(taskId)) return 'focus'
    if (body.wait_tasks?.includes(taskId)) return 'wait'
    // Satellite is the DEFAULT bucket: a pinned task in no named tier is in it.
    // Read it positively when the API reports it, else infer from "pinned, not
    // focus/wait" the same way the panel splits the tiers.
    if (body.satellite_tasks?.includes(taskId)) return 'satellite'
    return 'unpinned'
  }, { timeout: 15_000, message: 'fix-walnut task never reached the default (satellite) tier' })
    .toBe('satellite')

  await page.screenshot({ path: '/tmp/fix-walnut-parity/default-tier.png', fullPage: true })
})
