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

  // Reported 2026-10-29: "I select a word, it lights up; I deselect it, and the
  // highlight is still there." A re-render that rewrites the text under a
  // selection (React 19 writes innerHTML whenever the prop object changes) makes
  // both engines drop the selection WITHOUT a selectionchange event, so an echo
  // that trusts the last event outlives the selection.
  test(`${engine}: every way a selection ends clears its echo, and a new one moves it`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openSession(page);
    await readerScrollUp(page, 600);
    const exact = (w: string) => page.locator(historySelector).evaluate((el, w) => {
      const t = (el as HTMLElement).innerText;
      let n = 0;
      for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + w.length)) n++;
      return n;
    }, w);
    const selected = () => page.evaluate(() => getSelection()?.toString() ?? '');
    // A word on screen, by coordinates, so the gesture is a real mouse one.
    const wordAt = (w: string) => page.locator(historySelector).evaluate((el, w) => {
      const box = el.getBoundingClientRect();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.parentElement?.closest('.markdown-body p')) continue;
        const at = (n as Text).data.indexOf(w);
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(n, at);
        r.setEnd(n, at + w.length);
        const b = r.getBoundingClientRect();
        if (b.top < box.top + 120 || b.bottom > box.bottom - 60 || !b.width) continue;
        // Blank space: right of the paragraph's last line, with no text under it.
        const whole = document.createRange();
        whole.selectNodeContents(n.parentElement!);
        const rects = whole.getClientRects();
        const last = rects[rects.length - 1]!;
        const blank = { x: last.right + 40, y: last.top + last.height / 2 };
        if (blank.x > box.right - 20 || document.elementFromPoint(blank.x, blank.y) !== n.parentElement) continue;
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, blank };
      }
      throw new Error(`no visible ${w}`);
    }, w);
    const selectWord = async (w: string) => {
      const p = await wordAt(w);
      await page.mouse.dblclick(p.x, p.y);
      await expect.poll(selected).toBe(w);
      // Paint and text read in one turn: a stream between two reads would skew it.
      await expect.poll(() => page.locator(historySelector).evaluate((el, w) => {
        const t = (el as HTMLElement).innerText;
        let n = 0;
        for (let i = t.indexOf(w); i !== -1; i = t.indexOf(w, i + w.length)) n++;
        const reg = (window as unknown as { CSS: { highlights: Map<string, { size: number }> } }).CSS.highlights;
        return (reg.get('walnut-page-selmatch')?.size ?? 0) - n;
      }, w)).toBe(0);
      expect((await paint(page)).sel).toBeGreaterThan(1);
      return p;
    };
    const cleared = async () => {
      await expect.poll(selected).toBe('');
      await expect.poll(async () => (await paint(page)).sel).toBe(0);
    };

    // A click on blank space beside the text.
    let p = await selectWord(WORD);
    await page.mouse.click(p.blank.x, p.blank.y);
    await cleared();

    // A single click inside the selected word itself (the browser collapses it on mouseup).
    p = await selectWord(WORD);
    await page.mouse.click(p.x, p.y);
    await cleared();

    // Esc leaves the selection alone (no engine clears one on Esc), so the echo
    // stays exactly as long as the selection does.
    await selectWord(WORD);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    expect(await selected()).toBe(WORD);
    expect((await paint(page)).sel).toBe(await exact(WORD));

    // Selecting another word moves the echo onto that word's copies.
    await selectWord('crossed');
    expect(await paint(page)).toMatchObject({ sel: await exact('crossed') });
    const pill = page.locator('.quote-pin-pill');
    await expect(pill).toBeVisible();

    // A re-render rewrites the text under the selection: the engine drops the
    // selection with no event, and the echo (and the quote pill over the
    // passage) must go with it, and stay gone while more text arrives.
    await page.locator(historySelector).evaluate(() => {
      const body = getSelection()!.anchorNode!.parentElement!.closest('.markdown-body')!;
      body.innerHTML = body.innerHTML;
    });
    await cleared();
    await expect(pill).toHaveCount(0);
    await page.locator(historySelector).evaluate((el) => {
      const p = document.createElement('p');
      p.textContent = 'crossed again, crossed twice';
      el.querySelector('.markdown-body')!.appendChild(p);
    });
    await page.waitForTimeout(300);
    expect((await paint(page)).sel).toBe(0);

    // While a reply streams (its message re-rendered every 50 ms): a held
    // selection keeps its echo, a new one still gets its own within the
    // debounce, and a click on blank space clears it.
    await page.locator(historySelector).evaluate((el, w) => {
      const bodies = el.querySelectorAll('.markdown-body');
      const box = document.createElement('div');
      bodies[bodies.length - 1]!.appendChild(box);
      let i = 0;
      (window as unknown as { __pfStream: number }).__pfStream = window.setInterval(() => {
        i++;
        box.innerHTML = Array.from({ length: i % 40 }, (_, k) => `<p>streamed ${w} delta ${k}</p>`).join('');
      }, 50);
    }, WORD);
    p = await selectWord(WORD);
    await page.waitForTimeout(800);
    expect(await selected()).toBe(WORD);
    expect((await paint(page)).sel).toBeGreaterThan(1);
    await selectWord('crossed');
    p = await wordAt('crossed');
    await page.mouse.click(p.blank.x, p.blank.y);
    await cleared();
    await page.waitForTimeout(500);
    expect((await paint(page)).sel).toBe(0);
    await page.evaluate(() => window.clearInterval((window as unknown as { __pfStream: number }).__pfStream));
    expect(errors).toEqual([]);
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
