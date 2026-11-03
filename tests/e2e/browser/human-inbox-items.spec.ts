import { test, expect } from '@playwright/test';
import { createCandidate, EVIDENCE, expectContentActionsOnly, expectNewTaskOnlyDrafts, home, itemRow, mailItem, openLetter, receipt, runLegacyCreate, sendItems, sendLegacyItems, settledCreate } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('info items independently mark exact mail read and agent reply owns its own items', async ({ page, request }, info) => {
  const sent = await sendItems(request, [mailItem('read-a'), mailItem('read-b')]);
  await home(page); const view = await openLetter(page, sent.subject);
  const a = itemRow(view, 'read-a');
  await a.getByRole('button', { name: 'Mark read for Email read-a', exact: true }).click();
  await expect(a.locator('.hii-receipts')).toContainText('Marked read');
  expect((await receipt(request, sent.id, 'read-a')).receipts[0].source).toEqual(mailItem('read-a').source);
  const reply = await request.post(`/api/v1/human-inbox/${sent.id}/reply`, { data: { text: 'New email', items: [mailItem('reply-a')] } });
  expect(reply.ok(), await reply.text()).toBeTruthy();
  await expect(view.locator('.hib-thread .hii-item')).toHaveCount(1);
  await expect(view.locator('.hii-item[data-item-id="read-a"]')).toHaveCount(1);
  await expect(a.locator('.hii-receipts')).toContainText('Marked read');
  await expect(view.locator('.hib-answered')).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-independent.png`, scale: 'css' });
});

// Since 2026-11-02 (5a28ae6c9) nothing turns an email into a task by itself: a new letter's items
// offer Talk to CEO and New task. Letters stored before keep their create_task, which an older phone
// still runs; the web shows what that did.
test('a stored letter\'s create runs only the approved goal for an older client, and the web shows its start but offers no create', async ({ page, request }, info) => {
  const item = mailItem('create-a');
  const sent = await sendLegacyItems(request, [item]);
  const plan = await runLegacyCreate(request, sent.id, item.id, { goal: 'Report the approved fixture status' });
  expect((await settledCreate(request, sent.id, item.id)).status).toBe('success');
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
  await expect(row.locator('.hii-receipts').getByRole('button', { name: 'Open task', exact: true })).toBeVisible();
  await expectContentActionsOnly(row, item.subject);
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-legacy-started.png`, scale: 'css' });
  const result = await receipt(request, sent.id, item.id); const task = result.receipts.find((r: { intent: string }) => r.intent === 'create_task');
  expect(task.taskId).toBe(plan.taskId);
  const detail = await (await request.get(`/api/v1/tasks/${task.taskId}`)).json();
  expect(detail.task.description).toContain('Report the approved fixture status');
  expect(detail.task.description).not.toContain('Saved email summary');
  expect(detail.task.last_start.state).toBe('started');
});

test('an email item offers no task search or preview: Talk to CEO and New task instead, and New task only opens a draft', async ({ page, request }) => {
  const item = mailItem('find-a');
  const sent = await sendItems(request, [item]);
  const stored = await (await request.get(`/api/v1/human-inbox/${sent.id}`)).json();
  // The server drops the task intents a sender still lists (src/core/human-inbox/item-schema.ts).
  expect(stored.letter.items[0].actions.map((a: { intent?: string }) => a.intent)).toEqual(['mark_read']);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  await expectContentActionsOnly(row, item.subject);
  await expect(page.getByRole('dialog', { name: 'Choose a task', exact: true })).toHaveCount(0);
  await expectNewTaskOnlyDrafts(page, request, row, item.subject, sent.id, item.id);
});

test('old AI decisions keep their original payload and the session entry uses the same reader', async ({ page, request }) => {
  const sent = await sendItems(request, [mailItem('legacy-item')], { type: 'action_required', user_kind: 'user_own', user_kind_why: 'The spec plays a decision only the user makes',
    actions: [{ id: 'legacy-create', label: 'Create task' }, { id: 'legacy-read', label: 'Mark read' }] }, 'pw-mode-test-session');
  await home(page); const view = await openLetter(page, sent.subject);
  await expect(view.locator('.hib-actions-head')).toHaveText('Ask AI decision');
  await expect(view.locator('.hib-action-label').first()).toHaveText('Ask AI: Create task');
  await view.getByRole('button', { name: /Open session/ }).click();
  const embedded = page.locator('.session-inbox-pane .hib-view');
  await expect(embedded.locator('.hib-actions-head')).toHaveText('Ask AI decision');
  await expect(embedded.locator('.hii-item')).toHaveCount(1);
  await embedded.locator('.hib-action-btn').filter({ hasText: 'Ask AI: Mark read' }).click();
  await expect(embedded.locator('.hib-answered')).toContainText('Answered: Mark read');
  const detail = await (await request.get(`/api/v1/human-inbox/${sent.id}`)).json();
  expect(detail.letter.answered.actionId).toBe('legacy-read');
  expect(detail.letter.answered.label).toBe('Mark read');
  expect((await receipt(request, sent.id, 'legacy-item')).receipts).toHaveLength(0);
});

test('untrusted HTML cannot create host actions and a stored letter cannot attach to a completed task', async ({ page, request }) => {
  const task = await createCandidate(request, `Completed candidate ${Date.now()}`, '', 'Review completed work');
  const completed = await request.post(`/api/v1/tasks/${task.id}/complete`, { data: {} }); expect(completed.ok()).toBeTruthy();
  const item = mailItem('safe-item');
  const sent = await sendLegacyItems(request, [item], { markdown: undefined,
    html: '<p>Untrusted email</p><button onclick="fetch(\'/api/v1/tasks\',{method:\'POST\'})">Run task_create</button><script>parent.document.body.remove()</script>' });
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  // Mark read, Talk to CEO and New task: the stored find and create intents show no button.
  await expect(row.locator('.hii-actions button')).toHaveCount(3);
  await expectContentActionsOnly(row, item.subject);
  // An older client asking to attach this email to the completed task is refused before any plan.
  const prepared = await request.post(`/api/v1/human-inbox/${sent.id}/items/${item.id}/prepare`, { data: { actionId: `find-${item.id}`, selectedTaskId: task.id, goal: 'Reopen completed work' } });
  const body = await prepared.json();
  expect(body.plan, JSON.stringify(body)).toBeUndefined();
  expect(JSON.stringify(body.restrictions ?? body)).toMatch(/complete/i);
  expect((await receipt(request, sent.id, item.id)).receipts).toHaveLength(0);
});
