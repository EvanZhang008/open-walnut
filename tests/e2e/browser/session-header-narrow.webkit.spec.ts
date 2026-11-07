/**
 * A narrow session column keeps its header readable, in WebKit: the Mac app is a
 * WKWebView, and CI's Chromium run of these scenarios never saw what WebKit did
 * (2026-11-07): a header whose title row moved its labels under the title inside a
 * ResizeObserver callback, which WebKit reports as 'ResizeObserver loop completed with
 * undelivered notifications', and reads taken before WebKit's next frame had measured
 * a widened column. Scenarios: session-header-narrow-helpers.ts.
 */
import { devices, expect, test } from '@playwright/test'
import { headerNarrowTests } from './session-header-narrow-helpers'

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

headerNarrowTests()
