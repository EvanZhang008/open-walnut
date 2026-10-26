/**
 * Page find (Cmd/Ctrl+F) and selection echo, shared by page-find.spec.ts
 * (Chromium) and page-find.webkit.spec.ts (the Mac app's engine).
 *
 * Asked for 2026-10-25: "search while keeping my page still; highlight first,
 * then I press down and up myself; when I select something, every identical
 * word lights up". The invariant every scenario checks is the first half:
 * nothing but next/previous may move the chat.
 *
 * Harness: history is mocked through page.route (the code-block-hscroll
 * pattern), so the real client renders a long session for real; only the data
 * is canned. 240 rows: the newest 30 render, the rest wait behind
 * "Load earlier turns" and must not count until loaded.
 */
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

export const SESSION_ID = 'pw-page-find';
export const TASK_ID = 'pw-task-page-find';
export const SHOT_DIR = '/tmp/page-find';
const ROWS = 240;
/** Words that only exist in rows above the render window. */
export const OLD_MARKER = 'quokkaonly';
export const WORD = 'zebra';
export const HIDDEN_WORD = 'narwhal';

function history() {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ROWS; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    // Old answers only: user questions also label the question map, which is
    // on screen (and so rightly searchable) even for unloaded rows.
    // Rows 180-199 sit just above the 30-row render window, so one "Load
    // earlier turns" brings them in.
    const old = i >= 180 && i < 200 ? ` ${OLD_MARKER}` : '';
    if (i % 2 === 0) {
      out.push({ role: 'user', text: `Question ${i}: where does the ${WORD} go?`, timestamp: at });
    } else {
      const body = [
        `Answer ${i}. The ${WORD} crossed the road, and a second ${WORD} followed it.${old}`,
        '',
        `Padding paragraph ${i} so the transcript is tall enough to scroll through properly. `.repeat(3),
        '',
        '```ts',
        `const animal${i} = '${WORD}';`,
        '```',
      ].join('\n');
      const row: Record<string, unknown> = { role: 'assistant', text: body, timestamp: at };
      // A folded Thinking row holding the hidden word: it must not count while
      // folded, and must count once the reader opens it.
      if (i === ROWS - 3) row.thinking = `The ${HIDDEN_WORD} is only in this folded thought.`;
      out.push(row);
    }
  }
  return out;
}

export async function mockSession(page: Page) {
  const rows = history();
  const record = {
    claudeSessionId: SESSION_ID,
    taskId: TASK_ID,
    project: 'Walnut',
    process_status: 'idle',
    mode: 'bypass',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: new Date().toISOString(),
    messageCount: rows.length,
    title: 'Page find session',
  };
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({ json: { session: { ...record } } });
  });
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const since = new URL(route.request().url()).searchParams.get('since');
    if (since !== null) return route.fulfill({ json: { messages: [], cursor: rows.length, delta: true } });
    return route.fulfill({ json: { messages: rows, cursor: rows.length, delta: false } });
  });
}

const HISTORY = `.session-panel[data-session-id="${SESSION_ID}"] .session-history`;

export async function openSession(page: Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockSession(page);
  await page.goto(`/sessions?id=${SESSION_ID}`);
  // Not networkidle: under machine load a live socket kept it from settling.
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator(HISTORY).getByText(`Answer ${ROWS - 1}.`)).toBeVisible({ timeout: 20_000 });
  // The chat keeps filling in after the last row shows (the question map, the
  // follow-bottom settle): wait until its text and its scroll position hold
  // still for a second, so every count and scroll baseline below is final.
  let last = '';
  let still = 0;
  for (let i = 0; i < 60 && still < 4; i++) {
    const now = await page.locator(HISTORY).evaluate((el) =>
      `${(el as HTMLElement).innerText.length}:${Math.round(el.scrollTop)}:${el.scrollHeight}`);
    still = now === last ? still + 1 : 0;
    last = now;
    await page.waitForTimeout(250);
  }
}

export function findChord(page: Page): Promise<void> {
  return page.evaluate(() => /Mac|iP/.test(navigator.platform))
    .then((apple) => page.keyboard.press(apple ? 'Meta+f' : 'Control+f'));
}

export const scrollTop = (page: Page) => page.locator(HISTORY).evaluate((el) => Math.round(el.scrollTop));

/** Paint as the engine holds it: sizes of the find and echo highlights. */
export function paint(page: Page) {
  return page.evaluate(() => {
    const reg = (window as unknown as { CSS: { highlights?: Map<string, { size: number }> } }).CSS.highlights;
    return {
      find: reg?.get('walnut-find')?.size ?? 0,
      active: reg?.get('walnut-find-active')?.size ?? 0,
      sel: reg?.get('walnut-page-selmatch')?.size ?? 0,
    };
  });
}

/** Rendered, visible occurrences of `word` in the chat, counted independently
 *  of the feature: by innerText, which leaves out what is not rendered. */
export function expectedCount(page: Page, word: string) {
  return page.locator(HISTORY).evaluate((el, w) => {
    const text = (el as HTMLElement).innerText.toLowerCase();
    let n = 0;
    for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + w.length)) n++;
    return n;
  }, word);
}

/** Watch scrollTop on every frame while `action` runs; returns the largest move. */
export async function maxScrollDrift(page: Page, action: () => Promise<void>): Promise<number> {
  await page.locator(HISTORY).evaluate((el) => {
    const w = window as unknown as { __pfDrift: number; __pfStop: boolean };
    const start = el.scrollTop;
    w.__pfDrift = 0;
    w.__pfStop = false;
    const tick = () => {
      w.__pfDrift = Math.max(w.__pfDrift, Math.abs(el.scrollTop - start));
      if (!w.__pfStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const w = window as unknown as { __pfDrift: number; __pfStop: boolean };
    w.__pfStop = true;
    return w.__pfDrift;
  });
}

/** Scroll the chat up the way a reader does, so follow-bottom lets go. */
export async function readerScrollUp(page: Page, px: number) {
  const box = await page.locator(HISTORY).boundingBox();
  if (!box) throw new Error('no history box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -px);
  await page.waitForTimeout(500);
}

/** Is the active match inside the chat's visible box? */
export function activeInView(page: Page) {
  return page.locator(HISTORY).evaluate((el) => {
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights;
    const h = reg.get('walnut-find-active');
    if (!h || !h.size) return false;
    // The paint holds StaticRanges (no geometry): measure through a live copy.
    const s = [...h][0]!;
    const live = document.createRange();
    live.setStart(s.startContainer, s.startOffset);
    live.setEnd(s.endContainer, s.endOffset);
    const r = live.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.top + el.clientHeight && r.height > 0;
  });
}

export const bar = (page: Page) => page.locator('.page-find');
export const label = (page: Page) => page.locator('.page-find .fv-search-count');

/** The count for the CURRENT query (the bar marks a query still being counted). */
export async function settledLabel(page: Page): Promise<string> {
  await expect(page.locator('.page-find[data-pending="false"]')).toHaveCount(1);
  return (await label(page).textContent()) ?? '';
}

export function shot(page: Page, name: string) {
  mkdirSync(SHOT_DIR, { recursive: true });
  return page.screenshot({ path: `${SHOT_DIR}/${name}.png`, scale: 'css' });
}

export const historySelector = HISTORY;
export const ROW_COUNT = ROWS;
