/**
 * The same dictation-failure scenarios in WebKit, the Mac app's engine, where
 * the 2026-09-28 report came from. A synthetic microphone makes recording
 * possible here (WebKit has no fake capture device). Scenarios:
 * stt-failure-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { registerSttFailureScenarios } from './stt-failure-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

registerSttFailureScenarios()
