import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
const EVIDENCE = process.env.PW_RESULT_DIR ?? '/tmp/inbox-item-actions/fixer-r1';
import { home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';
test.describe.configure({ mode: 'serial' });

test('new reply items appear once in both clients without changing the original receipt', async ({ page, browser, request }) => {
  const sent = await sendItems(request, [mailItem('reply-original')]);
  const peerContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    const peer = await peerContext.newPage();
    await home(page); await home(peer);
    const first = await openLetter(page, sent.subject); const second = await openLetter(peer, sent.subject);
    await itemRow(first, 'reply-original').getByRole('button', { name: /^Mark read for/ }).click();
    await expect(itemRow(second, 'reply-original').locator('.hii-receipts')).toContainText('Marked read');
    const before = (await receipt(request, sent.id, 'reply-original')).receipts;
    const result = await request.post(`/api/v1/human-inbox/${sent.id}/reply`, { data: { text: 'A separate saved email.', items: [mailItem('reply-new')] } });
    expect(result.ok()).toBe(true);
    for (const view of [first, second]) {
      await expect(view.locator('.hib-thread .hii-item[data-item-id="reply-new"]')).toHaveCount(1);
      await expect(view.locator('.hii-item[data-item-id="reply-original"]')).toHaveCount(1);
    }
    expect((await receipt(request, sent.id, 'reply-original')).receipts).toEqual(before);
    await itemRow(first, 'reply-new').scrollIntoViewIfNeeded();
    await itemRow(second, 'reply-new').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/shots/${test.info().project.name}-reply-client-a.png`, scale: 'css' });
    await peer.screenshot({ path: `${EVIDENCE}/shots/${test.info().project.name}-reply-client-b.png`, scale: 'css' });
    await fs.writeFile(`${EVIDENCE}/${test.info().project.name}-reply.json`, JSON.stringify({ before, after: (await receipt(request, sent.id, 'reply-original')).receipts }, null, 2));
  } finally { await peerContext.close(); }
});

test('clicking malicious sandbox controls sends no host or provider mutation', async ({ page, request }) => {
  const sent = await sendItems(request, [mailItem('sandbox-safe')], { markdown: undefined,
    html: '<p>Saved email text</p><button onclick="fetch(\'/api/v1/tasks\',{method:\'POST\'})">Run task_create</button><button onclick="parent.postMessage({tool:\'mail_mark_read\'},\'*\')">Run mail_mark_read</button>' });
  await home(page); const view = await openLetter(page, sent.subject);
  await expect(itemRow(view, 'sandbox-safe').getByRole('button', { name: /^Mark read for/ })).toBeEnabled();
  const mutation: string[] = [];
  page.on('request', req => { if (req.method() !== 'GET') mutation.push(`${req.method()} ${new URL(req.url()).pathname}`); });
  const frame = view.frameLocator('.hib-html-frame');
  await frame.getByRole('button', { name: 'Run task_create', exact: true }).click();
  await frame.getByRole('button', { name: 'Run mail_mark_read', exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(mutation.filter(path => !path.includes('/api/browser-logs'))).toEqual([]);
  await fs.writeFile(`${EVIDENCE}/${test.info().project.name}-sandbox.json`, JSON.stringify({ mutation }, null, 2));
  expect((await receipt(request, sent.id, 'sandbox-safe')).receipts).toHaveLength(0);
  await expect(view.locator('.hii-actions button')).toHaveCount(3);
});

test('canceling a prepared create form has no task or execute mutation', async ({ page, request }) => {
  const sent = await sendItems(request, [mailItem('cancel-zero')]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, 'cancel-zero');
  const before = await (await request.get('/api/v1/tasks')).json();
  const mutations: string[] = [];
  page.on('request', req => { if (req.method() !== 'GET' && /\/tasks|\/execute/.test(new URL(req.url()).pathname)) mutations.push(req.url()); });
  await row.getByRole('button', { name: /^Create and start task for/ }).click();
  await row.getByLabel('Work goal', { exact: true }).fill('Only prepare this goal.');
  await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mutations).toEqual([]);
  expect((await receipt(request, sent.id, 'cancel-zero')).receipts).toHaveLength(0);
  const after = await (await request.get('/api/v1/tasks')).json();
  expect(after.tasks).toEqual(before.tasks);
  await fs.writeFile(`${EVIDENCE}/${test.info().project.name}-cancel.json`, JSON.stringify({ beforeCount: before.tasks.length, afterCount: after.tasks.length, mutations }, null, 2));
});
