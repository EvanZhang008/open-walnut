/**
 * Quick Session path selector — loads history + live dirs without the
 * "Loading paths..." + "The operation timed out." contradiction.
 *
 * Regression target (2026-07-19 incident): server-side major-GC pauses froze
 * the event loop, /api/sessions/working-dirs blew the browser's 15s deadline,
 * and PathList rendered the stale TimeoutError next to a live loading state.
 * This spec pins the healthy path end-to-end on a real server + real UI clicks,
 * plus the UI-level fix (error suppressed while a load is in flight).
 */
import { test, expect } from '@playwright/test'
import { draftCwdPill, openDraft } from './draft-helpers'

test('the draft column opens the path selector and paths load', async ({ page }) => {
  await page.goto('/')

  // Real UI clicks: the draft column (the one session launcher on Home), then its
  // folder pill (never page.goto SPA routes).
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()

  // Selector opens.
  const list = page.locator('.sps-path-list')
  await expect(list).toBeVisible({ timeout: 10_000 })

  // Paths resolve: either history/live items or an explicit empty/edit state —
  // but NEVER the stale-error-next-to-loading contradiction.
  await expect
    .poll(async () => {
      const loading = await list.locator('.sps-empty', { hasText: 'Loading paths...' }).count()
      return loading
    }, { timeout: 20_000 })
    .toBe(0)

  // The incident's visible symptom must not render: an error row while loading.
  const errorRows = await list.locator('.sps-error').count()
  const loadingRows = await list.locator('.sps-empty', { hasText: 'Loading paths...' }).count()
  expect(loadingRows).toBe(0)
  expect(errorRows).toBe(0)

  // Something useful rendered: path items, a live-state note, create row, or empty hint.
  const items = await list.locator('.sps-path-item').count()
  const notes = await list.locator('.sps-live-note, .sps-host-note, .sps-create-row, .sps-empty').count()
  expect(items + notes).toBeGreaterThan(0)

  await page.screenshot({ path: '/tmp/quick-session-verify/selector-loaded.png' })
})
