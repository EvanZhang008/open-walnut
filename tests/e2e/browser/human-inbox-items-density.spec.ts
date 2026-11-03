import { test, expect } from '@playwright/test';
import { EVIDENCE, expectContentActionsOnly, home, itemRow, mailItem, openLetter, sendItems } from './inbox-items-helpers';

test.describe.configure({ mode: 'serial' });
for (const count of [15, 30]) {
  test(`${count} saved items keep order, sources and accessible actions at narrow width`, async ({ page, request }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const items = Array.from({ length: count }, (_, n) => ({ ...mailItem(`dense-${n}`),
      subject: `${n === 0 ? 'Long subject '.repeat(25) : 'Saved subject'} ${n}`,
      summary: 'Long saved summary with no instructions. '.repeat(30),
      source: { kind: 'mail' as const, account: n % 2 ? 'fixture-account-a' : 'fixture-account-b', message: `fixture-long-${info.project.name}-${count}-${n}-${'m'.repeat(80)}` },
      display: n === count - 1 ? undefined : { sender: { name: `Sender ${n}`, address: `sender-${n}@example.test` },
        sentAt: '2026-10-21T12:00:00Z', accountLabel: 'Personal', accountHint: `Mailbox ${n % 2}` },
    }));
    const sent = await sendItems(request, items);
    await home(page);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, count === 30 ? 'dark' : 'light');
    const view = await openLetter(page, sent.subject);
    await expect(view.locator('.hii-item')).toHaveCount(count);
    expect(await view.locator('.hii-item').evaluateAll(rows => rows.map(r => r.getAttribute('data-item-id')))).toEqual(items.map(i => i.id));
    const tail = itemRow(view, `dense-${count - 1}`); await tail.scrollIntoViewIfNeeded();
    await expect(tail).toContainText('Sender unavailable');
    await expect(tail).toContainText('Date unavailable');
    expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-dense-${count}-390.png`, scale: 'css' });
    await view.evaluate(el => { (el as HTMLElement).style.width = '320px'; });
    expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-dense-${count}-320.png`, scale: 'css' });
    // Every item names its actions with its own subject: Mark read and the two content actions
    // (Talk to CEO, New task) since 2026-11-02 (5a28ae6c9), never a task intent.
    const first = itemRow(view, 'dense-0'); await first.scrollIntoViewIfNeeded();
    for (const [row, subject] of [[first, items[0].subject], [tail, items[count - 1].subject]] as const) {
      await expect(row.getByRole('button', { name: `Mark read for ${subject.replace(/\s+/g, ' ').trim()}`, exact: true })).toBeVisible();
      await expectContentActionsOnly(row, subject);
    }
    await first.locator('.hii-source-details summary').click();
    await first.getByRole('button', { name: /^Copy source for Long subject/ }).scrollIntoViewIfNeeded();
    expect(await view.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-details-${count}-320.png`, scale: 'css' });
    await first.locator('.hii-source-details summary').click();
    await page.setViewportSize({ width: 1280, height: 800 });
    // A built SPA keeps its reader across this breakpoint; dev mode may remount it.
    const wideView = await view.isVisible() ? view : await openLetter(page, sent.subject);
    await wideView.evaluate(el => { (el as HTMLElement).style.width = ''; });
    await itemRow(wideView, 'dense-0').scrollIntoViewIfNeeded();
    expect(await wideView.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `${EVIDENCE}/web-${info.project.name}-dense-${count}-1280.png`, scale: 'css' });
  });
}
