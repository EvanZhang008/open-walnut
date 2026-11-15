import { expect, test } from '@playwright/test';
import { loadHome } from './draft-helpers';
import { isolateUiPrefs } from './todo-panel-helpers';
import { discoverBrowserFixture } from './codex-test-audit';

test.setTimeout(180_000);
test('a linked review decision has one task ask and a lead-thread pointer that restores after owner changes', async ({ page, request }, testInfo) => {
  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const project = `One decision ${stamp}`;
  const made: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const create = async (title: string) => {
    const res = await request.post('/api/tasks', { data: { title, project, source: 'local' } });
    expect(res.ok(), await res.text()).toBe(true);
    const id = (await res.json()).task.id as string;
    made.push(id); return id;
  };
  const ask = 'Submit the Talos security review for public and private thread access?';
  try {
    const leadRes = await request.post('/api/v1/org/projects', { data: { name: project } });
    expect(leadRes.ok(), await leadRes.text()).toBe(true);
    const lead = (await leadRes.json()).task.id as string; made.push(lead);
    const owner = await create('Security review owner');
    const { fixtureRoot } = await discoverBrowserFixture(Number(process.env.PW_TEST_PORT ?? 3457));
    const start = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Ready.', taskId: lead } });
    expect(start.ok(), await start.text()).toBe(true);
    // Seed a thread before its task asks: exactly the order that bypassed the old write check.
    const thRes = await request.post(`/api/v1/tasks/${lead}/threads/open`, { data: { title: 'Thread read permission review', text: 'The request needs a security review.', from: 'task', state: 'needs', tasks: [owner] } });
    expect(thRes.ok(), await thRes.text()).toBe(true);
    const thread = (await thRes.json()).thread.id as string;
    const patch = await request.patch(`/api/v1/tasks/${lead}/threads/${thread}`, { data: { ask, reply: `${ask} The review covers both channel kinds.`, tasks: [owner] } });
    expect(patch.ok(), await patch.text()).toBe(true);
    const set = await request.put(`/api/v1/tasks/${owner}/report`, { data: { state: 'needs', ask, user_kind: 'outward', user_kind_why: 'The person decides this submission.' } });
    expect(set.ok(), await set.text()).toBe(true);
    await expect.poll(async () => (await (await request.get(`/api/tasks/${owner}`)).json()).task?.user_status?.state).toBe('needs');
    await isolateUiPrefs(page);
    await page.addInitScript(() => localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true'));
    await loadHome(page);
    await page.getByTestId('sidebar-org').click();
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click();
    const card = page.locator(`[data-testid="org-thread"][data-thread-id="${thread}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('Security review owner');
    await expect(card.getByTestId('org-thread-state')).not.toHaveText('Needs you');
    await expect(card.getByTestId('org-thread-reply')).toHaveCount(0);
    await expect(card.getByTestId('org-thread-task')).toHaveCount(0);
    await expect(card).not.toContainText(ask);
    await expect(page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`)).toContainText('Asked in Security review owner');
    // Ordinary user navigation, scrolling and opening the conversation keep the owning task intact.
    await card.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1100, height: 800 });
    await card.getByTestId('org-thread-history').click();
    await expect(card.getByTestId('org-thread-messages')).toBeVisible();
    await card.getByTestId('org-thread-history').click();
    await expect(card.getByTestId('org-thread-messages')).toHaveCount(0);
    const link = card.getByTestId('org-thread-asked-in-task');
    await expect(link).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('pointer-card.png') });
    await link.click();
    await expect.poll(async () => (await (await request.get(`/api/tasks/${owner}`)).json()).task?.user_status?.state).toBe('needs');
    await page.getByTestId('sidebar-org').click();
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click();
    const changed = await request.put(`/api/v1/tasks/${owner}/report`, { data: { state: 'needs', ask: 'Choose the launch date for another feature?', ask_id: 'new', user_kind: 'user_own', user_kind_why: 'A separate scheduling choice.' } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await expect.poll(async () => (await (await request.get(`/api/v1/tasks/${lead}/threads/${thread}`)).json()).thread?.askedIn).toBeUndefined();
    await expect(card.getByTestId('org-thread-state')).toHaveText('Needs you');
    await page.reload();
    await expect(card.getByTestId('org-thread-state')).toHaveText('Needs you');
    await expect(card.getByTestId('org-thread-reply')).toContainText(ask);
    await page.screenshot({ path: testInfo.outputPath('restored-ask.png') });
    expect(errors).toEqual([]);
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`);
  }
});
