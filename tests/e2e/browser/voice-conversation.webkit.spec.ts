/**
 * Voice conversation in WebKit, the Mac app's engine. Scenarios: voice-conversation-helpers.ts.
 * Playwright's Linux WebKit has no MediaRecorder, so this runs on the Mac (walnut-dev webkit --mac).
 */
import { devices, expect, test } from '@playwright/test'
import { ENGINE_CHECK, NO_RECORDER, VOICE_TEST_UA_MARK, hasMediaRecorder } from './webkit-recorder'
import { registerVoiceConversationScenarios } from './voice-conversation-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent + VOICE_TEST_UA_MARK })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test.beforeEach(async ({ page }, info) => {
  if (info.title !== ENGINE_CHECK) test.skip(!(await hasMediaRecorder(page)), NO_RECORDER)
})

registerVoiceConversationScenarios()
