/**
 * "Latest update" in WEBKIT, the Mac app's engine (a WKWebView). Same cases as
 * session-latest-update.spec.ts; the pin is its own file rather than a
 * `PW_WEBKIT=1` flag someone remembers to pass.
 */
import { test, expect } from '@playwright/test';
import { latestUpdateCases } from './session-latest-update-cases';

test.use({ browserName: 'webkit' });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

latestUpdateCases(test);
