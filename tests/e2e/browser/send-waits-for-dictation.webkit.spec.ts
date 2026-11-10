/**
 * Send waits for the dictation in WebKit, the Mac app's engine. A synthetic
 * microphone makes recording possible here. Scenarios: send-waits-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { ENGINE_CHECK, NO_RECORDER, VOICE_TEST_UA_MARK, hasMediaRecorder } from './webkit-recorder'
import { registerSendWaitsScenarios } from './send-waits-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent + VOICE_TEST_UA_MARK })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

// Each scenario records the mic, which needs MediaRecorder.
test.beforeEach(async ({ page }, info) => {
  if (info.title !== ENGINE_CHECK) test.skip(!(await hasMediaRecorder(page)), NO_RECORDER)
})

registerSendWaitsScenarios('pw-sendwait2-session', 'pw-task-sendwait2')
