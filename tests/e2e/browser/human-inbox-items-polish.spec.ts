import { test, expect } from '@playwright/test';
import { EVIDENCE, expectContentActionsOnly, expectNewTaskOnlyDrafts, home, itemRow, mailItem, markUnreadElsewhere, openLetter, openMarkReadAgain, receipt, runLegacyCreate, sendItems, sendLegacyItems, settledCreate } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
// A task an email item started comes only from a letter stored before 2026-11-02 (5a28ae6c9), run by
// an older client; the web still shows that task's current status.
test('narrow task details expose current observation and use the full item width', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const sent = await sendLegacyItems(request, [mailItem('polish-current')]);
  await runLegacyCreate(request, sent.id, 'polish-current', { goal: 'Review the exact source and preserve this confirmed work goal.' });
  expect((await settledCreate(request, sent.id, 'polish-current')).status).toBe('success');
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'polish-current');
  await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
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
  const item = mailItem('polish-pending'); item.display = { accountLabel: 'Mail' };
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
  // The gate is done. Off before the confirmation below, whose prepares (one per edit, aborted on
  // Cancel) would otherwise still be in route.fetch when the page closes, and that fails the test
  // after it passed (2026-11-03, CI).
  await page.unrouteAll({ behavior: 'wait' });
  // The confirmation an item still opens (Mark read again; the create form is gone since 5a28ae6c9).
  await markUnreadElsewhere(request, item);
  await row.getByRole('button', { name: /^Check status for/ }).click();
  await row.getByRole('button', { name: /^Mark read again for/ }).click();
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
    // Mark read again: the confirmation (with its operation details) an item still opens.
    await openMarkReadAgain(request, row, mailItem('polish-touch'));
    await expect(row.locator('.hii-operation-details summary')).toBeVisible();
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

// The task search these counts belonged to is gone with every email item's task intents
// (2026-11-02, 5a28ae6c9): no results to refine, two content actions, and New task makes nothing.
test('an email item offers no task search results: Talk to CEO and New task instead, and New task makes nothing', async ({ page, request }) => {
  const item = mailItem('polish-count');
  const sent = await sendItems(request, [item]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  await expectContentActionsOnly(row, item.subject);
  await expect(page.getByRole('dialog', { name: 'Choose a task', exact: true })).toHaveCount(0);
  await expect(row).not.toContainText('Refine your search.');
  await expectNewTaskOnlyDrafts(page, request, row, item.subject, sent.id, item.id);
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
