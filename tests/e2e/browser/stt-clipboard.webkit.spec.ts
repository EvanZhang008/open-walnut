/**
 * Dictate to the clipboard in WebKit, the Mac app's engine. Scenarios:
 * stt-clipboard-helpers.ts.
 */
import { expect, test } from '@playwright/test'
import { ENGINE_CHECK, NO_RECORDER, VOICE_TEST_USER_AGENT, hasMediaRecorder } from './webkit-recorder'
import { registerClipboardDictationScenarios } from './stt-clipboard-helpers'

test.use({ browserName: 'webkit', userAgent: VOICE_TEST_USER_AGENT })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test.beforeEach(async ({ page }, info) => {
  if (info.title !== ENGINE_CHECK) test.skip(!(await hasMediaRecorder(page)), NO_RECORDER)
})

registerClipboardDictationScenarios()
