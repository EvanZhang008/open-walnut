import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('private data sync stays protected and no longer offers credential-hold controls', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.route('**/api/git-sync/status', (route) => route.fulfill({ json: { protected: true, consecutiveFailures: 0, heldFiles: [] } }));
  await page.route('**/api/notifications', (route) => route.fulfill({ json: { feed: [], unreadCount: 0 } }));
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const panel = page.locator('.notification-panel');
  const system = panel.locator('.nfc-rail-btn', { hasText: 'System' });
  await system.click();
  const card = panel.locator('.notification-card').filter({ hasText: 'Data Backup' });
  await expect(card).toHaveClass(/\bok\b/);
  await expect(card.getByText('Protected', { exact: true })).toBeVisible();
  await expect(panel.getByTestId('private-data-holds')).toHaveCount(0);
  await expect(panel).not.toContainText('kept local');
  const dir = path.join(process.env.WALNUT_TASK_DIR!, 'evidence-private-sync');
  await fs.mkdir(dir, { recursive: true });
  await panel.screenshot({ path: path.join(dir, 'backup-no-holds.png') });
  await panel.locator('.nfc-rail-btn', { hasText: 'Needs you' }).click();
  await expect(panel).not.toContainText('credential');
  await system.click();
  await expect(card.getByText('Protected', { exact: true })).toBeVisible();
});
