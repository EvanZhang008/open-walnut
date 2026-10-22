import { test, expect } from '@playwright/test';
import { EVIDENCE, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
for (const mode of ['zero-change-', 'fail-', 'wrong-account-', 'wrong-read-', 'nonjson-', 'provider-refusal-']) {
  test(`provider ${mode} cannot claim a successful read`, async ({ page, request }, info) => {
    const item = mailItem(`shape-${mode}`, mode);
    const sent = await sendItems(request, [item]);
    await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
    await row.getByRole('button', { name: /^Mark read for/ }).click();
    await expect(row.locator('.hii-read-status')).toContainText('Could not mark read');
    await expect(row.locator('.hii-read-status')).not.toContainText('Marked read at');
    const result = await receipt(request, sent.id, item.id);
    expect(result.receipts[0].status).toBe('failure');
    expect(result.receipts[0].source).toEqual(item.source);
    await row.locator('.hii-receipt-details summary').click();
    await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-provider-${mode}.png`, scale: 'css' });
    await expect(row.getByRole('button', { name: /^Retry mark read for/ })).toBeEnabled();
  });
}
