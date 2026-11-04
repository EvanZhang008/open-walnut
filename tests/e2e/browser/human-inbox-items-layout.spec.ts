import { test, expect } from '@playwright/test';
import { EVIDENCE, expectContentActionsOnly, expectNewTaskOnlyDrafts, home, itemRow, mailItem, openLetter, receipt, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
test('late receipt across pointer down and up keeps the lower item target stable', async ({ page, request }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const sent = await sendItems(request, [mailItem('layout-a'), mailItem('layout-b')]);
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
  // The lower item's own Mark read (its create button is gone since 5a28ae6c9): a late receipt
  // above it must not move it between pointer down and up, or the click lands elsewhere.
  const target = b.getByRole('button', { name: 'Mark read for Email layout-b', exact: true });
  await target.scrollIntoViewIfNeeded();
  const before = await target.boundingBox(); expect(before).toBeTruthy();
  await page.mouse.move(before!.x + 10, before!.y + 10); await page.mouse.down();
  release(); await expect(a.locator('.hii-receipts')).toContainText('Marked read');
  const after = await target.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect(b.locator('.hii-receipts')).toContainText('Marked read');
  expect((await receipt(request, sent.id, 'layout-b')).receipts.map((r: { intent: string }) => r.intent)).toEqual(['mark_read']);
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-pointer-stable.png`, scale: 'css' });
  await page.route(`**/human-inbox/${sent.id}/items/layout-b/execution`, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await b.getByRole('button', { name: 'Check status for Email layout-b', exact: true }).click();
  await expect(b.locator('.hii-receipts')).toContainText('Email actions need a newer server');
  await expectContentActionsOnly(b, 'Email layout-b');
});

// The task chooser is gone (5a28ae6c9). What stays: the item's own buttons in reach at a short
// window, and New task makes nothing.
test('an email item offers no task chooser at a short window: Talk to CEO and New task in reach, and New task makes nothing', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const item = mailItem('keyboard-a');
  const sent = await sendItems(request, [item]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  await expectContentActionsOnly(row, item.subject);
  const newTask = row.getByRole('button', { name: `New task: ${item.subject}`, exact: true });
  await newTask.scrollIntoViewIfNeeded();
  const box = await newTask.boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-keyboard.png`, scale: 'css' });
  await expectNewTaskOnlyDrafts(page, request, row, item.subject, sent.id, item.id);
});
