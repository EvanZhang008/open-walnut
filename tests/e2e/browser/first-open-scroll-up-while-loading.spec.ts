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
});
