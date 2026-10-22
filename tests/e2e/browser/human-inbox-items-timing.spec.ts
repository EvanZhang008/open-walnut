import { test, expect } from '@playwright/test';
import { createCandidate, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('a late old search result cannot replace the new exact query', async ({ page, request }) => {
  const token = `Timing search ${Date.now()}`;
  const old = await createCandidate(request, `${token} old`); const next = await createCandidate(request, `${token} next`);
  const sent = await sendItems(request, [mailItem('timing-search')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'timing-search');
  let release!: () => void; let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const arrival = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/human-inbox/${sent.id}/items/timing-search/tasks?*`, async route => {
    if (new URL(route.request().url()).searchParams.get('query') !== old.id) return route.continue();
    const response = await route.fetch(); arrived(); await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await row.getByRole('button', { name: /^Find task for/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
    await dialog.getByLabel('Search tasks', { exact: true }).fill(old.id); await arrival;
    await dialog.getByLabel('Search tasks', { exact: true }).fill(next.id);
    await expect(dialog.locator('.hii-candidate')).toHaveCount(1);
    await expect(dialog.locator('.hii-candidate')).toContainText(next.title);
    release();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(dialog.locator('.hii-candidate')).toContainText(next.title);
    await expect(dialog.locator('.hii-candidate')).not.toContainText(old.title);
    await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await receipt(request, sent.id, 'timing-search')).receipts).toHaveLength(0);
  } finally { release(); }
});

test('lost create response reconciles a single task and pending Close does not cancel work', async ({ page, request }) => {
  test.setTimeout(60_000);
  const sent = await sendItems(request, [mailItem('timing-create')]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, 'timing-create');
  await row.getByRole('button', { name: /^Create and start task for/ }).click();
  await row.getByLabel('Work goal', { exact: true }).fill('Review this exact timing source.');
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
    const saved = await receipt(request, sent.id, 'timing-create');
    expect(saved.receipts).toHaveLength(1); expect(writes).toBe(1);
    const taskId = saved.receipts[0].taskId;
    const sourceCopy = { ...mailItem('timing-copy'), source: mailItem('timing-create').source };
    const other = await sendItems(request, [sourceCopy]);
    const copy = await receipt(request, other.id, 'timing-copy');
    expect(copy.receipts[0].taskId).toBe(taskId);
    const list = await (await request.get('/api/v1/tasks')).json();
    expect(list.tasks.filter((task: { id: string }) => task.id === taskId)).toHaveLength(1);
  } finally { release(); }
});
