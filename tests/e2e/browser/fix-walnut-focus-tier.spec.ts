/**
 * "fix walnut" pill → the created task must land in the FOCUS tier.
 *
 * Reported bug: clicking the pill and sending a report created a task that was
 * NOT pinned, so the repair never showed up in the Focus tier and the user had
 * to hand-pin it every time. The pill skips the path picker entirely, so nothing
 * ever produced the launcher's task meta and the request carried no `taskMeta`
 * at all — the server only defaults `starred`, never a pin tier.
 *
 * Drives the real UI (pill click → type → Enter) and asserts on the focus API,
 * which is the same source the Focus tier renders from.
 */

import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

test('fix walnut pill creates a task pinned to the Focus tier', async ({ page }) => {
  // The session launcher's pin tier is sticky (and server-mirrored), but the pill
  // must IGNORE it — a repair report is always Focus. Seed a non-Focus sticky
  // tier so this spec fails if the pill ever starts inheriting that preference,
  // instead of passing by luck whenever the stored tier happens to be 'focus'.
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-launcher-pin-tier', 'wait') } catch { /* storage disabled */ }
  })
  await page.goto('/')

  const pill = page.getByRole('button', { name: /fix walnut/i })
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()

  // The quick-start bar confirms the repair intent (and that no path picker opened).
  const bar = page.locator('.quick-start-bar')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await expect(bar.locator('.qsb-label')).toContainText('Fix Walnut')

  // Capture the launch payload: the frontend must send the launcher defaults even
  // though the pill skipped the picker (the layer that used to send nothing at all).
  const launchRequest = page.waitForRequest(req =>
    req.url().includes('/api/sessions/quick-start') && req.method() === 'POST')

  const report = `focus tier regression probe ${Date.now()}`
  const input = page.locator('.chat-input-textarea')
  await input.click()
  await input.fill(report)
  await input.press('Enter')

  const payload = (await launchRequest).postDataJSON() as {
    intent?: string
    taskMeta?: { pinTier?: string; starred?: boolean }
  }
  expect(payload.intent).toBe('fix-walnut')
  expect(payload.taskMeta?.pinTier).toBe('focus')
  expect(payload.taskMeta?.starred).toBe(true)

  // Find the task the launch created. Title is server-built as "Fix Walnut: <report>".
  const titleNeedle = report.slice(0, 40)
  const findTaskId = async (): Promise<string | null> => {
    const res = await fetch(`${API}/api/tasks?limit=200`)
    if (!res.ok) return null
    const body = (await res.json()) as { tasks?: Array<{ id: string; title?: string; project?: string }> }
    return body.tasks?.find(t => t.project === 'Fix Walnut' && t.title?.includes(titleNeedle))?.id ?? null
  }
  await expect.poll(findTaskId, { timeout: 20_000, message: 'fix-walnut task was never created' })
    .not.toBeNull()
  const taskId = (await findTaskId())!

  // The focus API is exactly what the Focus tier renders from.
  await expect.poll(async () => {
    const res = await fetch(`${API}/api/focus/tasks`)
    if (!res.ok) return false
    const body = (await res.json()) as { focus_tasks?: string[] }
    return body.focus_tasks?.includes(taskId) ?? false
  }, { timeout: 15_000, message: 'fix-walnut task never reached the focus tier' }).toBe(true)

  await page.screenshot({ path: '/tmp/fix-walnut-focus/focus-tier.png', fullPage: true })
})
