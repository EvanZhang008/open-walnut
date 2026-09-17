/**
 * Shared kit for the ✦ AI search card's "Open as session" specs.
 *
 * Exists because the two engines need the SAME scenarios: Chromium for the
 * behaviour matrix, WebKit because the Mac app is a WKWebView (a `test.use`
 * browser pin only works at a spec file's top level, so the WebKit half has to
 * be its own file — hence these helpers rather than a flag someone remembers).
 */
import { expect, type Locator, type Page, type Request } from '@playwright/test';
import { loadHome } from './draft-helpers';

export const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/agent-search-open-session';
export const TARGET_TASK_ID = 'pw-task-001';

/** Eligible for the AI lane (two words, > 6 chars) and unique per run, so board
 *  lookups never collide with a previous run's tasks. */
export const uniqueQuery = (label: string): string =>
  `resume button always showing ${label}${Date.now().toString(36)}`;

export const AGENT_PAYLOAD = {
  summary: 'The resume-button work lives in one task.',
  results: [{
    taskId: TARGET_TASK_ID,
    title: 'Playwright test task',
    phase: 'TODO',
    project: 'pw-fixtures',
    evidence: 'composer Stop killed the long-lived CLI so the next send cold-resumed',
    confidence: 'high',
  }],
  model: 'haiku',
  tookMs: 1234,
  cached: false,
};

export const EMPTY_PAYLOAD = { summary: 'Nothing matched.', results: [], model: 'haiku', tookMs: 5 };

export interface QuickStartBody {
  cwd?: string;
  message?: string;
  project?: string;
  walnutAgent?: boolean;
  taskMeta?: { pinTier?: string | null };
  model?: string;
}

export const isQuickStart = (req: Request): boolean =>
  req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start';

export async function stubAgentSearch(
  page: Page,
  respond: () => { status: number; body: unknown; delayMs?: number },
): Promise<{ calls: number }> {
  const stub = { calls: 0 };
  // Matched by PATHNAME, not by a `**/api/search/agent**` glob: the adopt call
  // (POST /api/search/agent/session) lives one segment below the lane and a glob
  // swallows it, so the card's own stub would answer a search payload to the
  // "reopen" request — which is how the first run of these tests hung.
  await page.route(
    (url) => url.pathname === '/api/search/agent',
    async (route) => {
      stub.calls++;
      const { status, body, delayMs } = respond();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    },
  );
  return stub;
}

/** The instant lane finds nothing — the production shape where only the AI lane
 *  (or a full session) has an answer. */
export async function stubEmptyInstantSearch(page: Page): Promise<void> {
  await page.route('**/api/search?**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [] }) });
  });
}

export async function openHome(page: Page, opts: { aiOn?: boolean; todoWidthPct?: number } = {}): Promise<void> {
  const { aiOn = true, todoWidthPct } = opts;
  await page.addInitScript(({ on, width }) => {
    localStorage.setItem('open-walnut-agent-search', on ? '1' : '0');
    if (width !== undefined) localStorage.setItem('open-walnut-todo-width', String(width));
  }, { on: aiOn, width: todoWidthPct });
  await loadHome(page);
}

export const panel = (page: Page): Locator => page.getByTestId('agent-search-panel');
export const openBtn = (page: Page): Locator => page.getByTestId('agent-search-open-session');
export const laneToggle = (page: Page): Locator =>
  panel(page).locator('.agent-search-header .agent-search-toggle');

/** Every label in the card's header stays on ONE line (the header wraps as
 *  GROUPS, never inside a phrase — "AI" over "search" was the first version at
 *  ~300px). */
export async function expectUnwrappedLabels(page: Page): Promise<void> {
  for (const cls of ['.agent-search-label', '.agent-search-empty-note', '.agent-search-elapsed']) {
    const el = panel(page).locator(cls);
    if (await el.count() === 0) continue;
    const box = (await el.first().boundingBox())!;
    expect(box.height, `${cls} must stay on one line`).toBeLessThan(20);
  }
}

/** A control is inside the card's own box. `.main-page-todo` CLIPS overflow, so a
 *  control past that edge is invisible and unclickable — which `toBeVisible()`
 *  reports as fine. */
