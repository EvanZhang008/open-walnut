/**
 * The fullscreen-yield core case, in WEBKIT.
 *
 * The Mac app is a WKWebView and this bug was reported from it: a fullscreen
 * panel covering the column that "Open session ↗" had just opened. The fix is
 * engine-independent, but "it works in the app" needs the app's engine pinned in
 * a file, not a CLI flag someone remembers to pass. Scenario matrix and rationale:
 * fullscreen-yields-to-column-open.spec.ts (Chromium).
 */
import { test, expect } from '@playwright/test'
import { ensureScreenshotDir, openSessionFromToastRevealsTargetColumn, prepareHome } from './fullscreen-yield-helpers'

test.use({ browserName: 'webkit' })

test.beforeAll(ensureScreenshotDir)
test.beforeEach(async ({ page }) => { await prepareHome(page) })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('Open session ↗ on a toast drops the fullscreen sheet and reveals the target column', async ({ page }) => {
  await openSessionFromToastRevealsTargetColumn(page)
})
