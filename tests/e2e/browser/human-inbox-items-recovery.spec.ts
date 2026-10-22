import { test, expect } from '@playwright/test';
import { EVIDENCE, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('provider nonconfirmation is local failure while a second item remains usable', async ({ page, request }, info) => {
  const sent = await sendItems(request, [mailItem('failure-a', 'fail-'), mailItem('success-b')]);
  await home(page); const view = await openLetter(page, sent.subject);
  const a = itemRow(view, 'failure-a'); const b = itemRow(view, 'success-b');
  await a.getByRole('button', { name: 'Mark read for Email failure-a', exact: true }).click();
  await expect(a.locator('.hii-receipts')).toContainText('Could not mark read');
  await expect(a.getByRole('button', { name: 'Retry mark read for Email failure-a', exact: true })).toBeEnabled();
  await b.getByRole('button', { name: 'Mark read for Email success-b', exact: true }).click();
  await expect(b.locator('.hii-receipts')).toContainText('Marked read');
  await expect(a.locator('.hii-receipts')).not.toContainText('Marked read');
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-partial-failure.png` });
});

test('lost execute response queries the persistent result and never sends a second mutation', async ({ page, request }) => {
  const sent = await sendItems(request, [mailItem('lost-a')]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, 'lost-a');
  let writes = 0;
  await page.route(`**/human-inbox/${sent.id}/items/lost-a/execute`, async route => {
    writes++; await route.fetch(); await route.abort('failed');
  });
  await row.getByRole('button', { name: 'Mark read for Email lost-a', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Marked read', { timeout: 15_000 });
  expect(writes).toBe(1);
  expect((await receipt(request, sent.id, 'lost-a')).receipts).toHaveLength(1);
  await view.getByRole('button', { name: 'Close letter', exact: true }).click();
  const center = page.locator('.notification-panel');
  await center.locator('.hib-row').filter({ hasText: sent.subject }).locator('.hib-subject').click();
  await expect(itemRow(page.locator('.hib-reader .hib-view'), 'lost-a').locator('.hii-receipts')).toContainText('Marked read');
  expect(writes).toBe(1);
});

test('query failure preserves the last known receipt and check status is read-only', async ({ page, request }) => {
  const sent = await sendItems(request, [mailItem('stale-a')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'stale-a');
  await row.getByRole('button', { name: 'Mark read for Email stale-a', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
  await page.route(`**/human-inbox/${sent.id}/items/stale-a/execution`, route => route.abort('failed'));
  await row.getByRole('button', { name: 'Check status for Email stale-a', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Status unavailable. Check again.');
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
});