export async function expectInsideCard(page: Page, control: Locator, label: string): Promise<void> {
  const card = (await panel(page).boundingBox())!;
  const box = (await control.boundingBox())!;
  expect(box.x + box.width, `${label} must end inside the card`).toBeLessThanOrEqual(card.x + card.width + 1);
  expect(box.x, `${label} must start inside the card`).toBeGreaterThanOrEqual(card.x - 1);
  expect(box.width, `${label} must not be collapsed`).toBeGreaterThan(10);
}

/** Click the button and return the quick-start the click sent (body + response). */
export async function clickOpenSession(
  page: Page,
): Promise<{ body: QuickStartBody; taskId: string; sessionId: string }> {
  const quickStart = page.waitForResponse((res) => isQuickStart(res.request()));
  await openBtn(page).click();
  const response = await quickStart;
  expect(response.status(), await response.text()).toBe(200);
  const body = response.request().postDataJSON() as QuickStartBody;
  const result = (await response.json()) as { taskId?: string; sessionId?: string };
  expect(result.taskId, 'the launch response carried no taskId').toBeTruthy();
  expect(result.sessionId, 'the launch response carried no sessionId').toBeTruthy();
  return { body, taskId: result.taskId!, sessionId: result.sessionId! };
}

// ── Scenarios shared by both engines ─────────────────────────────────────────

/**
 * ONE click, no typing: the card hands the question to a real Ask Walnut session
 * whose panel is on screen and already answering.
 *
 * Engine-relevant, not just a smoke test: a WebKit button does not take focus on
 * mousedown, so a click on a control inside a scrollable strip can be swallowed
 * by the scroll (a shipped bug for the CronPill / TRIGGER pill).
 */
export async function expectOneClickOpensSession(page: Page, query: string): Promise<string> {
  await page.locator('.todo-search-input').fill(query);
  await expect(openBtn(page)).toBeVisible({ timeout: 20_000 });
  const { body, sessionId } = await clickOpenSession(page);
  expect(body.walnutAgent).toBe(true);
  expect(body.project).toBe('Ask Walnut');
  expect(body.message?.split('\n')[0]).toBe(`Find everything about: ${query}`);

  const column = page.locator(`.main-page-session-column:has([data-session-id="${sessionId}"])`);
  await expect(column).toBeVisible({ timeout: 60_000 });
  await expect(column.getByText(new RegExp(`I processed your message: Find everything about: ${query}`)).first())
    .toBeVisible({ timeout: 60_000 });
  return sessionId;
}

/**
 * At the task panel's NARROWEST width (10% of the viewport, the resize clamp)
 * every control still sits inside the card, in both AI-lane states.
 *
 * Layout, so it is engine-specific: the card's controls survive by wrapping as
 * groups and by ellipsizing the chip's label, and wrap/ellipsis geometry is
 * exactly where WebKit and Chromium differ.
 */
export async function expectNothingClippedAtNarrowest(page: Page, query: string, shotPrefix: string): Promise<void> {
  await page.locator('.todo-search-input').fill(query);
  await expect(openBtn(page)).toBeVisible({ timeout: 20_000 });
  await expectUnwrappedLabels(page);
  await expectInsideCard(page, openBtn(page), 'the session chip');
  await expectInsideCard(page, laneToggle(page), 'the ✦ toggle');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${shotPrefix}-on.png`, clip: { x: 0, y: 0, width: 640, height: 320 } });

  // Same for the OFF row, whose own label plus the chip is the widest content the
  // card ever has to hold at this width.
  await laneToggle(page).click();
  await expect(panel(page)).toHaveClass(/is-off/);
  await expectInsideCard(page, panel(page).locator('.agent-search-enable'), 'the Enable row');
  await expectInsideCard(page, openBtn(page), 'the session chip (lane off)');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${shotPrefix}-off.png`, clip: { x: 0, y: 0, width: 640, height: 320 } });
  // Leave the shared pref as every other spec expects it.
  await panel(page).locator('.agent-search-enable').click();
  await expect(panel(page)).not.toHaveClass(/is-off/);
}
