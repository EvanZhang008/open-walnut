import { test, expect } from '@playwright/test';
import { createCandidate, EVIDENCE, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('narrow task details expose current observation and use the full item width', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const sent = await sendItems(request, [mailItem('polish-current')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'polish-current');
  await row.getByRole('button', { name: /^Create and start task for/ }).click();
  await row.getByLabel('Work goal', { exact: true }).fill('Review the exact source and preserve this confirmed work goal.');
  await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
  await row.locator('.hii-confirm').getByRole('button', { name: 'Close', exact: true }).click();
  const started = await receipt(request, sent.id, 'polish-current');
  const finished = await request.post(`/api/v1/tasks/${started.receipts[0].taskId}/complete`, { data: {} });
  expect(finished.ok()).toBe(true);
  await row.getByRole('button', { name: /^Check status for/ }).click();
  const saved = await receipt(request, sent.id, 'polish-current');
  expect(saved.currentTask.status).toBe('completed');
  const details = row.locator('.hii-receipt-details'); await details.locator('summary').click();
  await expect(details.locator('.hii-current-task')).toContainText('Current task status');
  await expect(details.locator('.hii-current-task')).toContainText('Completed · Checked');
  await expect(details).toContainText('Started at');
  const widths = await row.evaluate(el => {
    const card = el as HTMLElement; const details = card.querySelector('.hii-receipt-details') as HTMLElement;
    const current = details.querySelector('.hii-current-task') as HTMLElement;
    return { row: card.clientWidth, details: details.clientWidth, current: current.clientWidth, overflow: current.scrollWidth };
  });
  expect(widths.row - widths.details).toBeLessThanOrEqual(26);
  expect(widths.current).toBeGreaterThan(240); expect(widths.overflow).toBeLessThanOrEqual(widths.current + 1);
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-polish-current-details.png`, scale: 'css' });
});

test('remote read restriction keeps the successful action history in a separate visible lane', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const sent = await sendItems(request, [mailItem('polish-remote')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'polish-remote');
  await row.getByRole('button', { name: /^Mark read for/ }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Marked read at');
  const before = await receipt(request, sent.id, 'polish-remote');
  await page.route('**/human-inbox/*/items/**', route => route.continue({ headers: { ...route.request().headers(), 'x-walnut-origin': 'remote-http' } }));
  await row.getByRole('button', { name: /^Check status for/ }).click();
  await expect(row.locator('.hii-read-status')).toContainText('Marked read previously at');
  await expect(row.locator('.hii-read-status')).toContainText('Available on Mac only');
  await expect(row.locator('.hii-action-read')).toBeDisabled();
  await row.locator('.hii-receipt-details summary').click();
  await expect(row.locator('.hii-read-history')).toContainText(new Date(before.receipts[0].updatedAt).toLocaleString());
  await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-polish-remote-history.png`, scale: 'css' });
});

test('pending read separates the current observation and missing mail dates stay consistent', async ({ page, request }, info) => {
  const item = mailItem('polish-pending', 'delay-'); item.display = { accountLabel: 'Mail' };
  const sent = await sendItems(request, [item]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/human-inbox/${sent.id}/items/${item.id}/prepare`, async route => {
    if (route.request().postDataJSON().actionId !== item.actions[0].id) return route.continue();
    const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  try {
    await row.getByRole('button', { name: /^Mark read for/ }).click();
    await expect(row.locator('.hii-read-status')).toContainText('Submitting… Current read status unavailable');
    await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-polish-pending.png`, scale: 'css' });
  } finally { release(); }
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
  await row.getByRole('button', { name: /^Create and start task for/ }).click();
  await expect(row.locator('.hii-source')).toContainText('Date unavailable');
  await expect(row.locator('.hii-confirm-source')).toContainText('Date unavailable');
  await expect(row.locator('.hii-confirm-source')).not.toContainText('Time unavailable');
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('touch disclosures are full hit targets including operation details', async ({ browser, request }, info) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 }, baseURL: info.project.use.baseURL });
  try {
    const page = await context.newPage(); const sent = await sendItems(request, [mailItem('polish-touch')]);
    await home(page); const row = itemRow(await openLetter(page, sent.subject), 'polish-touch');
    await row.getByRole('button', { name: /^Create and start task for/ }).click();
    await row.getByLabel('Work goal', { exact: true }).fill('Review the saved source.');
    await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
    for (const selector of ['.hii-source-details', '.hii-receipt-details', '.hii-operation-details']) {
      const summary = row.locator(`${selector} summary`);
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Tab'); await summary.focus();
      expect(await summary.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
    }
    await row.locator('.hii-receipt-details summary').click();
    const widths = await row.evaluate(el => ({ row: el.clientWidth, details: el.querySelector('.hii-receipt-details')!.clientWidth }));
    expect(widths.row - widths.details).toBeLessThanOrEqual(26);
    await page.screenshot({ path: `${EVIDENCE}/${info.project.name}-polish-touch.png`, scale: 'css' });
    await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally { await context.close(); }
});

