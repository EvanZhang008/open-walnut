import { test, expect } from '@playwright/test';
import { createCandidate, EVIDENCE, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

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

test('creates and really starts only after approved goal and confirmation', async ({ page, request }, info) => {
  const sent = await sendItems(request, [mailItem('create-a')]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, 'create-a');
  await row.getByRole('button', { name: 'Create and start task for Email create-a', exact: true }).click();
  const form = row.locator('.hii-confirm');
  await expect(form.getByRole('button', { name: 'Confirm and start', exact: true })).toBeDisabled();
  await form.getByLabel('Work goal', { exact: true }).fill('Report the approved fixture status');
  await expect(form.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await form.locator('.hii-operation-details summary').click();
  await expect(form.locator('pre')).toContainText('task_create');
  await expect(form.locator('pre')).toContainText('task_start');
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-confirm.png`, scale: 'css' });
  await form.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
  const result = await receipt(request, sent.id, 'create-a'); const task = result.receipts.find((r: { intent: string }) => r.intent === 'create_task');
  const detail = await (await request.get(`/api/v1/tasks/${task.taskId}`)).json();
  expect(detail.task.description).toContain('Report the approved fixture status');
  expect(detail.task.description).not.toContain('Saved email summary');
  expect(detail.task.last_start.state).toBe('started');
});

test('task search and preview are read-only, have no preselection, and use the exact chosen ID', async ({ page, request }) => {
  const title = `Similar task ${Date.now()}`;
  const first = await createCandidate(request, title, '', 'Inspect the first system');
  const chosen = await createCandidate(request, title, '', 'Inspect the second system');
  const sent = await sendItems(request, [mailItem('find-a')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'find-a');
  await row.getByRole('button', { name: 'Find task for Email find-a', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
  await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  await dialog.getByLabel('Search tasks', { exact: true }).fill(title);
  await expect(dialog.locator('.hii-candidate')).toHaveCount(2);
  const candidate = dialog.locator('.hii-candidate').filter({ hasText: chosen.id });
  await candidate.getByRole('button', { name: 'Preview task', exact: false }).click();
  await expect(dialog.locator('.hii-task-description')).toHaveText('Inspect the second system');
  await dialog.getByRole('button', { name: 'Back to tasks', exact: true }).click();
  await expect(dialog.getByLabel('Search tasks', { exact: true })).toHaveValue(title);
  await candidate.locator('.hii-candidate-pick').click();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  const form = row.locator('.hii-confirm');
  await form.getByLabel('Work goal', { exact: true }).fill('Report only the selected system');
  await expect(form.getByRole('button', { name: 'Confirm attachment', exact: true })).toBeEnabled();
  await form.locator('.hii-operation-details summary').click();
  await expect(form.locator('pre')).toContainText(chosen.id);
  await expect(form.locator('pre')).not.toContainText(first.id);
  expect((await receipt(request, sent.id, 'find-a')).receipts).toHaveLength(0);
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await receipt(request, sent.id, 'find-a')).receipts).toHaveLength(0);
});

test('old AI decisions keep their original payload and the session entry uses the same reader', async ({ page, request }) => {
  const sent = await sendItems(request, [mailItem('legacy-item')], { type: 'action_required',
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

test('untrusted HTML cannot create host actions and complete tasks remain refused', async ({ page, request }) => {
  const task = await createCandidate(request, `Completed candidate ${Date.now()}`, '', 'Review completed work');
  const completed = await request.post(`/api/v1/tasks/${task.id}/complete`, { data: {} }); expect(completed.ok()).toBeTruthy();
  const sent = await sendItems(request, [mailItem('safe-item')], { markdown: undefined,
    html: '<p>Untrusted email</p><button onclick="fetch(\'/api/v1/tasks\',{method:\'POST\'})">Run task_create</button><script>parent.document.body.remove()</script>' });
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'safe-item');
  await expect(page.locator('.hii-actions button')).toHaveCount(3);
  await row.getByRole('button', { name: 'Find task for Email safe-item', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
  await dialog.getByLabel('Search tasks', { exact: true }).fill(task.id);
  await expect(dialog.locator('.hii-candidate')).toHaveCount(1);
  await dialog.locator('.hii-candidate-pick').click();
  await expect(dialog).toContainText('Completed');
  await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect((await receipt(request, sent.id, 'safe-item')).receipts).toHaveLength(0);
});
