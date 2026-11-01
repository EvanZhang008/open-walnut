/**
 * An "@" task pick is drawn as a task pill in the composer (ComposerRefMirror),
 * in Chromium. Scenario matrix: composer-ref-token-helpers.ts. The WebKit twin
 * (the Mac app's engine) is composer-ref-token.webkit.spec.ts.
 */
import { test } from '@playwright/test'
import { runRefTokenMatrix } from './composer-ref-token-helpers'

test.fixme('an "@" task pick is a pill in the box, aligned glyph for glyph, and the caret treats it as one object', async ({ page, request }) => {
  test.setTimeout(300_000)
  await runRefTokenMatrix(page, request, 'chromium')
})
