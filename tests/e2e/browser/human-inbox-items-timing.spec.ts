import { test, expect } from '@playwright/test';
import { expectContentActionsOnly, expectNewTaskOnlyDrafts, failedLegacyStart, home, itemRow, mailItem, openLetter, receipt, sendItems, sendLegacyItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
// The task search a late result could race is gone with every email item's task intents
// (2026-11-02, 5a28ae6c9): the item searches nothing, and New task makes nothing.
test('an email item runs no task search: Talk to CEO and New task instead, and New task makes nothing', async ({ page, request }) => {
  const item = mailItem('timing-search');
  const sent = await sendItems(request, [item]);
  const searches: string[] = [];
  page.on('request', req => { if (/\/items\/[^/]+\/tasks\b/.test(new URL(req.url()).pathname)) searches.push(req.url()); });
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  await expectContentActionsOnly(row, item.subject);
  await expectNewTaskOnlyDrafts(page, request, row, item.subject, sent.id, item.id);
  expect(searches).toEqual([]);
});

// A create's own response can only be lost for a letter stored before 2026-11-02 (5a28ae6c9); its
// web Retry runs the same execute path, so that is where a lost response is reconciled.
test('lost retry response reconciles a single task and pending Close does not cancel work', async ({ page, request }) => {
  test.setTimeout(90_000);
  const item = mailItem('timing-create');
  const sent = await sendLegacyItems(request, [item]);
  const { failed, repair } = await failedLegacyStart(request, sent.id, item.id, 'Review this exact timing source.');
  await repair();
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  await row.getByRole('button', { name: /^Retry start for/ }).click();
  await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  let release!: () => void; let arrived!: () => void; let writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }); const arrival = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/human-inbox/${sent.id}/items/timing-create/execute`, async route => {
    writes++; await route.fetch(); arrived(); await gate; await route.abort('failed');
  });
  try {
    await row.getByRole('button', { name: 'Confirm and start', exact: true }).click();
    await expect(row.locator('.hii-confirm-footer')).toContainText('Creating…');
    await row.locator('.hii-confirm').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(row.locator('.hii-confirm')).toHaveCount(0);
    await arrival; release();
    await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
    expect(writes).toBe(1);
    const saved = await receipt(request, sent.id, 'timing-create');
    const taskIds = new Set(saved.receipts.filter((r: { taskId?: string }) => r.taskId).map((r: { taskId: string }) => r.taskId));
    expect([...taskIds]).toEqual([failed.taskId]);
    const sourceCopy = { ...mailItem('timing-copy'), source: item.source };
    const other = await sendItems(request, [sourceCopy]);
    const copy = await receipt(request, other.id, 'timing-copy');
    expect(copy.receipts.at(-1).taskId).toBe(failed.taskId);
    const list = await (await request.get('/api/v1/tasks')).json();
    expect(list.tasks.filter((task: { id: string }) => task.id === failed.taskId)).toHaveLength(1);
  } finally { release(); }
});
