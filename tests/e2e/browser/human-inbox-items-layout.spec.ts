import { test, expect } from '@playwright/test';
import { EVIDENCE, home, itemRow, mailItem, openLetter, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('late receipt across pointer down and up keeps the lower item target and goal stable', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const sent = await sendItems(request, [mailItem('layout-a', 'delay-'), mailItem('layout-b')]);
  await home(page); const view = await openLetter(page, sent.subject);
  await view.evaluate(el => { (el as HTMLElement).style.width = '320px'; });
  const a = itemRow(view, 'layout-a'); const b = itemRow(view, 'layout-b');
  let release!: () => void; let arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  await page.route(`**/human-inbox/${sent.id}/items/layout-a/prepare`, async route => {
    const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response });
  });
  page.on('close', () => release());
  await a.getByRole('button', { name: 'Mark read for Email layout-a', exact: true }).click();
  await arrival;
  const target = b.getByRole('button', { name: 'Create and start task for Email layout-b', exact: true });
  await target.scrollIntoViewIfNeeded();
  const before = await target.boundingBox(); expect(before).toBeTruthy();
  await page.mouse.move(before!.x + 10, before!.y + 10); await page.mouse.down();
  release(); await expect(a.locator('.hii-receipts')).toContainText('Marked read');
  const after = await target.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect(b.locator('.hii-confirm')).toBeVisible();
  await b.getByLabel('Work goal', { exact: true }).fill('Keep this human draft');
  await expect(b.getByLabel('Work goal', { exact: true })).toHaveValue('Keep this human draft');
  await b.getByLabel('Work goal', { exact: true }).press('End');
  await b.getByLabel('Work goal', { exact: true }).press('Enter');
  expect(await b.getByLabel('Work goal', { exact: true }).inputValue()).toContain('Keep this human draft');
  expect(await b.getByLabel('Work goal', { exact: true }).inputValue()).toContain('\n');
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-pointer-stable.png`, scale: 'css' });
  await page.route(`**/human-inbox/${sent.id}/items/layout-b/execution`, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await b.getByRole('button', { name: 'Check status for Email layout-b', exact: true }).click();
  await expect(b.locator('.hii-receipts')).toContainText('Email actions need a newer server');
  await expect(b.getByLabel('Work goal', { exact: true })).toHaveValue(/Keep this human draft/);
});

test('selector footer remains reachable and Escape closes only the current layer', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const sent = await sendItems(request, [mailItem('keyboard-a')]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, 'keyboard-a');
  await row.getByRole('button', { name: 'Find task for Email keyboard-a', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a task', exact: true });
  await expect(dialog.getByLabel('Search tasks', { exact: true })).toBeFocused();
  const footer = await dialog.locator('footer').boundingBox();
  expect(footer!.y + footer!.height).toBeLessThanOrEqual(700);
  await dialog.getByLabel('Search tasks', { exact: true }).press('Escape');
  await expect(dialog).toHaveCount(0); await expect(view).toBeVisible();
  await expect(row.getByRole('button', { name: 'Find task for Email keyboard-a', exact: true })).toBeFocused();
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-keyboard.png`, scale: 'css' });
});
