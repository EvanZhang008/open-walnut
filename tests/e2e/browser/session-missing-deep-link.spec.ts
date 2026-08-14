/**
 * Regression: a session column whose id resolves to nothing used to be
 * indistinguishable from a slow load, and it never went away.
 *
 * SessionPanel retries a 404 30x/500ms (~15s) to cover a slow spawn, then used to
 * settle into an ordinary empty "Untitled session" panel. Because the id stayed in
 * the `open-walnut-home-session-columns` sessionStorage list, every reload replayed
 * the retry loop — 144 consecutive 404s were observed for a single id, and the user
 * read it as "Walnut can't create new sessions" while the real session was running
 * fine under its full id.
 *
 * Contract now: say "Session not found" explicitly, and let the user close the dead
 * column so it stops being retried.
 *
 * (Prefix resolution — the other half of the fix, where an 8-char id from a deep
 * link resolves to its canonical session — is covered at the API layer in
 * tests/web/routes/sessions.test.ts, which can seed session records directly.)
 */
import { test, expect } from '@playwright/test'

// Well-formed hex id (so it takes the prefix-resolution path) that matches nothing.
const UNKNOWN_ID = 'deadbeefcafe1234'

test('a deep link to an unknown session id shows an explicit not-found panel', async ({ page }) => {
  // A deep link IS the user action here — this is what an old notification or a
  // pasted link does. The /sessions route is a shim that reroutes to the home
  // session columns.
  await page.goto(`/sessions?id=${UNKNOWN_ID}`)

  const missing = page.locator('[data-session-missing="true"]')
  // ~15s of intentional retries before the panel gives up, so allow well past that.
  await expect(missing).toBeVisible({ timeout: 40_000 })
  await expect(missing).toContainText('Session not found')
  await expect(missing).toContainText(UNKNOWN_ID)

  // Once it has given up it must stop polling — the old code kept remounting and
  // re-running the 30-retry loop.
  let requestsAfterGiveUp = 0
  page.on('request', (req) => {
    if (req.url().includes(`/api/sessions/${UNKNOWN_ID}`)) requestsAfterGiveUp++
  })
  await page.waitForTimeout(3000)
  expect(requestsAfterGiveUp).toBe(0)

  // Closing removes the dead column (state + sessionStorage) so a reload can't
  // resurrect it.
  await missing.getByRole('button', { name: 'Close panel' }).click()
  await expect(page.locator('[data-session-missing="true"]')).toHaveCount(0)

  await page.reload()
  await page.waitForLoadState('networkidle')
  await expect(page.locator('[data-session-missing="true"]')).toHaveCount(0)
})
