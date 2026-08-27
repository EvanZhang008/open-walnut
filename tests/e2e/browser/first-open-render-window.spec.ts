/**
 * Playwright browser test: opening a session must not render hundreds of rows
 * just because Phase 1 and Phase 2 hold DIFFERENT-length windows of the same
 * conversation.
 *
 * Reported bug (2026-08-27): "when I first open a session and scroll up it
 * flickers, then recovers soon; happens to many sessions."
 *
 * Phase 1 reads the local streams file, Phase 2 the archive, and the two do not
 * always cover the same range (measured live: 161 rows vs the archive's 400-row
 * tail of 543). The render window start was a plain INDEX ratcheted down from
 * whatever Phase 1 painted, so after Phase 2 re-windowed the array that index
 * pointed 239 rows older: 269 messages rendered instead of 30 and scrollHeight
 * went from 2,907px to 35,505px. That DOM lands and lays out (images, tool
 * cards, markdown) while the user is scrolling — the flicker — and the effect
 * that re-based the index ran a frame too late, arming a 240-row eviction for
 * the next array change.
 *
 * The window is now anchored to a msgId and re-derived during render, so the
 * reader keeps the same rows through a window swap. See
 * web/src/components/sessions/render-window.ts.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-first-open-window-session';
const TOTAL = 543;          // conversation length at the source
const ARCHIVE_TAIL = 400;   // what Phase 2 returns (HISTORY_TAIL_LIMIT)
const STREAMS_TAIL = 161;   // what Phase 1 happened to hold
const RENDER_LIMIT = 30;    // INITIAL_RENDER_LIMIT

function row(i: number) {
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `History message ${i}`,
    msgId: `m${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  };
}

async function mockSession(page: Page) {
  const all = Array.from({ length: TOTAL }, (_, i) => row(i));

  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    const url = route.request().url();
    // Phase 1 (streams): a SHORTER window than Phase 2 — the whole point.
    const isStreams = url.includes('source=streams');
    const take = isStreams ? STREAMS_TAIL : ARCHIVE_TAIL;
    const messages = all.slice(TOTAL - take);
    await route.fulfill({
      json: {
        messages,
        total: TOTAL,
        // Phase 1 carries no cursor (matches the real streams read).
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
          claudeSessionId: SESSION_ID,
          taskId: 'pw-first-open-window-task',
          project: 'Walnut',
          process_status: 'idle',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: TOTAL,
          title: 'First-open render window repro',
        },
      },
    });
  });
}

test.describe('First open — render window', () => {
  test('a shorter Phase 1 window does not explode the DOM when Phase 2 lands', async ({ page }) => {
    await mockSession(page);

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('networkidle');

    const history = page.locator('.session-history');
    await expect(history).toContainText(`History message ${TOTAL - 1}`, { timeout: 15000 });
    // Both phases have landed and the debounced auto-scroll has settled.
    await page.waitForTimeout(1200);

    const rendered = await history.evaluate((el) => {
      const idx = [...el.querySelectorAll('[data-msg-index]')]
        .map((n) => Number(n.getAttribute('data-msg-index')));
      return { count: new Set(idx).size, min: Math.min(...idx), max: Math.max(...idx), sh: el.scrollHeight };
    });

    // The window is the TAIL of the 400-row Phase-2 array, not index 131 of it.
    // With the bug: min === 131 and count === 269.
    expect(rendered.max).toBe(ARCHIVE_TAIL - 1);
    expect(rendered.min).toBe(ARCHIVE_TAIL - RENDER_LIMIT);
    expect(rendered.count).toBeLessThanOrEqual(RENDER_LIMIT + 8);

    // Older messages exist at the source, so the load-earlier affordance is
    // there — and it was there in the FIRST paint (Phase 1 knows `total`), not
    // inserted above the reader when Phase 2 arrived.
    await expect(page.locator('.session-show-earlier-btn').last()).toBeVisible();
  });

  test('scrolling up while the second phase lands does not move the reader', async ({ page }) => {
    // Hold Phase 2 back until the user has scrolled up, so the array is
    // re-windowed underneath a reader who is NOT at the bottom.
    let releasePhase2: (() => void) | null = null;
    const phase2Gate = new Promise<void>((resolve) => { releasePhase2 = resolve; });
    const all = Array.from({ length: TOTAL }, (_, i) => row(i));

    await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
      const isStreams = route.request().url().includes('source=streams');
      if (!isStreams) await phase2Gate;
      const take = isStreams ? STREAMS_TAIL : ARCHIVE_TAIL;
      await route.fulfill({
        json: {
          messages: all.slice(TOTAL - take),
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
            claudeSessionId: SESSION_ID, taskId: 'pw-first-open-window-task', project: 'Walnut',
            process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
            lastActiveAt: new Date().toISOString(), messageCount: TOTAL,
            title: 'First-open render window repro',
          },
        },
      });
    });

    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('domcontentloaded');

    const history = page.locator('.session-history');
    await expect(history).toContainText(`History message ${TOTAL - 1}`, { timeout: 15000 });
    await page.waitForTimeout(900);

    // Scroll up into the middle of what Phase 1 painted.
    await history.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 700); });
    await page.waitForTimeout(300);

    const anchor = page.locator(`[data-msg-index="${STREAMS_TAIL - RENDER_LIMIT}"]`);
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();
    const shBefore = await history.evaluate((el) => el.scrollHeight);

    releasePhase2!();
    // Phase 2 lands and replaces the array with a differently-indexed window.
    await expect(page.locator(`[data-msg-index="${ARCHIVE_TAIL - RENDER_LIMIT}"]`)).toBeAttached({ timeout: 15000 });
    await page.waitForTimeout(600);

    // Same content on screen ⇒ same height and the same row at the same Y.
    const shAfter = await history.evaluate((el) => el.scrollHeight);
    expect(Math.abs(shAfter - shBefore)).toBeLessThanOrEqual(80);
    const after = await page.locator(`[data-msg-index="${ARCHIVE_TAIL - RENDER_LIMIT}"]`).boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(30);
  });
});
