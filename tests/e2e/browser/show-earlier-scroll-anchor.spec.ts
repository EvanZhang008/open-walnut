/**
 * Playwright browser test: "Show N earlier messages" must PRESERVE the user's
 * reading position — older messages expand ABOVE the viewport, and the message
 * the user was looking at stays put.
 *
 * Reported bug: clicking the button jumped the viewport to the TOP of the newly
 * revealed batch. The scroll container has `overflow-anchor: none` (deliberate,
 * for Phase 2 content replacement), so when 200 messages were inserted above,
 * scrollTop stayed numerically fixed (~0 when the user had scrolled to the top
 * to reach the button) and the user's place moved thousands of px down.
 *
 * The fix records `scrollHeight - scrollTop` (distance to bottom) before the
 * expand and restores it in a useLayoutEffect after the re-render — bottom
 * distance is invariant to everything inserted/removed above the viewport
 * (the 200 new messages, the button relabel, the pinned initial prompt).
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-earlier-anchor-session';
// INITIAL_RENDER_LIMIT is 30 → with 250 messages, 220 are hidden; one click
// reveals LOAD_MORE_BATCH(200), leaving 20 hidden (button stays, mid-expand case).
const TOTAL_MESSAGES = 250;

async function mockSession(page: Page) {
  const messages = Array.from({ length: TOTAL_MESSAGES }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `History message ${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  }));

  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({ json: { messages, cursor: messages.length, delta: false } });
  });

  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-earlier-anchor-task',
          project: 'Walnut',
          process_status: 'idle',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: TOTAL_MESSAGES,
          title: 'Show-earlier anchor repro',
        },
      },
    });
  });
}

test.describe('Show earlier messages — scroll anchor', () => {
  test('expanding earlier messages keeps the current reading position fixed', async ({ page }) => {
    await mockSession(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');

    const history = page.locator('.session-history');
    // Initial render shows the tail (indices 220..249), auto-scrolled to bottom.
    await expect(history).toContainText('History message 249', { timeout: 8000 });
    // Let the load-time debounced auto-scroll (250ms timer) settle before we
    // scroll away, so it can't yank us back to the bottom mid-test.
    await page.waitForTimeout(700);

    // User scrolls to the very top to reach the "Show earlier" button.
    await history.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(400);
    expect(await history.evaluate((el) => el.scrollTop)).toBe(0);

    const button = page.locator('.session-show-earlier-btn');
    await expect(button).toBeVisible();
    await expect(button).toContainText('Show 200 earlier messages');

    // The message the user is currently reading: the first visible one (index 220).
    const anchorMsg = page.locator('[data-msg-index="220"]');
    const beforeBox = await anchorMsg.boundingBox();
    expect(beforeBox).not.toBeNull();

    await button.click();

    // 200 older messages are now rendered (earliest visible index drops to 20)…
    await expect(page.locator('[data-msg-index="20"]')).toBeAttached();
    await expect(button).toContainText('Show 20 earlier messages');

    // …but the user's reading position must NOT move: the previously-top
    // message stays at the same viewport Y. With the bug, scrollTop stayed 0
    // and this message was pushed ~3000px down (the viewport showed the top
    // of the newly revealed batch instead).
    const afterBox = await anchorMsg.boundingBox();
    expect(afterBox).not.toBeNull();
    expect(Math.abs(afterBox!.y - beforeBox!.y)).toBeLessThanOrEqual(30);

    // Sanity: the expansion actually grew content above us (we're no longer at top).
    expect(await history.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);

    // And the newly revealed batch sits ABOVE the viewport, ready to scroll up into.
    const revealedTop = await page.locator('[data-msg-index="20"]').boundingBox();
    const containerBox = await history.boundingBox();
    expect(revealedTop!.y).toBeLessThan(containerBox!.y);
  });
});
