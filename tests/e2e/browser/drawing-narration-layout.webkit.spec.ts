/**
 * The walkthrough control keeps its place in WebKit, the Mac app's engine, where Evan saw it move
 * (2026-11-20). Its recorder reads the microphone through Web Audio, not MediaRecorder, so it runs
 * in Linux WebKit too. Scenario: drawing-narration-layout-scenario.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { ENGINE_CHECK, VOICE_TEST_UA_MARK } from './webkit-recorder'
import { registerNarrationLayoutScenario } from './drawing-narration-layout-scenario'

// The synthetic microphone is an AudioContext: under automation only a voice test may make one.
test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent + VOICE_TEST_UA_MARK })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

registerNarrationLayoutScenario()
