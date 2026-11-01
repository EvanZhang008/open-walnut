/**
 * The same mic-warning scenarios in WebKit, the Mac app's engine, where the
 * 2026-10-31 report came from. Scenarios: mic-stall-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { registerMicStallScenarios } from './mic-stall-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

registerMicStallScenarios()
