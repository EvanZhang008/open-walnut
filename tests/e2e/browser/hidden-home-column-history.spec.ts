/**
 * A Home column behind another page reads no full history until Home shows it.
 *
 * The Mac app keeps the home page mounted behind every other route (App.tsx, RouteShownContext).
 * 2026-11-16, task 9bceb9f2 (found by task mwb3suvm): two of its columns held clouddev sessions of
 * 440 MB and 186 MB, and while Evan was on the Org page each one still ran its full history read
 * (`/history?tail=400&turns=10`) on every page load, server restart and host reconnect: a 4 MB
 * tail, 2 to 11 s on the clouddev link, six times in half an hour, on the link the chats on screen
 * read through. Nobody saw either chat. Here:
 *  - a column on the hidden home page shows its first screen (the streams read) and makes no full read;
 *  - once Home is shown, the same column makes its full read and shows its rows.
 * Each fails on the code before: the full read went out with the first screen.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { seedColumns } from './draft-helpers'

const SID = 'pw-history-turns-session'

function countHistoryReads(page: Page): { streams: number; full: number } {
  const n = { streams: 0, full: 0 }
  page.on('request', (r) => {
    const url = new URL(r.url())
    if (url.pathname !== `/api/sessions/${SID}/history`) return
    if (url.searchParams.get('source') === 'streams') n.streams++
    else if (!url.searchParams.has('before')) n.full++
  })
  return n
}

test('a column of the hidden home page waits for Home to show before its full history read', async ({ page }) => {
  test.setTimeout(120_000)
  await isolateUiPrefs(page)
  await seedColumns(page, [SID])
  const reads = countHistoryReads(page)
  await page.goto('/org')
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  const column = page.locator(`.session-panel[data-session-id="${SID}"]`).first()
  await expect(column).toBeAttached({ timeout: 30_000 })
  // The column is there, behind the Org page, and has read its first screen.
  await expect.poll(() => reads.streams, { timeout: 20_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(6_000)
  expect(reads.full, 'full history reads while Home is hidden').toBe(0)

  // Home on show (the router's own navigation, no reload): the full read goes out now.
  await page.evaluate(() => {
    window.history.pushState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => reads.full, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect(column.locator('.session-history .session-msg').first()).toBeVisible({ timeout: 20_000 })
})
