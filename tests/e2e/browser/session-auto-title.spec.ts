/**
 * Path-first quick session → CLI-generated title (real UI, full loop).
 *
 * Feature under test: a session started from the todo toolbar "+" launcher has
 * NO first message, so its task keeps the `Session: <basename>` placeholder.
 * When the user types their first real message in the session column, the
 * session-auto-title hook asks the live CLI (generate_session_title
 * control_request over the FIFO) and the placeholder is replaced everywhere
 * the title renders — asserted here on the session panel header, which
 * receives it via the task:updated WS event.
 *
 * The fixture server runs mock-claude.mjs, whose persistent stdin listener
 * answers generate_session_title with `Mock title: <first 5 words>`.
 */
import { test, expect } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

test('path-first quick session gets an AI title from the first real message', async ({ page }) => {
  // Path-first launch through the REAL quick-start route (empty message →
  // init-only spawn). Driving this via API keeps the spec independent of the
  // launcher popover's ranking UI; the UI part under test is what happens in
  // the session column afterwards.
  const res = await fetch(`${API}/api/sessions/quick-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: process.cwd(), message: '' }),
  })
  expect(res.ok).toBeTruthy()
  const { taskId, sessionId } = await res.json() as { taskId: string; sessionId?: string }
  expect(sessionId).toBeTruthy()

  // The task wears the placeholder.
  const taskRes = await fetch(`${API}/api/tasks/${taskId}`)
  const { task } = await taskRes.json() as { task: { title: string } }
  expect(task.title).toMatch(/^Session: /)
  const placeholder = task.title

  // Open the session column via deep link (redirect shim → home column).
  await page.goto(`/sessions?id=${sessionId}`)
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
  const panel = page.locator('.main-page-session-column .session-panel').first()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel).toContainText(placeholder, { timeout: 15_000 })

  // First real user message, typed in the real composer.
  const input = panel.locator('.chat-input-textarea, textarea').first()
  await input.click()
  await input.fill('title-test:investigate flaky checkout tests')
  await input.press('Enter')

  // The hook asks the CLI; the panel header updates via task:updated.
  await expect(panel).toContainText('Side title: title-test:investigate flaky checkout tests', { timeout: 30_000 })

  // The task title is durably replaced too (not just the visible header).
  await expect.poll(async () => {
    const r = await fetch(`${API}/api/tasks/${taskId}`)
    const b = await r.json() as { task: { title: string } }
    return b.task.title
  }, { timeout: 10_000 }).toBe('Side title: title-test:investigate flaky checkout tests')

  await page.screenshot({ path: '/tmp/session-auto-title/ai-title.png', fullPage: true })
})
