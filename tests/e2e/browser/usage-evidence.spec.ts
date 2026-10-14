import { test, expect } from '@playwright/test';
test.setTimeout(120_000);

test('usage shows verified totals, coding tasks and unmatched evidence without fabricated prices', async ({ page }) => {
  const day = new Intl.DateTimeFormat('en-CA').format(new Date());
  const fixture = {
    summary: { total_cost: 5.9902194, session_cost: 5.9902194, api_calls: 21, verified_calls: 18, unverified_calls: 3, token_counts_complete: false,
      input_tokens: 36, output_tokens: 14412, cache_read_tokens: 3493937, cache_creation_tokens: 625381 },
    daily: [{ date: day, cost_usd: 5.9902194, input_tokens: 36, output_tokens: 14412, cache_read_tokens: 3493937, cache_creation_tokens: 625381, api_calls: 18 }],
    bySource: [{ name: 'session', cost_usd: 5.9902194, api_calls: 21, unverified_calls: 3, input_tokens: 36, output_tokens: 14412, cache_read_tokens: 3493937, cache_creation_tokens: 625381, percentage: 100 }],
    byModel: [], byAgent: [], dateBounds: { min: day, max: day },
    recent: [{ id: 'unknown-call', timestamp: new Date().toISOString(), date: day, source: 'session', model: 'custom-model',
      input_tokens: null, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: null, verification: 'unverified' }],
    sessions: Array.from({ length: 30 }, (_, n) => ({ sessionId: `example-${n}`, title: `Review task ${n + 1}`, project: 'Example', host: 'local', calls: 21, cost: 5.9902194, unverified: 3 })),
    accuracy: { timezone: 'America/Los_Angeles', pricingVersion: '2026-10-14', until: new Date().toISOString(), status: 'partial',
      note: 'Verified token estimates only. Unmatched calls are not included in cost. This is not an invoice.',
      checks: [{ source: 'Canonical transcript', host: 'local', status: 'partial', matchedCalls: 18, unmatchedCalls: 3,
        detail: 'Final response usage, deduplicated across streaming blocks and copied history.', residuals: [{ source: 'canonical', model: 'custom-model', count: 3, input_tokens: null, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }] },
        { source: 'Provider invoice', host: 'local', status: 'unverified', matchedCalls: 0, unmatchedCalls: 0, detail: 'Account-wide, delayed usage.' }] },
    collection: { running: false },
  };
  await page.route('**/api/usage/overview*', route => route.fulfill({ json: fixture }));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  if (cdp) await cdp.send('Page.navigate', { url: test.info().project.use.baseURL + '/' });
  else {
    const url = test.info().project.use.baseURL + '/';
    await page.evaluate(url => { window.location.href = url; }, url);
  }
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 });
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await settings.click();
  const nav = page.getByTestId('settings-nav-usage'); await nav.scrollIntoViewIfNeeded(); await nav.click();
  const pane = page.locator('.settings-pane');
  await expect(pane.getByText('Verified token estimate', { exact: true })).toBeVisible();
  await expect(pane.getByText('$5.99', { exact: true }).first()).toBeVisible();
  await expect(pane.getByText('By task', { exact: true })).toBeVisible();
  await expect(pane.getByText('Review task 1', { exact: true })).toBeVisible();
  await pane.getByTestId('usage-evidence').locator(':scope > summary').click();
  await pane.getByText('Unmatched tokens by model', { exact: true }).click();
  await expect(pane.getByText(/input Unknown/)).toBeVisible();
  const recent = pane.locator('.settings-usage-recent'); await recent.scrollIntoViewIfNeeded();
  await expect(recent.getByText('Unverified', { exact: true })).toBeVisible();
  await expect(recent.getByText('Unknown', { exact: true })).toBeVisible();
  const summary = pane.getByTestId('usage-summary'); await summary.scrollIntoViewIfNeeded();
  await expect(summary.getByText('Unknown', { exact: true })).toBeVisible();
  await pane.getByText(/20 more tasks/).scrollIntoViewIfNeeded(); await pane.getByText(/20 more tasks/).click();
  await expect(pane.getByText('Review task 30', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
