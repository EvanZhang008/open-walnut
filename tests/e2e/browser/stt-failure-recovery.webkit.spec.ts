/**
 * The same dictation-failure scenarios in WebKit, the Mac app's engine, where
 * the 2026-09-28 report came from. A synthetic microphone makes recording
 * possible here (WebKit has no fake capture device). Scenarios:
 * stt-failure-helpers.ts.
 */
import { expect, test } from '@playwright/test'
import { ENGINE_CHECK, NO_RECORDER, VOICE_TEST_USER_AGENT, hasMediaRecorder } from './webkit-recorder'
import { registerSttFailureScenarios } from './stt-failure-helpers'

test.use({ browserName: 'webkit', userAgent: VOICE_TEST_USER_AGENT })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

// Each scenario records the mic, which needs MediaRecorder.
test.beforeEach(async ({ page }, info) => {
  if (info.title !== ENGINE_CHECK) test.skip(!(await hasMediaRecorder(page)), NO_RECORDER)
})

registerSttFailureScenarios()