test('complete task results do not ask for refinement and empty results have one recovery hint', async ({ page, request }) => {
  const title = `Polish candidates ${Date.now()}`;
  await createCandidate(request, title); await createCandidate(request, title);
  const sent = await sendItems(request, [mailItem('polish-count')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'polish-count');
  await row.getByRole('button', { name: /^Find task for/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
  await dialog.getByLabel('Search tasks', { exact: true }).fill(title);
  await expect(dialog.locator('.hii-candidate')).toHaveCount(2);
  await expect(dialog).toContainText('Showing 2 of 2.');
  await expect(dialog).not.toContainText('Refine your search.');
  await dialog.getByLabel('Search tasks', { exact: true }).fill(`${title} missing`);
  await expect(dialog).toContainText('No matching tasks');
  await expect(dialog).toContainText('Try another search');
  await expect(dialog).not.toContainText('Showing 0 of 0');
  await expect(dialog).not.toContainText('Refine your search.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('Mail navigation uses only the stored source and provides an honest unavailable fallback', async ({ page, request }) => {
  const item = mailItem('polish-open'); item.source.account = 'fixture-account&a'; item.source.message = 'fixture-message?a#b';
  const sent = await sendItems(request, [item]);
  let enabled = false;
  await page.route('**/api/plugin-runtime', async route => {
    const response = await route.fetch(); const data = await response.json();
    const plugins = (data.plugins ?? []).filter((p: { id: string }) => p.id !== 'mail');
    await route.fulfill({ response, json: { ...data, loading: false, plugins: enabled ? [...plugins, { id: 'mail', state: 'active' }] : plugins } });
  });
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  await expect(row.getByRole('button', { name: /^Open email for/ })).toHaveCount(0);
  await row.locator('.hii-source-details summary').click();
  await expect(row.locator('.hii-source-details')).toContainText('Mail page unavailable. Copy the source below.');
  await expect(row.getByRole('button', { name: /^Copy source for/ })).toBeVisible();
  // The runtime gate is the shared app capability. No real plugin or mailbox is enabled.
  enabled = true;
  // Reopen the isolated console with the new runtime snapshot, as a fresh client would.
  await home(page);
  const reopened = itemRow(await openLetter(page, sent.subject), item.id);
  const open = reopened.getByRole('button', { name: /^Open email for/ });
  await expect(open).toBeVisible();
  const mutations: string[] = [];
  page.on('request', req => { if (req.method() !== 'GET' && /\/items\/.*\/execute|\/tasks|\/api\/plugins\/mail/.test(req.url())) mutations.push(req.url()); });
  await open.click();
  await expect(page).toHaveURL(/\/mail\?/);
  const params = new URL(page.url()).searchParams;
  expect(params.get('account')).toBe(item.source.account); expect(params.get('message')).toBe(item.source.message);
  expect(params.get('readOnly')).toBe('1'); expect(mutations).toEqual([]);
  expect((await receipt(request, sent.id, item.id)).receipts).toHaveLength(0);
});
