/**
 * Whole-session find and ArrowUp recall in WEBKIT, the Mac app's engine. Its
 * own file because test.use({ browserName }) is per file. Matrix:
 * session-find-whole-cases.ts.
 */
import { devices, test, expect } from '@playwright/test';
import { defineSessionFindWholeCases } from './session-find-whole-cases';

test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

defineSessionFindWholeCases('webkit');
