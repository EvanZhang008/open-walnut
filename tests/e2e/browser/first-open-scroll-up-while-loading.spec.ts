/**
 * Playwright browser test: a reader can scroll UP while a freshly opened
 * session is still loading its full history.
 *
 * Reported bug (2026-09-03, remote session whose history fetch took 17s):
 * "for a newly opened session I can't scroll up, it flickers, flashes and
 * stays at the bottom; once everything has loaded I can scroll up."
 *
 * Cause: the load-window bottom pin re-pins scrollTop to the bottom every
 * animation frame until Phase 2 settles (up to 15s). A wheel-up flips
 * isAtBottom=false, but the same frame's scroll event lands inside the 80px
 * near-bottom band and flips it back to true, so the next frame re-pins.
 * Trackpad deltas are small (tens of px), so the reader could never escape the
 * band until the fetch completed. The pin must yield for good the moment the
 * human touches the scroller.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-first-open-scroll-up-session';
const TOTAL = 320;

function row(i: number) {
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `History message ${i}\n\n${'lorem ipsum dolor sit amet '.repeat(6)}`,
    msgId: `m${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  };
}

async function mockSession(page: Page, phase2Gate: Promise<void>) {
  const all = Array.from({ length: TOTAL }, (_, i) => row(i));
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const isStreams = route.request().url().includes('source=streams');
    if (!isStreams) await phase2Gate;
    await route.fulfill({
      json: {
        messages: all,
        total: TOTAL,
        ...(isStreams ? {} : { cursor: TOTAL }),
        delta: false,
      },
    });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-first-open-scroll-up-task', project: 'Walnut',
          process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: TOTAL,
          title: 'First-open scroll-up repro',
        },
      },
    });
  });
}

test.describe('First open — scroll up while the full history is still loading', () => {
  test('trackpad-sized wheel steps escape the bottom before Phase 2 lands', async ({ page }) => {
    let releasePhase2: (() => void) | null = null;
    const phase2Gate = new Promise<void>((resolve) => { releasePhase2 = resolve; });
    await mockSession(page, phase2Gate);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('domcontentloaded');

    const history = page.locator('.session-history');
    await expect(history).toContainText(`History message ${TOTAL - 1}`, { timeout: 15000 });
    // Phase 1 painted and the pre-paint auto-scroll landed at the bottom.
    await page.waitForTimeout(900);
    const gapAtStart = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(gapAtStart).toBeLessThanOrEqual(4);

    // A human on a trackpad: many small upward wheel ticks, ~one per frame.
    const box = (await history.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 16; i++) {
      await page.mouse.wheel(0, -30);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(400);

    // The reader is several hundred px up and STAYS there while the fetch is
    // still in flight. With the bug the gap snaps back to ~0 every frame.
    const gapAfterWheel = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(gapAfterWheel).toBeGreaterThan(200);
    await page.waitForTimeout(800);
    const gapHeld = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(gapHeld).toBeGreaterThan(200);

    // Phase 2 landing must not yank the reader back down either.
    releasePhase2!();
    await page.waitForTimeout(1200);
    const gapAfterPhase2 = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(gapAfterPhase2).toBeGreaterThan(200);
  });

  test('a reopen whose refresh is slow: Load earlier stays clickable, the refresh never pulls a reader who scrolled up, and no shown row goes away (2026-11-17)', async ({ page }) => {
    // The first visit keeps the last 16 of 320 rows (IndexedDB); the reopen paints them at once
    // and refreshes in the background, and that refresh is held until the test lets it go. All 16
    // rows fit the render window, so the button on screen is the one that fetches the older part
    // from the server. Before the fix it read the refresh's state: disabled and "Loading earlier
    // turns…" for as long as the refresh took (seconds on a big remote session).
    const HELD = 16;
    const all = Array.from({ length: TOTAL + 4 }, (_, i) => row(i));
    await mockSession(page, Promise.resolve());
    let visit = 0;
    let releaseRefresh: (() => void) | null = null;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshAsked: () => void = () => {};
    const refreshStarted = new Promise<void>((resolve) => { refreshAsked = resolve; });
    const wholeReads: string[] = [];
    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('source') === 'streams') {
        await route.fulfill({ json: { messages: all.slice(TOTAL - 8, TOTAL), total: TOTAL, delta: false } });
        return;
      }
      if (!url.searchParams.has('tail')) {
        // "Load earlier turns": the whole conversation.
        wholeReads.push(url.search);
        const end = visit > 0 ? TOTAL + 4 : TOTAL;
        await route.fulfill({ json: { messages: all.slice(0, end), total: end, cursor: end, delta: false } });
        return;
      }
      if (visit === 0) {
        await route.fulfill({ json: { messages: all.slice(TOTAL - HELD, TOTAL), total: TOTAL, cursor: TOTAL, delta: false } });
        return;
      }
      refreshAsked();
      await refreshGate;
      // The refresh brings 4 new rows at the bottom, with every row the reopen showed.
      await route.fulfill({ json: { messages: all.slice(TOTAL - HELD, TOTAL + 4), total: TOTAL + 4, cursor: TOTAL + 4, delta: false } });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    const history = page.locator('.session-history');
    const earlier = history.locator('.session-show-earlier-btn');
    await expect(history).toContainText(`History message ${TOTAL - 1}`, { timeout: 15000 });
    await expect(earlier).toHaveText('Load earlier turns', { timeout: 15000 });
    // Let the visit's copy reach IndexedDB, then reopen.
    await page.waitForTimeout(1500);
    visit = 1;
    await page.reload();
    await expect(history).toContainText(`History message ${TOTAL - HELD}`, { timeout: 15000 });
    await refreshStarted;

    // The refresh is on its way (asked, not answered): the button can be clicked, and says so.
    await expect(earlier).toBeVisible();
    await expect(earlier).toBeEnabled();
    await expect(earlier).toHaveText('Load earlier turns');

    const box = (await history.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(40);
    }
    await expect.poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(200);
    const readingAt = await history.evaluate((el) => el.scrollTop);

    // Typing while the refresh runs: the composer grows, the timeline's box shrinks, and that
    // resize must not pull the reader back to the bottom (before the fix the refresh's forced
    // follow did, for as long as the refresh took).
    const composer = page.locator('.session-panel-input .chat-input-textarea');
    await composer.click();
    for (let i = 0; i < 5; i++) { await composer.pressSequentially(`line ${i}`); await composer.press('Shift+Enter'); }
    await page.waitForTimeout(700);
    await expect.poll(() => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(200);
    expect(Math.abs(await history.evaluate((el) => el.scrollTop) - readingAt)).toBeLessThan(150);

    // A click while the refresh runs is kept: the button says it is loading, nothing is asked yet.
    await earlier.click();
    await expect(earlier).toHaveText('Loading earlier turns…');
    expect(wholeReads).toEqual([]);

    // The refresh lands: the new rows join at the bottom, every row shown before stays, and the
    // kept click then fetches the older part.
    releaseRefresh!();
    await expect(history).toContainText(`History message ${TOTAL + 3}`, { timeout: 15000 });
    for (let i = TOTAL - HELD; i < TOTAL + 4; i++) await expect(history).toContainText(new RegExp(`History message ${i}(?!\\d)`));
    await expect.poll(() => wholeReads.length, { timeout: 15000 }).toBe(1);
    await expect(history).toContainText(new RegExp(`History message ${TOTAL - HELD - 1}(?!\\d)`), { timeout: 15000 });
    const gapAfter = await history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(gapAfter).toBeGreaterThan(200);
  });
});
