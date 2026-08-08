/**
 * Text-first quick session → CLI-generated title at LAUNCH (real UI).
 *
 * Feature under test: a session started WITH a first message gets its AI title
 * from the launch itself (autoTitleFromLaunch) — the launch message rides
 * SESSION_START, which the hook dispatcher never maps, so before this feature
 * the task kept the `Session: <basename>` placeholder until the user's SECOND
 * message. Asserted on the session panel header (task:updated WS event) with
 * NO message typed after launch.
 *
 * The fixture server runs mock-claude.mjs ('title-test:' mode = run the turn,
 * stay alive, answer generate_session_title with `Mock title: <first 5 words>`).
 */
import { test, expect } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

test('text-first quick session gets an AI title from the launch message alone', async ({ page }) => {
  const res = await fetch(`${API}/api/sessions/quick-start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: process.cwd(), message: 'title-test:speed up the nightly build' }),
  })
  expect(res.ok).toBeTruthy()
  const { taskId, sessionId } = await res.json() as { taskId: string; sessionId?: string }
  expect(sessionId).toBeTruthy()

  // Open the session column; the title must flip from the placeholder to the
  // AI one without any user input in the composer.
  await page.goto(`/sessions?id=${sessionId}`)
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })
  const panel = page.locator('.main-page-session-column .session-panel').first()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel).toContainText('Side title: title-test:speed up the nightly build', { timeout: 45_000 })

  // Durable on the task too.
  await expect.poll(async () => {
    const r = await fetch(`${API}/api/tasks/${taskId}`)
    const b = await r.json() as { task: { title: string } }
    return b.task.title
  }, { timeout: 10_000 }).toBe('Side title: title-test:speed up the nightly build')

  await page.screenshot({ path: '/tmp/walnut-autoorg/scene-text-first-title.png', fullPage: true })
})
