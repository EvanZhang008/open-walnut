import { test, expect } from '@playwright/test';
import { createCandidate, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

test('a second reader recovers a lost aliased mail response without another provider operation', async ({ page, context, request }) => {
  const first = mailItem('alias-first', 'delay-');
  const second = { ...mailItem('alias-second'), source: first.source };
  const a = await sendItems(request, [first]); const b = await sendItems(request, [second]);
  const peer = await context.newPage();
  try {
    await home(page); await home(peer);
    const one = itemRow(await openLetter(page, a.subject), first.id);
    const two = itemRow(await openLetter(peer, b.subject), second.id);
    let lostWrites = 0;
    await peer.route(`**/human-inbox/${b.id}/items/${second.id}/execute`, async route => {
      lostWrites++; await route.fetch(); await route.abort('failed');
    });
    await one.getByRole('button', { name: /^Mark read for/ }).click();
    await two.getByRole('button', { name: /^Mark read for/ }).click();
    await expect(one.locator('.hii-receipts')).toContainText('Marked read', { timeout: 15_000 });
    await expect(two.locator('.hii-receipts')).toContainText('Marked read', { timeout: 15_000 });
    await expect(two.locator('.hii-receipts')).not.toContainText('Status unconfirmed');
    const state = await receipt(request, b.id, second.id);
    expect(state.receipts).toHaveLength(1); expect(state.receipts[0].requestIds).toHaveLength(2);
    expect(lostWrites).toBe(1);
  } finally { await peer.close(); }
});

test('a new letter retries the same task using its own action ID after the launch is repaired', async ({ page, request }) => {
  test.setTimeout(90_000);
  const project = `Retry ${Date.now()}`;
  await createCandidate(request, 'Seed retry project', project);
  expect((await request.put(`/api/v1/projects/${encodeURIComponent(project)}/metadata`, { data: { default_cwd: '/missing/fixture-reviewed-retry' } })).ok()).toBe(true);
  const original = mailItem('cross-original');
  const first = await sendItems(request, [original]);
  await home(page); let view = await openLetter(page, first.subject);
  const oldRow = itemRow(view, original.id);
  await oldRow.getByRole('button', { name: /^Create and start task for/ }).click();
  await oldRow.getByRole('group', { name: 'Project', exact: true }).getByRole('button', { name: project, exact: true }).click();
  await oldRow.getByLabel('Work goal', { exact: true }).fill('Review the approved update once');
  await expect(oldRow.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await oldRow.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(oldRow.locator('.hii-receipts')).toContainText('Could not start', { timeout: 25_000 });
  const failed = (await receipt(request, first.id, original.id)).receipts.find((r: any) => r.intent === 'create_task');
  await view.getByRole('button', { name: 'Close letter', exact: true }).click();
  expect((await request.put(`/api/v1/projects/${encodeURIComponent(project)}/metadata`, { data: { default_cwd: null } })).ok()).toBe(true);
  const current = { ...mailItem('cross-current'), source: original.source };
  const second = await sendItems(request, [current]);
  const center = page.locator('.notification-panel');
  await center.locator('.hib-row').filter({ hasText: second.subject }).locator('.hib-subject').click();
  view = page.locator('.hib-reader .hib-view'); const row = itemRow(view, current.id);
  await expect(row.getByRole('button', { name: /^Retry start for/ })).toBeEnabled();
  await row.getByRole('button', { name: /^Retry start for/ }).click();
  await expect(row.getByLabel('Work goal', { exact: true })).toHaveValue('Review the approved update once');
  await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
  const recovered = (await receipt(request, second.id, current.id)).receipts;
  expect(recovered.filter((r: any) => r.taskId).every((r: any) => r.taskId === failed.taskId)).toBe(true);
  expect(recovered.at(-1).actionId).toBe('create-cross-current');
});

test('two AI questions remain independent and never turn into mail or task operations', async ({ page, request }) => {
  const item = mailItem('two-questions');
  item.actions.push({ id: 'question-one', kind: 'reply_ai', label: 'Explain', question: 'Explain this source' },
    { id: 'question-two', kind: 'reply_ai', label: 'Compare', question: 'Compare this source' });
  const sent = await sendItems(request, [item]); await home(page);
  const row = itemRow(await openLetter(page, sent.subject), item.id);
  let operations = 0;
  page.on('request', req => { if (req.method() === 'POST' && /\/tasks(?:\/[^/]+\/start)?$|\/messages$/.test(new URL(req.url()).pathname)) operations++; });
  await row.getByRole('button', { name: /^Ask AI: Explain for/ }).click();
  await expect.poll(async () => (await receipt(request, sent.id, item.id)).receipts.filter((r: any) => r.intent === 'reply_ai' && r.status === 'success').length).toBe(1);
  await expect(row.getByRole('button', { name: /^Ask AI: Explain for/ })).toBeDisabled();
  await expect(row.getByRole('button', { name: /^Ask AI: Compare for/ })).toBeEnabled();
  await row.getByRole('button', { name: /^Ask AI: Compare for/ }).click();
  await expect.poll(async () => (await receipt(request, sent.id, item.id)).receipts.filter((r: any) => r.intent === 'reply_ai' && r.status === 'success').length).toBe(2);
  await expect(row.getByRole('button', { name: /^Mark read for/ })).toBeEnabled();
  await expect(row.getByRole('button', { name: /^Create and start task for/ })).toBeEnabled();
  expect(operations).toBe(0);
});
