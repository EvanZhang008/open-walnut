/**
 * The walkthrough control keeps its place, in Chromium. The scenario and why it exists:
 * drawing-narration-layout-scenario.ts; the same in WebKit: drawing-narration-layout.webkit.spec.ts
 * (its synthetic microphone needs the voice-test agent that file pins).
 */
import { test } from '@playwright/test'
import { registerNarrationLayoutScenario } from './drawing-narration-layout-scenario'

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'WebKit runs drawing-narration-layout.webkit.spec.ts')
})

registerNarrationLayoutScenario()
