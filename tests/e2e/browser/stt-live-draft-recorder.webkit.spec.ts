/**
 * The live draft reads the recording in WebKit, the Mac app's engine. Scenarios:
 * stt-live-draft-recorder-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { ENGINE_CHECK, NO_RECORDER, VOICE_TEST_UA_MARK, hasMediaRecorder } from './webkit-recorder'
import { registerLiveDraftRecorderScenarios } from './stt-live-draft-recorder-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent + VOICE_TEST_UA_MARK })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test.beforeEach(async ({ page }, info) => {
  if (info.title !== ENGINE_CHECK) test.skip(!(await hasMediaRecorder(page)), NO_RECORDER)
})

registerLiveDraftRecorderScenarios()
