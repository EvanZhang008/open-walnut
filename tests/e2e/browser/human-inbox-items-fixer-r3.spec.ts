import { test, expect } from '@playwright/test';
import { EVIDENCE, createCandidate, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';
import fs from 'node:fs/promises';

test('task navigation and keyboard preview preserve exact selection, scroll and unconfirmed goal', async ({ page, request }, info) => {
  const prefix = `Review navigation ${info.project.name}-${Date.now()}`;
  const task = await createCandidate(request, `${prefix} target`, 'Review', 'Compare the saved target context.');
  for (let n = 0; n < 18; n++) await createCandidate(request, `${prefix} neighbor ${n}`, 'Review');
  const sent = await sendItems(request, Array.from({ length: 20 }, (_, n) => mailItem(`return-${n}`)));
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'return-0');
  let mutations = 0;
  page.on('request', r => { if (r.method() !== 'GET' && /\/execute|\/tasks\/[^/]+\/(start|send)/.test(r.url())) mutations++; });
  await row.getByRole('button', { name: /^Find task for/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
  await dialog.getByLabel('Search tasks', { exact: true }).fill(prefix);
  await expect(dialog.locator('.hii-candidate')).toHaveCount(19);
  const candidate = dialog.locator('.hii-candidate').filter({ hasText: task.id });
  await candidate.locator('.hii-candidate-pick').click();
  const scroll = await dialog.locator('.hii-selector-list').evaluate(el => el.scrollTop);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await row.getByLabel('Work goal', { exact: true }).fill('Keep this exact human goal while reviewing.');
  await row.getByRole('button', { name: 'Choose another task', exact: true }).click();
  const preview = candidate.getByRole('button', { name: /^Preview task/ });
  await preview.click(); await expect(dialog).toContainText('Compare the saved target context.');
  await dialog.getByRole('button', { name: 'Back to tasks', exact: true }).press('Enter');
  await expect(preview).toBeFocused();
  await preview.click(); await dialog.getByRole('button', { name: 'Open task', exact: true }).click();
  // A task opens on Home with its row selected, never the separate task page (2026-10-26).
  await expect(page.locator(`[data-task-id="${task.id}"].task-focused, [data-task-id="${task.id}"].todo-pinned-card-active`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/tasks\//);
  await page.goBack();
  await fs.writeFile(`${EVIDENCE}/${info.project.name}-return-debug.json`, JSON.stringify(await page.evaluate(() => ({ history: window.history.state, url: location.href, dialogs: document.querySelectorAll('.hii-selector').length, readers: document.querySelectorAll('.hib-reader').length, panel: !!document.querySelector('.notification-panel') })), null, 2));
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.hii-task-description')).toContainText('Compare the saved target context.');
  await dialog.getByRole('button', { name: 'Back to tasks', exact: true }).press('Enter');
  await expect(preview).toBeFocused();
  await expect(dialog.getByLabel('Search tasks', { exact: true })).toHaveValue(prefix);
  await expect(dialog.locator('footer')).toContainText(task.title);
  await expect(candidate.locator('.hii-candidate-pick')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => dialog.locator('.hii-selector-list').evaluate(el => el.scrollTop)).toBe(scroll);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(row.getByLabel('Work goal', { exact: true })).toHaveValue('Keep this exact human goal while reviewing.');
  expect((await receipt(request, sent.id, 'return-0')).receipts).toHaveLength(0);
  expect(mutations).toBe(0);
  await row.getByLabel('Work goal', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/shots/${info.project.name}-restored-draft.png`, scale: 'css' });
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await row.getByRole('button', { name: /^Find task for/ }).click();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(row.getByLabel('Work goal', { exact: true })).toHaveValue('');
});

test('selected Inbox rail stays readable in explicit light and dark themes', async ({ page, request }, info) => {
  const sent = await sendItems(request, [mailItem('contrast')]);
  await home(page); await openLetter(page, sent.subject);
  await page.getByRole('button', { name: 'Close letter', exact: true }).click();
  const rail = page.locator('.nfc-rail-btn.nfc-active').filter({ hasText: 'Inbox' });
  const values = [];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const colors = await rail.evaluate(el => {
      const css = getComputedStyle(el);
      return { foreground: css.color, background: css.backgroundColor, token: css.getPropertyValue('--bg-secondary') };
    });
    const luminance = (text: string) => {
      const channels = text.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const a = luminance(colors.foreground); const b = luminance(colors.background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    await fs.writeFile(`${EVIDENCE}/${info.project.name}-${theme}-contrast-debug.json`, JSON.stringify({ ...colors, ratio }, null, 2));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    values.push({ theme, ...colors, ratio });
    await page.screenshot({ path: `${EVIDENCE}/shots/${info.project.name}-inbox-${theme}.png`, scale: 'css' });
  }
  await fs.writeFile(`${EVIDENCE}/${info.project.name}-contrast.json`, JSON.stringify(values, null, 2));
});

test('item start failure stays local and retry keeps technical launch data in details', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  await createCandidate(request, 'Seed failed launch project', 'Retry fixture');
  expect((await request.put('/api/v1/projects/Retry%20fixture/metadata', { data: { default_cwd: '/missing/fixture-directory' } })).ok()).toBe(true);
  const sent = await sendItems(request, [mailItem('start-recovery'), mailItem('neighbor')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), 'start-recovery');
  await row.getByRole('button', { name: /^Mark read for/ }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
  await row.getByRole('button', { name: /^Create and start task for/ }).click();
  await row.getByRole('group', { name: 'Project', exact: true }).getByRole('button', { name: 'Retry fixture', exact: true }).click();
  await row.getByLabel('Work goal', { exact: true }).fill('Retry this approved goal only.');
  await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await row.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Could not start', { timeout: 25_000 });
  const failed = (await receipt(request, sent.id, 'start-recovery')).receipts.find((r: any) => r.intent === 'create_task');
  await expect(page.getByText("Couldn't start a session", { exact: true })).toHaveCount(0);
  await expect(page.getByText('A session hit an error', { exact: true })).toHaveCount(0);
  const feed = await (await request.get('/api/notifications')).json();
  expect(JSON.stringify(feed)).not.toContain(failed.taskId);
  await row.getByRole('button', { name: 'Close', exact: true }).click();
  expect((await request.put('/api/v1/projects/Retry%20fixture/metadata', { data: { default_cwd: null } })).ok()).toBe(true);
  await row.getByRole('button', { name: /^Retry start for/ }).click();
  await expect(row.getByRole('button', { name: 'Confirm and start', exact: true })).toBeEnabled();
  await expect(row.locator('.hii-existing')).not.toContainText('Source email');
  await expect(row.locator('.hii-existing')).not.toContainText('fixture-account-a');
  await expect(row.locator('.hii-confirm')).toContainText('Fresh launch: On this Mac.');
  expect((await row.locator('.hii-confirm > p').allTextContents()).join(' ')).not.toContain('__local__');
  await row.locator('.hii-operation-details summary').click();
  await expect(row.locator('.hii-operation-details')).toContainText('__local__');
  await page.screenshot({ path: `${EVIDENCE}/shots/${info.project.name}-retry-details.png`, scale: 'css' });
  await row.getByRole('button', { name: 'Confirm and start', exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Started', { timeout: 25_000 });
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
  expect((await receipt(request, sent.id, 'start-recovery')).receipts.filter((r: any) => r.taskId).every((r: any) => r.taskId === failed.taskId)).toBe(true);
});
