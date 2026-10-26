/**
 * The page find scenario matrix, defined once and registered by both the
 * Chromium and the WebKit spec (test.use({ browserName }) is per file).
 */
import { test, expect } from '@playwright/test';
import {
  HIDDEN_WORD, OLD_MARKER, WORD, activeInView, bar, expectedCount, findChord, historySelector,
  label, maxScrollDrift, openSession, paint, readerScrollUp, scrollTop, settledLabel, shot,
} from './page-find-helpers';
import type { Page } from '@playwright/test';

/** Click the middle of the chat (a message on screen), so Playwright never
 *  scrolls to reach the click target. */
async function clickVisibleAnswer(page: Page) {
  const box = await page.locator(historySelector).boundingBox();
  if (!box) throw new Error('no history box');
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
}

export function definePageFindCases(engine: string): void {
  test.setTimeout(120_000);

  test(`${engine}: typing paints and counts, the chat does not move`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openSession(page);
    await readerScrollUp(page, 1500);
    // Click into a message on screen (focuses nothing), then the chord.
    await clickVisibleAnswer(page);
    const before = await scrollTop(page);
    await findChord(page);
    await expect(bar(page)).toBeVisible();
    await expect(page.locator('.page-find input')).toHaveAttribute('placeholder', 'Find in session');
    await expect(page.locator('.page-find input')).toBeFocused();

    const drift = await maxScrollDrift(page, async () => {
      await page.keyboard.type(WORD, { delay: 60 });
    });
    const want = await expectedCount(page, WORD);
    expect(want).toBeGreaterThan(20);
    expect(await settledLabel(page)).toBe(`?/${want}`);
    expect(await paint(page)).toMatchObject({ find: want, active: 0 });
    expect(drift).toBe(0);
    expect(await scrollTop(page)).toBe(before);
    await shot(page, `${engine}-typed`);

    // Toggle case: still no move.
    const caseDrift = await maxScrollDrift(page, async () => {
      await page.locator('.page-find .fv-search-case').click();
    });
    expect(caseDrift).toBe(0);
    await page.locator('.page-find .fv-search-case').click();
    await page.locator('.page-find input').focus();

    // First Enter picks a match the reader can already see: still no move.
    const firstDrift = await maxScrollDrift(page, async () => { await page.keyboard.press('Enter'); });
    await expect(label(page)).toHaveText(new RegExp(`^\\d+/${want}$`));
    expect(firstDrift).toBe(0);
    expect(await activeInView(page)).toBe(true);
    expect((await paint(page)).active).toBe(1);
    await shot(page, `${engine}-first-enter`);

    // Walking past the view scrolls, and lands the match in view every time.
    const startIdx = Number((await label(page).textContent())!.split('/')[0]);
    for (let k = 1; k <= 12; k++) {
      await page.keyboard.press('Enter');
      await expect(label(page)).toHaveText(`${((startIdx - 1 + k) % want) + 1}/${want}`);
      expect(await activeInView(page)).toBe(true);
    }
    expect(await scrollTop(page)).not.toBe(before);
    await page.keyboard.press('Shift+Enter');
    await expect(label(page)).toHaveText(`${((startIdx - 1 + 11) % want) + 1}/${want}`);
    expect(await activeInView(page)).toBe(true);
    // The chat let go of the bottom: nothing pulls the view back after a move.
    const parked = await scrollTop(page);
    await page.waitForTimeout(1200);
    expect(await scrollTop(page)).toBe(parked);
    await shot(page, `${engine}-walked`);

    // Esc closes, clears the paint, and leaves the chat where it is.
    const closeDrift = await maxScrollDrift(page, async () => { await page.keyboard.press('Escape'); });
    await expect(bar(page)).toHaveCount(0);
    expect(closeDrift).toBe(0);
    expect(await paint(page)).toMatchObject({ find: 0, active: 0 });
    expect(errors).toEqual([]);
  });

  test(`${engine}: unloaded rows and folded content do not count until shown`, async ({ page }) => {
    await openSession(page);
    await page.locator(historySelector).getByText('Answer 239.').click();
    await findChord(page);
    await page.keyboard.type(OLD_MARKER);
    expect(await settledLabel(page)).toBe('No results');

    // The folded Thinking row holds the hidden word: not counted while folded...
    await page.locator('.page-find input').fill(HIDDEN_WORD);
    expect(await settledLabel(page)).toBe('No results');
    // ...and counted, in place, the moment the reader opens it.
    const fold = page.locator(historySelector).locator('.tool-run-toggle', { hasText: 'Thinking' }).last();
    await fold.click();
    await expect(label(page)).toHaveText('?/1', { timeout: 5_000 });

    // "Load earlier" renders the old rows; the count follows.
    await page.locator('.page-find input').fill(OLD_MARKER);
    expect(await settledLabel(page)).toBe('No results');
    const loadEarlier = page.locator(historySelector).getByText('Load earlier turns').first();
    await expect(loadEarlier).toBeVisible({ timeout: 10_000 });
    await loadEarlier.click();
    await expect(label(page)).toHaveText(/^\?\/[1-9]\d*$/, { timeout: 10_000 });
  });

  test(`${engine}: new content recounts in place and keeps the chosen match`, async ({ page }) => {
    await openSession(page);
    await readerScrollUp(page, 1200);
    await clickVisibleAnswer(page);
    await findChord(page);
    await page.keyboard.type(WORD);
    const want = await expectedCount(page, WORD);
    expect(await settledLabel(page)).toBe(`?/${want}`);
    await page.keyboard.press('Enter');
    const idx = Number((await label(page).textContent())!.split('/')[0]);

    // Text arriving at the bottom (a streaming reply) adds matches after the
    // chosen one: the count grows, the choice and the view stay.
    const drift = await maxScrollDrift(page, async () => {
      await page.locator(historySelector).evaluate((el, w) => {
        const bodies = el.querySelectorAll('.markdown-body');
        const last = bodies[bodies.length - 1]!;
        for (let i = 0; i < 3; i++) {
          const p = document.createElement('p');
          p.textContent = `streamed ${w} line ${i}`;
          last.appendChild(p);
        }
      }, WORD);
      await expect(label(page)).toHaveText(`${idx}/${want + 3}`, { timeout: 3_000 });
    });
    expect(drift).toBe(0);
    expect(await paint(page)).toMatchObject({ find: want + 3, active: 1 });

    // Two matches arriving ABOVE the chosen one: the same match stays chosen,
    // so its number moves up by two (a by-number fallback would keep `idx`).
    await page.locator(historySelector).evaluate((el, w) => {
      const first = el.querySelector('.markdown-body')!;
      const p = document.createElement('p');
      p.textContent = `early ${w} and ${w}`;
      first.prepend(p);
    }, WORD);
    await expect(label(page)).toHaveText(`${idx + 2}/${want + 5}`, { timeout: 3_000 });
    expect(await activeInView(page)).toBe(true);
  });

  test(`${engine}: selecting a word tints every identical copy, clearing it removes the tint`, async ({ page }) => {
    await openSession(page);
    const before = await scrollTop(page);
    const target = page.locator(historySelector).locator('.markdown-body p', { hasText: 'Answer 237.' }).first();
    await target.evaluate((p, w) => {
      const node = [...p.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.includes(w))!;
      const at = node.textContent!.indexOf(w);
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + w.length);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(r);
    }, WORD);
    // Exact = case-sensitive copies the reader can see (innerText skips folds).
    const exact = () => page.locator(historySelector).evaluate((el, w) => {
      const t = (el as HTMLElement).innerText;
      let n = 0;
      for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + w.length)) n++;
      return n;
    }, WORD);
    // Both sides read live: the question map fills in after the history, and a
    // count taken before it would be stale, not wrong paint.
    await expect.poll(async () => (await paint(page)).sel - await exact()).toBe(0);
    const n0 = await exact();
    expect(await scrollTop(page)).toBe(before);
    await shot(page, `${engine}-selection-echo`);

    // New text under a held selection: an identical copy joins, a case-different
    // one does not ("identical" means identical).
    await page.locator(historySelector).evaluate((el, w) => {
      const p = document.createElement('p');
      p.textContent = `${w.toUpperCase()} uppercase copy, and one more ${w}`;
      el.querySelector('.markdown-body')!.appendChild(p);
    }, WORD);
    await expect.poll(async () => (await paint(page)).sel, { timeout: 3_000 }).toBe(n0 + 1);
    expect(await exact()).toBe(n0 + 1);

    // A click elsewhere clears the selection, and the tint with it.
    await page.locator(historySelector).getByText('Answer 239.').click();
    await expect.poll(async () => (await paint(page)).sel).toBe(0);
  });

  test(`${engine}: off a session the chord searches the page, and a second chord switches scope`, async ({ page }) => {
    await openSession(page);
    // Last click on the task panel's toolbar (not a session): the page is the scope.
    await page.locator('.todo-panel-toolbar').first().click({ position: { x: 4, y: 4 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await findChord(page);
    await expect(bar(page)).toHaveAttribute('data-scope', 'page');
    await expect(page.locator('.page-find input')).toHaveAttribute('placeholder', 'Find in page');
    await page.keyboard.type('Answer 239');
    await expect(label(page)).toHaveText(/^\?\/[1-9]\d*$/);

    // Back into the chat: the same chord now searches that session.
    await page.locator(historySelector).getByText('Answer 239.').click();
    await findChord(page);
    await expect(bar(page)).toHaveAttribute('data-scope', 'session');
    await expect(page.locator('.page-find input')).toBeFocused();
    // Pressed again with focus in the bar: the scope holds.
    await findChord(page);
    await expect(bar(page)).toHaveAttribute('data-scope', 'session');
    await page.keyboard.press('Escape');
    await expect(bar(page)).toHaveCount(0);
  });
}
