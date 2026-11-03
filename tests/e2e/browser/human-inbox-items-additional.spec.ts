import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
const EVIDENCE = process.env.PW_RESULT_DIR ?? '/tmp/inbox-item-actions/fixer-r1';
import { expectContentActionsOnly, expectNewTaskOnlyDrafts, home, itemRow, mailItem, openLetter, receipt, sendItems, watchTaskMutations } from './inbox-items-helpers';
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
  // What the letter's buttons could reach: a task, a tool, a mail action, an item's receipt or
  // execution. The app's own background writes (page visits, heartbeats, the read mark, logs)
  // land in this window too on a loaded runner, and are not the letter's doing (2026-11-02, CI).
  expect(mutation.filter(path => /\/tasks\b|\/execute|\/mail\b|\/receipts?\b|\/tools?\b|\/ops\//.test(path))).toEqual([]);
  await fs.writeFile(`${EVIDENCE}/${test.info().project.name}-sandbox.json`, JSON.stringify({ mutation }, null, 2));
  expect((await receipt(request, sent.id, 'sandbox-safe')).receipts).toHaveLength(0);
  await expect(view.locator('.hii-actions button')).toHaveCount(3);
});

// There is no create form on an email item since 2026-11-02 (5a28ae6c9): New task opens the normal
// draft on Home, and nothing is made until the person sends it.
test('an email item has no create form: New task opens a draft with no task or execute mutation', async ({ page, request }) => {
  const item = mailItem('cancel-zero');
  const sent = await sendItems(request, [item]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  await expectContentActionsOnly(row, item.subject);
  const mutations = watchTaskMutations(page);
  await expectNewTaskOnlyDrafts(page, request, row, item.subject, sent.id, item.id);
  await fs.writeFile(`${EVIDENCE}/${test.info().project.name}-cancel.json`, JSON.stringify({ mutations }, null, 2));
});
