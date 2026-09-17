/**
 * Playwright browser test: the transcript's ↓ affordance follows GEOMETRY.
 *
 * Reported bug (2026-09-16): "there is clearly more below, but somehow I just
 * cannot scroll down to it — and if I make the panel narrower I can suddenly see
 * what is down there." The window sat on a session whose transcript had grown by
 * 2,425px under a stationary reader (its own flicker sentinel logged
 * `stationary net=2425 top=0 ... atBot=false`) with no ↓ button on screen: the
 * newest rows were off screen and the affordance that leads to them was hidden.
 *
 * Cause: the arrow's visibility was computed in ONE place, the tail of the scroll
 * handler. Content can grow with NO scroll event at all — a row that expands
 * above the viewport pushes everything below it down while scrollTop keeps the
 * same number — and no follow-bottom path watches that shape either (no messages
 * change, no new stream blocks, no image load, no container resize). The 2Hz
 * sentinel poll was already measuring that growth for its flicker log and said
 * nothing about the arrow. The handler also kept a local mirror of the state and
 * skipped equal values, while four paths outside that closure set the flag
 * directly, so the mirror could drift and swallow the update that brings it back.
 *
 * The first case drives that exact shape: click a collapsed row that sits ABOVE
 * the viewport, via dispatchEvent so nothing scrolls it into view. Verified as a
 * negative control — with the fix neutered it fails, which is what the earlier
 * version of this file (clicking an on-screen row, which does fire a scroll
 * event) did not do.
 */
import { test, expect, type Page } from '@playwright/test';

const SESSION_ID = 'pw-scroll-arrow-geometry-session';
const ROWS = 220;

function row(i: number) {
  return {
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `Transcript row ${i}\n\n${'the quick brown fox jumps over the lazy dog '.repeat(4)}`,
    msgId: `arrow-m${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  };
}

/** A tool-only assistant row renders as ONE collapsed `tool-run-row`; opening it
 *  adds a page of output. Every fourth row is one, so there is always something
 *  collapsed above the viewport to open. */
function toolRow(i: number) {
  return {
    role: 'assistant',
    text: '',
    msgId: `arrow-tool-${i}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, i)).toISOString(),
    tools: [{
      name: 'Read',
      input: { file_path: `/tmp/arrow-fixture/file-${i}.txt` },
      result: Array.from({ length: 60 }, (_, k) => `line ${k} of the tool output for row ${i}`).join('\n'),
    }],
  };
}

async function mockSession(page: Page) {
  const messages = Array.from({ length: ROWS }, (_, i) => (i % 4 === 3 ? toolRow(i) : row(i)));
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({
      json: {
        messages,
        total: ROWS,
        ...(route.request().url().includes('source=streams') ? {} : { cursor: ROWS }),
        delta: false,
      },
    });
  });
  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID, taskId: 'pw-scroll-arrow-geometry-task', project: 'Walnut',
          process_status: 'idle', mode: 'bypass', startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(), messageCount: ROWS,
          title: 'Scroll arrow geometry repro',
        },
      },
    });
  });
}

const historyOf = (page: Page) => page.locator('.session-history').first();
const arrowOf = (page: Page) => page.locator('.scroll-to-bottom-btn').first();

/** The arrow is always in the DOM; `visible` is the class that shows it. */
const arrowShown = (page: Page) => arrowOf(page).evaluate((el) => el.classList.contains('visible'));

const geometry = (page: Page) => historyOf(page).evaluate((el) => ({
  top: Math.round(el.scrollTop),
  gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
  sh: el.scrollHeight,
}));

/** Open collapsed runs whose boxes are ABOVE the visible area, without scrolling
 *  them into view: Playwright's own click would scroll first, which fires the very
 *  event this test has to do without. */
async function openRunsAboveViewport(page: Page, want: number): Promise<number> {
  return historyOf(page).evaluate((el, n) => {
    const viewportTop = el.getBoundingClientRect().top;
    let opened = 0;
    for (const btn of el.querySelectorAll<HTMLElement>('.tool-run-toggle')) {
      if (btn.getBoundingClientRect().bottom >= viewportTop) break; // reached the viewport
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      if (++opened >= n) break;
    }
    return opened;
  }, want);
}

test.describe('Transcript ↓ arrow follows geometry', () => {
  test('growth that fires no scroll event still leaves a way back to the newest row', async ({ page }) => {
    await mockSession(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('domcontentloaded');
    const history = historyOf(page);
    await expect(history).toContainText(`Transcript row ${ROWS - 2}`, { timeout: 15000 });
    // Let the load-window pin retire, so nothing but this test moves the view.
    await page.waitForTimeout(2500);

    // Sitting ON the newest row: nothing to offer, so no affordance.
    await history.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(700);
    const before = await geometry(page);
    expect(before.gap, 'the reader starts on the newest row').toBeLessThanOrEqual(80);
    await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(false);

    // Rows ABOVE the viewport expand: scrollTop keeps its number, the content
    // below moves down, and the newest row leaves the screen.
    const opened = await openRunsAboveViewport(page, 12);
    expect(opened, 'the fixture must have collapsed runs above the viewport').toBeGreaterThan(0);
    await expect.poll(async () => (await geometry(page)).gap, { timeout: 6000 })
      .toBeGreaterThan(150);
    const grown = await geometry(page);
    expect(grown.top, 'no scroll happened — only the content grew').toBe(before.top);
    expect(grown.sh).toBeGreaterThan(before.sh);

    // The point: the reader can see there is a way back, and it works.
    await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(true);
    await arrowOf(page).click();
    await page.waitForTimeout(900);
    expect((await geometry(page)).gap).toBeLessThanOrEqual(80);
    await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(false);
  });

  test('a reader parked mid-history keeps the way back across a resize', async ({ page }) => {
    await mockSession(page);
    await page.goto(`/sessions?id=${SESSION_ID}`);
    await page.waitForLoadState('domcontentloaded');
    const history = historyOf(page);
    await expect(history).toContainText(`Transcript row ${ROWS - 2}`, { timeout: 15000 });
    await page.waitForTimeout(2500);

    // Leave the bottom the way a person does — a wheel UP, which is also what
    // tells the panel to stop following.
    await history.hover();
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400);
    await page.waitForTimeout(1000);
    expect((await geometry(page)).gap, 'the wheel must leave the bottom').toBeGreaterThan(400);
    await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(true);

    // A resize arms the panel's ignore window (scroll events are suppressed for
    // 350ms so a sibling's growth cannot corrupt follow-bottom intent) and
    // reflows every row. The reader is still above the newest row, so the way
    // back must survive it.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForTimeout(1500);
    expect((await geometry(page)).gap, 'still parked above the newest row').toBeGreaterThan(200);
    await expect.poll(() => arrowShown(page), { timeout: 4000 }).toBe(true);
  });
});
