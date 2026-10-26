/**
 * Page find + selection echo in WEBKIT, the Mac app's engine (a WKWebView with
 * no find bar of its own, so Cmd+F there is entirely ours). Its own file
 * because test.use({ browserName }) is per file. Matrix: page-find-cases.ts.
 */
import { test, expect } from '@playwright/test';
import { definePageFindCases } from './page-find-cases';

test.use({ browserName: 'webkit' });

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

definePageFindCases('webkit');
