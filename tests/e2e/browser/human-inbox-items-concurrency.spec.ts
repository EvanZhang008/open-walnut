import { test, expect } from '@playwright/test';
import { createCandidate, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

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

test('attaches to one exact task, then queues different email work to its existing conversation', async ({ page, request }) => {
  const title = `Attach exact task ${Date.now()}`;
  const task = await createCandidate(request, title, '', 'Original task work goal');
  const other = await createCandidate(request, title, '', 'Other task work goal');
  const sent = await sendItems(request, [mailItem('attach-start'), mailItem('attach-send')]);
  await home(page); const view = await openLetter(page, sent.subject);
  for (const [id, goal, operation] of [['attach-start', 'Inspect the selected system', 'task_start'], ['attach-send', 'Report the follow-up result', 'task_send']]) {
    const row = itemRow(view, id);
    await row.getByRole('button', { name: `Find task for Email ${id}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
    await dialog.getByLabel('Search tasks', { exact: true }).fill(task.id);
    const choice = dialog.locator('.hii-candidate').filter({ hasText: task.id });
    await expect(choice).toHaveCount(1);
    await choice.locator('.hii-candidate-pick').click();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    const form = row.locator('.hii-confirm');
    await form.getByLabel('Work goal', { exact: true }).fill(goal);
    await expect(form.getByRole('button', { name: 'Confirm attachment', exact: true })).toBeEnabled();
    await form.locator('.hii-operation-details summary').click();
    await expect(form.locator('pre')).toContainText(operation);
    await expect(form.locator('pre')).toContainText(task.id);
    await expect(form.locator('pre')).not.toContainText(other.id);
    await form.getByRole('button', { name: 'Confirm attachment', exact: true }).click();
    await expect(row.locator('.hii-receipts')).toContainText(operation === 'task_start' ? 'Started' : 'Work queued', { timeout: 25_000 });
    const result = await receipt(request, sent.id, id);
    expect(result.receipts.at(-1).taskId).toBe(task.id);
    await form.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const untouched = await (await request.get(`/api/v1/tasks/${other.id}`)).json();
  expect(untouched.task.last_start).toBeUndefined();
});
