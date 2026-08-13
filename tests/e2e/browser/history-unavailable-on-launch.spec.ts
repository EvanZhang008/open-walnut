/**
 * Playwright browser test: creating a task must NOT flash
 * "History unavailable — Session history file not found".
 *
 * Reported bug (user screenshot): every task creation showed that card on the
 * brand-new session — a Running session with visible system messages sitting
 * UNDER a "file not found" box, which is self-contradictory.
 *
 * Root cause (fixed, three layers):
 *   1. `sourceAvailable` was inferred from `messages.length > 0`, so a booting
 *      CLI's JSONL — which exists and is growing, but holds only system/hook
 *      lines for its first seconds — was reported as a MISSING FILE.
 *   2. During a session's startup window the transcript genuinely doesn't exist
 *      yet (measured on a real launch: history fetched at +0.8s, first JSONL line
 *      at +4.8s). That is expected, not a fault, so the server now answers a
 *      plain empty history instead of an unavailable reason.
 *   3. Client backstop: the card is a LAST-RESORT state and is suppressed
 *      whenever the session has any visible content.
 *
 * This asserts the user-visible guarantee against a REAL browser and the real
 * React components: an unavailable answer that arrives while the session is
 * streaming/has content never paints the card, and a genuinely dead session with
 * no transcript still gets a clear explanation.
 */
import { test, expect, type Page } from '@playwright/test';

const LIVE_SESSION_ID = 'pw-hist-launch-session';
const DEAD_SESSION_ID = 'pw-hist-dead-session';
const FORK_SESSION_ID = 'pw-hist-fork-session';

const UNAVAILABLE_CARD = '.session-history-unavailable';

function sessionPayload(id: string, overrides: Record<string, unknown> = {}) {
  return {
    session: {
      claudeSessionId: id,
      taskId: `${id}-task`,
      project: 'Walnut',
      process_status: 'running',
      mode: 'bypass',
      startedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 1,
      title: 'Fix Walnut: history unavailable repro',
      ...overrides,
    },
  };
}

