/**
 * The composer's task pill in WEBKIT, the engine of the Mac app (a WKWebView).
 * Its own file because a WebKit pin only holds at the top level of a spec file.
 * Scenario matrix: composer-ref-token-helpers.ts.
 */
import { test, expect } from '@playwright/test'
import { runRefTokenMatrix } from './composer-ref-token-helpers'

test.use({ browserName: 'webkit' })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test.fixme('an "@" task pick is a pill in the box, aligned glyph for glyph, and the caret treats it as one object', async ({ page, request }) => {
  test.setTimeout(300_000)
  await runRefTokenMatrix(page, request, 'webkit')
})
