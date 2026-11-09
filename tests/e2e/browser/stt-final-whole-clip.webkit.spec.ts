/**
 * The final words come from the whole recording, in WebKit (the Mac app's
 * engine). Scenarios and why: stt-final-whole-clip-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { ENGINE_CHECK, NO_RECORDER, hasMediaRecorder } from './webkit-recorder'
import { registerWholeClipScenarios } from './stt-final-whole-clip-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

test(ENGINE_CHECK, async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test.beforeEach(async ({ page }, info) => {
  if (info.title !== ENGINE_CHECK) test.skip(!(await hasMediaRecorder(page)), NO_RECORDER)
})

registerWholeClipScenarios()