async function mockSessionDetail(page: Page, id: string, overrides: Record<string, unknown> = {}) {
  await page.route(`**/api/sessions/${id}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback();
    await route.fulfill({ json: sessionPayload(id, overrides) });
  });
}

test.describe('History unavailable card on a freshly launched session', () => {
  test('does NOT appear while the just-launched session already shows content', async ({ page }) => {
    // The server's fixed behavior during the startup window: a plain empty
    // history (NO historyUnavailable), while the session's own rows render.
    const messages = [
      { role: 'user', text: 'Fix Walnut: add all the modes', timestamp: '2026-08-09T00:00:00.000Z' },
      { role: 'assistant', text: 'Looking into the mode list now.', timestamp: '2026-08-09T00:00:01.000Z' },
    ];

    await page.route(`**/api/sessions/${LIVE_SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('source') === 'streams') {
        return route.fulfill({ json: { messages, total: messages.length } });
      }
      return route.fulfill({
        json: { messages, total: messages.length, cursor: messages.length, delta: false },
      });
    });
    await mockSessionDetail(page, LIVE_SESSION_ID);

    await page.goto(`/sessions?id=${LIVE_SESSION_ID}`);
    await page.waitForLoadState('networkidle');

    const history = page.locator('.session-history');
    await expect(history).toContainText('Looking into the mode list now.', { timeout: 15000 });

    // The exact regression: no "History unavailable" card over live content.
    await expect(page.locator(UNAVAILABLE_CARD)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Session history file not found');
    // And the internal marker must never leak into the generic error banner.
    await expect(page.locator('body')).not.toContainText('HISTORY_UNAVAILABLE');
  });

  test('is SUPPRESSED even if the server still reports unavailable, when content exists', async ({ page }) => {
    // Belt-and-braces: an old/replica server (or a race) may still answer
    // `historyUnavailable`. With content on screen the card must stay hidden —
    // that contradiction is what the user photographed.
    const messages = [
      { role: 'user', text: 'Fix Walnut: add all the modes', timestamp: '2026-08-09T00:00:00.000Z' },
      { role: 'assistant', text: 'Working on the mode list.', timestamp: '2026-08-09T00:00:01.000Z' },
    ];
    let fullFetches = 0;

    await page.route(`**/api/sessions/${LIVE_SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      // Phase 1 (local streams) delivers the content...
      if (url.searchParams.get('source') === 'streams') {
        return route.fulfill({ json: { messages, total: messages.length } });
      }
      // ...while the full fetch claims the file is missing.
      fullFetches++;
      return route.fulfill({
        json: {
          messages: [], total: 0, cursor: 0, delta: false,
          historyUnavailable: 'Session history file not found',
        },
      });
    });
    await mockSessionDetail(page, LIVE_SESSION_ID);

    await page.goto(`/sessions?id=${LIVE_SESSION_ID}`);
    await page.waitForLoadState('networkidle');

    const history = page.locator('.session-history');
    await expect(history).toContainText('Working on the mode list.', { timeout: 15000 });
    expect(fullFetches, 'the full fetch must have run (otherwise this proves nothing)').toBeGreaterThan(0);

    await expect(page.locator(UNAVAILABLE_CARD)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('HISTORY_UNAVAILABLE');
  });

  test('a fresh FORK renders the inherited parent conversation, not the unavailable card', async ({ page }) => {
    // A fork's own transcript is empty by definition — its whole value is the
    // parent conversation the server prepends. The old route decided "nothing to
    // show" BEFORE loading the ancestors, so a fork showed the unavailable card
    // and lost the parent history entirely.
    const inherited = [
      { role: 'user', text: 'Parent: refactor the mode picker', timestamp: '2026-08-09T00:00:00.000Z' },
      { role: 'assistant', text: 'Parent answer with the plan', timestamp: '2026-08-09T00:00:01.000Z' },
    ];

    await page.route(`**/api/sessions/${FORK_SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      // The fork has no local transcript of its own yet.
      if (url.searchParams.get('source') === 'streams') {
        return route.fulfill({ json: { messages: [], total: 0 } });
      }
      // The full path answers with the ancestor prefix + the fork boundary.
      return route.fulfill({
        json: {
          messages: inherited,
          total: inherited.length,
          cursor: inherited.length,
          delta: false,
          forkedFromSessionId: 'pw-hist-fork-parent',
          forkBoundaryIndex: inherited.length,
        },
      });
    });
    await mockSessionDetail(page, FORK_SESSION_ID, {
      forkedFromSessionId: 'pw-hist-fork-parent',
      title: 'Fork of parent session',
    });

    await page.goto(`/sessions?id=${FORK_SESSION_ID}`);
    await page.waitForLoadState('networkidle');

    const history = page.locator('.session-history');
    await expect(history).toContainText('Parent answer with the plan', { timeout: 15000 });
    await expect(page.locator(UNAVAILABLE_CARD)).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('Session history file not found');
  });

  test('STILL explains itself for a dead session that has no transcript at all', async ({ page }) => {
    // The card must not be neutered: with genuinely nothing to show, the user
    // needs the reason.
    await page.route(`**/api/sessions/${DEAD_SESSION_ID}/history**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('source') === 'streams') {
        return route.fulfill({ json: { messages: [], total: 0 } });
      }
      return route.fulfill({
        json: {
          messages: [], total: 0, cursor: 0, delta: false,
          historyUnavailable: 'Session history file not found',
        },
      });
    });
    await mockSessionDetail(page, DEAD_SESSION_ID, {
      process_status: 'stopped',
      messageCount: 0,
      title: 'Dead session, no transcript',
    });

    await page.goto(`/sessions?id=${DEAD_SESSION_ID}`);
    await page.waitForLoadState('networkidle');

    const card = page.locator(UNAVAILABLE_CARD);
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('History unavailable');
    await expect(card).toContainText('Session history file not found');
  });
});
