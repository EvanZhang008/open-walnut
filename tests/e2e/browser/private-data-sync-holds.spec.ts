import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Only the backup-health payload is seeded; the real app, bell and Health UI render it. */
test('private-data holds are quiet Health detail, never a bell or Needs you alarm', async ({ page, baseURL }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.log('BROWSER ERROR', m.text()); });
  page.on('requestfailed', (r) => console.log('FAILED REQUEST', r.url(), r.failure()?.errorText));
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.route('**/api/git-sync/status', (route) => route.fulfill({ json: {
    protected: true, consecutiveFailures: 0,
    heldFiles: Array.from({ length: 20 }, (_, i) => ({
      file: `/home/alice/.open-walnut/human-inbox/bodies/lt-private-${i}-long-document.md`,
      kinds: ['google-oauth-secret'], lines: [i + 2], since: '2026-11-12T00:00:00Z',
    })),
  } }));
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { feed: [], unreadCount: 0 } }));
  // Enter through a real link; subsequent navigation uses the app's controls.
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const panel = page.locator('.notification-panel');
  await expect(panel).toBeVisible();
  const system = panel.locator('.nfc-rail-btn', { hasText: 'System' });
  await system.click();
  const hold = panel.getByTestId('private-data-holds');
  await expect(hold).toBeVisible();
  const card = panel.locator('.notification-card').filter({ has: page.getByTestId('private-data-holds') });
  await expect(card).toHaveClass(/\bok\b/);
  await expect(card.getByText('Protected', { exact: true })).toBeVisible();
  await hold.locator('summary').click();
  await expect(hold).toContainText('private data folder, not the Walnut code repository');
  await expect(hold).toContainText('not sent anywhere');
  await expect(hold).toContainText('No review is needed from you');
  await expect(hold.locator('li')).toHaveCount(20);
  await hold.locator('li').last().scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 420, height: 800 });
  await hold.locator('summary').scrollIntoViewIfNeeded();
  expect(await hold.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1100, height: 800 });
  // The responsive bell closes its panel on a layout change; reopen through its real control.
  if (!await panel.isVisible()) {
    await page.getByRole('button', { name: 'Notifications', exact: true }).click();
    await system.click();
    await hold.locator('summary').click();
  }
  await hold.locator('summary').scrollIntoViewIfNeeded();
  const dir = path.join(process.env.WALNUT_TASK_DIR!, 'evidence');
  await fs.mkdir(dir, { recursive: true });
  expect(await hold.locator('summary').evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(250);
  await panel.screenshot({ path: path.join(dir, 'private-data-health-final.png') });
  await hold.locator('summary').click();
  await expect(hold).not.toHaveAttribute('open', '');
  await panel.locator('.nfc-rail-btn', { hasText: 'Needs you' }).click();
  await expect(panel.getByTestId('private-data-holds')).toHaveCount(0);
  await expect(panel).not.toContainText('google-oauth-secret');
  await system.click();
  await expect(panel.getByTestId('private-data-holds')).toBeVisible();
});
