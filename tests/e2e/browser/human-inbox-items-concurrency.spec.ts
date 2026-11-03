import { test, expect, type APIResponse } from '@playwright/test';
import { createCandidate, expectContentActionsOnly, home, itemRow, mailItem, openLetter, receipt, sendItems, sendLegacyItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('two independent clients confirm one exact read without a second provider attempt', async ({ browser, page, request }) => {
  const sent = await sendItems(request, [mailItem('two-client-a', 'delay-')]);
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const peer = await context.newPage();
  try {
    await home(page); await home(peer);
    const a = itemRow(await openLetter(page, sent.subject), 'two-client-a');
    const b = itemRow(await openLetter(peer, sent.subject), 'two-client-a');
    await expect(a.getByRole('button', { name: 'Mark read for Email two-client-a', exact: true })).toBeEnabled();
    await expect(b.getByRole('button', { name: 'Mark read for Email two-client-a', exact: true })).toBeEnabled();
    await Promise.all([
      a.getByRole('button', { name: 'Mark read for Email two-client-a', exact: true }).click(),
      b.getByRole('button', { name: 'Mark read for Email two-client-a', exact: true }).click(),
    ]);
    await expect(a.locator('.hii-receipts')).toContainText('Marked read');
    await expect(b.locator('.hii-receipts')).toContainText('Marked read');
    expect((await receipt(request, sent.id, 'two-client-a')).receipts).toHaveLength(1);
  } finally { await context.close(); }
});

// A new letter's item has no Find task since 2026-11-02 (5a28ae6c9); a stored letter's find_task is
// still run by an older phone, and it must reach exactly the task that phone chose.
test('a stored letter attaches to one exact task for an older client, then queues different email work to its conversation', async ({ page, request }) => {
  const title = `Attach exact task ${Date.now()}`;
  const task = await createCandidate(request, title, '', 'Original task work goal');
  const other = await createCandidate(request, title, '', 'Other task work goal');
  const items = [mailItem('attach-start'), mailItem('attach-send')];
  const sent = await sendLegacyItems(request, items);
  for (const [item, goal, operation] of [[items[0], 'Inspect the selected system', 'task_start'], [items[1], 'Report the follow-up result', 'task_send']] as const) {
    const base = `/api/v1/human-inbox/${sent.id}/items/${item.id}`;
    // The first email's start keeps moving the task for a moment (its session settles, its turn
    // ends), and a plan prepared in that moment names the task as it was: execute refuses it with
    // task_changed before it claims anything, the product's "review the action again". Review it
    // again, as the user would (2026-11-03, CI 41604915386).
    let executed!: APIResponse;
    for (let review = 1; ; review++) {
      const prepared = await request.post(`${base}/prepare`, { data: { actionId: `find-${item.id}`, selectedTaskId: task.id, goal } });
      expect(prepared.ok(), await prepared.text()).toBeTruthy();
      const plan = (await prepared.json()).plan;
      const ops = JSON.stringify(plan.ops);
      expect(plan.ops.map((op: { tool: string }) => op.tool)).toContain(operation);
      expect(ops).toContain(task.id); expect(ops).not.toContain(other.id);
      executed = await request.post(`${base}/execute`, { data: { actionId: plan.actionId, requestId: `pw-attach-${item.id}-${Date.now()}`, confirmed: true, planId: plan.id, planVersion: plan.version } });
      if (review === 5 || executed.status() !== 409 || !(await executed.text()).includes('"task_changed"')) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(executed.status(), await executed.text()).toBeLessThan(300);
    // Settled before the next email: the second one's plan must see the task already running.
    await expect.poll(async () => { const last = (await receipt(request, sent.id, item.id)).receipts.at(-1); return last?.status === 'success' ? last.taskId : last?.status; }, { timeout: 25_000 }).toBe(task.id);
  }
  await home(page); const view = await openLetter(page, sent.subject);
  await expect(itemRow(view, 'attach-start').locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
  await expect(itemRow(view, 'attach-send').locator('.hii-receipts')).toContainText('Work queued', { timeout: 25_000 });
  for (const item of items) await expectContentActionsOnly(itemRow(view, item.id), item.subject);
  const untouched = await (await request.get(`/api/v1/tasks/${other.id}`)).json();
  expect(untouched.task.last_start).toBeUndefined();
});
