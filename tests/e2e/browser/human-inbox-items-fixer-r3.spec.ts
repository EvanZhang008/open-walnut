import { test, expect } from '@playwright/test';
import { EVIDENCE, expectContentActionsOnly, failedLegacyStart, home, itemRow, mailItem, openLetter, receipt, sendItems, sendLegacyItems, watchTaskMutations } from './inbox-items-helpers';
import { draftComposer } from './draft-helpers';
import fs from 'node:fs/promises';
import { cssColorToRgba } from './css-color';

// The task chooser this test drove is gone with every email item's task intents (2026-11-02,
// 5a28ae6c9). What a long letter's item offers now, by keyboard too, is Talk to CEO and New task.
test('a long letter\'s items offer no task chooser: Talk to CEO and New task by keyboard, and New task only opens a draft', async ({ page, request }) => {
  const items = Array.from({ length: 20 }, (_, n) => mailItem(`return-${n}`));
  const sent = await sendItems(request, items);
  await home(page); const view = await openLetter(page, sent.subject);
  const row = itemRow(view, 'return-12'); await row.scrollIntoViewIfNeeded();
  await expectContentActionsOnly(row, items[12].subject);
  await expect(page.getByRole('dialog', { name: 'Choose a task', exact: true })).toHaveCount(0);
  // Keyboard order inside the item: Mark read, then the two content actions.
  // locator.press focuses the button and types in one step, so a late focus move in the reader
  // (its reply box) cannot land between them.
  const talk = row.getByRole('button', { name: `Talk to CEO: ${items[12].subject}`, exact: true });
  const newTask = row.getByRole('button', { name: `New task: ${items[12].subject}`, exact: true });
  await expect(async () => {
    await row.getByRole('button', { name: `Mark read for ${items[12].subject}`, exact: true }).press('Tab');
    await expect(talk).toBeFocused({ timeout: 1_000 });
    await talk.press('Tab');
    await expect(newTask).toBeFocused({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const before = new Set(((await (await request.get('/api/v1/tasks')).json()).tasks as Array<{ id: string }>).map(t => t.id));
  const mutations = watchTaskMutations(page);
  await newTask.press('Enter');
  await expect.poll(() => draftComposer(page).inputValue(), { timeout: 30_000 }).toContain(items[12].subject);
  expect(mutations).toEqual([]);
  const after = (await (await request.get('/api/v1/tasks')).json()).tasks as Array<{ id: string; title?: string }>;
  expect(after.filter(t => !before.has(t.id) && (t.title ?? '').includes(items[12].subject))).toEqual([]);
  expect((await receipt(request, sent.id, 'return-12')).receipts).toHaveLength(0);
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
      const channels = cssColorToRgba(text).slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
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

// Existing users keep letters stored before 2026-11-02 (5a28ae6c9) with their create_task, and a
// start of one that failed is retried from the web: that path stays real.
test('a stored letter\'s start failure stays local and retry keeps technical launch data in details', async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const item = mailItem('start-recovery');
  const sent = await sendLegacyItems(request, [item, mailItem('neighbor')]);
  await home(page); const row = itemRow(await openLetter(page, sent.subject), item.id);
  await row.getByRole('button', { name: /^Mark read for/ }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Marked read');
  const { failed, repair } = await failedLegacyStart(request, sent.id, item.id, 'Retry this approved goal only.');
  await row.getByRole('button', { name: `Check status for ${item.subject}`, exact: true }).click();
  await expect(row.locator('.hii-receipts')).toContainText('Could not start', { timeout: 25_000 });
  await expect(page.getByText("Couldn't start a session", { exact: true })).toHaveCount(0);
  await expect(page.getByText('A session hit an error', { exact: true })).toHaveCount(0);
  const feed = await (await request.get('/api/notifications')).json();
  expect(JSON.stringify(feed)).not.toContain(failed.taskId);
  await expectContentActionsOnly(row, item.subject);
  await repair();
  await row.getByRole('button', { name: /^Retry start for/ }).click();
  await expect(row.getByLabel('Work goal', { exact: true })).toHaveValue('Retry this approved goal only.');
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
  expect((await receipt(request, sent.id, item.id)).receipts.filter((r: any) => r.taskId).every((r: any) => r.taskId === failed.taskId)).toBe(true);
});
