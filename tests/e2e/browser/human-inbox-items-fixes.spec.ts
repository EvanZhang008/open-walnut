import { test, expect } from '@playwright/test';
import { expectContentActionsOnly, expectNewTaskOnlyDrafts, home, itemRow, mailItem, openLetter, openMarkReadAgain, receipt, sendItems } from './inbox-items-helpers';
import { cssColorToRgba } from './css-color';
const SHOTS = process.env.PW_EVIDENCE_DIR ?? '/tmp/inbox-item-actions/fixer-r1/shots';
test.describe.configure({ mode: 'serial' });

test('compact initial rows hide empty task status and toggle only truncated summaries', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const items = Array.from({ length: 20 }, (_, n) => ({ ...mailItem(`fix-density-${n}`),
    summary: n === 19 ? 'Long summary for reading. '.repeat(50) : 'One short saved summary.',
    source: { kind: 'mail' as const, account: `fixture-account-${n % 2}`, message: `fixture-density-${n}` },
    display: { accountLabel: 'Mail', accountHint: `Mailbox ${n % 2}`, sender: { name: `Sender ${n}` }, sentAt: '2026-10-21T12:00:00Z' } }));
  const sent = await sendItems(request, items);
  await home(page); const view = await openLetter(page, sent.subject);
  const first = itemRow(view, items[0].id);
  await expect(first.getByRole('button', { name: /^Show more/ })).toHaveCount(0);
  await expect(first.locator('.hii-receipts')).not.toContainText('Current task status unavailable');
  await expect(first.locator('.hii-source')).toContainText('Mailbox 0');
  await expect(first.locator('.hii-source')).not.toContainText('fixture-account');
  expect((await first.boundingBox())!.height).toBeLessThan(245);
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-compact-light.png`, scale: 'css' });
  const long = itemRow(view, items[19].id);
  await long.getByRole('button', { name: /^Show more/ }).click();
  await expect(long.getByRole('button', { name: /^Show less/ })).toHaveAttribute('aria-expanded', 'true');
  await long.getByRole('button', { name: /^Show less/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-compact-dark-390.png`, scale: 'css' });
  await expect(first.getByRole('button', { name: /^Show more/ })).toHaveCount(0);
});

// Attaching an email to a task is gone with every email item's task intents (2026-11-02,
// 5a28ae6c9): there is no chooser to return to. New task opens a draft and makes nothing.
test('an email item offers no attachment: Talk to CEO and New task instead, and New task makes nothing', async ({ page, request }) => {
  const item = mailItem('fix-return');
  const sent = await sendItems(request, [item]);
  await page.setViewportSize({ width: 900, height: 700 });
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  await expectContentActionsOnly(row, item.subject);
  await expect(row.getByRole('button', { name: 'Confirm attachment', exact: true })).toHaveCount(0);
  await expectNewTaskOnlyDrafts(page, request, row, item.subject, sent.id, item.id);
});

// The create form is gone (5a28ae6c9); Mark read again is the confirmation a new letter's item still opens.
test('narrow confirmation keeps readable identity and folds technical source', async ({ page, request }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const item = mailItem('fix-confirm'); item.source.message = `fixture-${'long-source-'.repeat(30)}`;
  const sent = await sendItems(request, [item]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  await view.evaluate(el => { (el as HTMLElement).style.width = '320px'; });
  const form = await openMarkReadAgain(request, row, item);
  await expect(form.locator('.hii-confirm-source')).toContainText('Fixture sender');
  await expect(form.locator('.hii-confirm-source')).not.toContainText(item.source.message);
  await expect(form.locator('.hii-operation-details')).not.toHaveAttribute('open', '');
  await expect(form.locator('.hii-operation-details pre')).toContainText(item.source.message);
  const identity = await form.locator('.hii-confirm-source').boundingBox();
  const footer = await form.locator('.hii-confirm-footer').boundingBox();
  expect(footer!.y + footer!.height - identity!.y).toBeLessThan(640);
  expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await form.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-identity-confirm.png`, scale: 'css' });
  await form.locator('.hii-operation-details summary').click();
  await expect(form.locator('.hii-operation-details pre')).toBeVisible();
  const before = (await receipt(request, sent.id, item.id)).receipts;
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await receipt(request, sent.id, item.id)).receipts).toEqual(before);
});

test('local failures use the error token and unsupported API has one inline warning', async ({ page, request }, info) => {
  const sent = await sendItems(request, [mailItem('fix-failure', 'fail-'), mailItem('fix-old')]);
  await home(page); const view = await openLetter(page, sent.subject);
  const failed = itemRow(view, 'fix-failure');
  await failed.getByRole('button', { name: /^Mark read for/ }).click();
  await expect(failed.locator('.hii-receipts')).toContainText('Could not mark read');
  await expect(failed.locator('.hii-receipts .hii-error')).toContainText('Could not mark read');
  await failed.locator('.hii-receipt-details summary').click();
  await expect(failed.locator('.hii-receipt-details .hii-error').last()).toContainText('provider');
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-local-failure.png`, scale: 'css' });
  const old = itemRow(view, 'fix-old');
  await page.route(`**/human-inbox/${sent.id}/items/fix-old/execution`, route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await old.getByRole('button', { name: /^Check status for/ }).click();
  const warning = old.locator('.hii-receipts').getByText('Email actions need a newer server', { exact: true });
  await expect(warning).toHaveCount(1);
  await expect(old.getByRole('button', { name: /^Mark read for/ })).toBeDisabled();
});

test('submitted work offers Close instead of Cancel and closing does not undo the receipt', async ({ page, request }) => {
  test.setTimeout(60_000);
  const item = mailItem('fix-submitted');
  const sent = await sendItems(request, [item]);
  await home(page); const view = await openLetter(page, sent.subject); const row = itemRow(view, item.id);
  const form = await openMarkReadAgain(request, row, item);
  const count = (await receipt(request, sent.id, item.id)).receipts.length;
  await form.getByRole('button', { name: 'Confirm mark read', exact: true }).click();
  await expect.poll(async () => (await receipt(request, sent.id, item.id)).receipts.length, { timeout: 25_000 }).toBe(count + 1);
  await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  const close = form.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toHaveAttribute('title', 'Close this view. Submitted work continues.');
  const before = await receipt(request, sent.id, item.id);
  await close.click();
  await expect(row.locator('.hii-confirm')).toHaveCount(0);
  expect((await receipt(request, sent.id, item.id)).receipts).toEqual(before.receipts);
});

// The panel is opaque, or glass with a real blur (overlay-glass.css, 2026-10-26: the
// glass applies only where @supports finds backdrop-filter, else the panel keeps its
// opaque background). Either way the page behind never reads through. The test used
// to switch the blur off with an override, which leaves the glass's tint and proves
// nothing about a browser without backdrop support.
test('notification reading panel never lets the page read through, in both themes', async ({ page, request }, info) => {
  const sent = await sendItems(request, [mailItem('fix-opaque')]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await home(page); await openLetter(page, sent.subject);
  const panel = page.locator('.notification-panel');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const look = await panel.evaluate(el => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, blur: cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter') }; });
    if (cssColorToRgba(look.bg)[3] < 1) expect(look.blur, `a see-through background (${look.bg}) needs a blur`).toMatch(/blur\((?:[2-9]\d|\d{3,})px\)/);
    await page.screenshot({ path: `${SHOTS}/${info.project.name}-opaque-${theme}.png`, scale: 'css' });
  }
});
