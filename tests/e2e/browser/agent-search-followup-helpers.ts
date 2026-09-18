/**
 * Shared kit for "ask the follow-up inside the ✦ card" (AgentSearchFollowUp).
 *
 * The card is the small window in the task panel: after the search answers, a
 * composer under the rows continues THAT search's own conversation, without a
 * session column opening. Both engines need the same scenarios — Chromium for the
 * behaviour matrix, WebKit because the Mac app is a WKWebView and this is a
 * transcript living inside a narrow panel (wrap/ellipsis/overflow geometry is
 * exactly where the two engines disagree). A `test.use` browser pin only applies
 * at a spec file's top level, hence helpers rather than a flag.
 *
 * The fixture server has no AI lane, so the lane's answer is stubbed at the
 * network edge while the SESSION the follow-up lands in is real: a quick-start
 * session with the mock CLI behind it, handed back by the stubbed adopt call the
 * way the server would hand back the search's own session on a live Mac.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { homeColumns } from './draft-helpers';
import { isQuickStart, openBtn, panel } from './agent-search-open-session-helpers';

export const SCREENSHOT_DIR = process.env.FOLLOWUP_SHOT_DIR ?? '/tmp/agent-search-followup';

export const followUp = (page: Page): Locator => page.getByTestId('agent-search-followup');
export const followUpInput = (page: Page): Locator => followUp(page).locator('.chat-input-textarea');
export const followUpHistory = (page: Page): Locator => followUp(page).locator('.session-history');

export interface AdoptStub {
  bodies: Array<{ q?: string; search?: boolean; progressId?: string }>;
}

/** Seed a real session and answer the adopt call with it (what the server does). */
export async function seedAdoptedSession(page: Page, label: string): Promise<{ sessionId: string; stub: AdoptStub }> {
  const seeded = await page.request.post('/api/sessions/quick-start', {
    data: {
      cwd: '', message: `seeded followup ${label}`, project: 'Ask Walnut',
      walnutAgent: true, taskMeta: { pinTier: 'focus' },
    },
  });
  expect(seeded.status(), await seeded.text()).toBe(200);
  const { sessionId, taskId } = await seeded.json() as { sessionId: string; taskId: string };
  const stub: AdoptStub = { bodies: [] };
  await page.route('**/api/search/agent/session', async (route) => {
    stub.bodies.push(route.request().postDataJSON() as { q?: string });
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ sessionId, taskId, reused: stub.bodies.length > 1 }),
    });
  });
  return { sessionId, stub };
}

/**
 * Put a query in the search box and make sure it STAYS there.
 *
 * React owns that input: a `fill` that lands during the first render is thrown
 * away by the next one, and the test then waits forever for a card that never
 * had a query (seen under a parallel run — the failure screenshot showed an empty
 * box). So keep filling until the value sticks.
 */
export async function typeSearch(page: Page, query: string): Promise<void> {
  const box = page.locator('.todo-search-input');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    if ((await box.inputValue()) !== query) await box.fill(query);
    return box.inputValue();
  }, { timeout: 30_000, message: 'the search box never kept the query' }).toBe(query);
}

/** The composer only exists once there is an answer to follow up ON. */
export async function expectComposerWaitsForTheAnswer(page: Page, query: string): Promise<void> {
  await typeSearch(page, query);
  await expect(panel(page)).toHaveClass(/is-loading/);
  // While searching, the header's button is the only way in — a composer here
  // would invite a question about an answer that does not exist yet.
  await expect(followUp(page)).toHaveCount(0);
  await expect(panel(page)).toHaveClass(/is-done/, { timeout: 30_000 });
  await expect(followUpInput(page)).toBeVisible({ timeout: 20_000 });
}

/** Type a follow-up in the card and send it. */
export async function askInCard(page: Page, text: string): Promise<void> {
  const box = followUpInput(page);
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.fill(text);
  await box.press('Enter');
}

/**
 * The question is answered INSIDE the card: the conversation appears there, the
 * mock CLI's reply lands in it, and no session column opens — the whole point.
 */
export async function expectAnsweredInsideTheCard(page: Page, text: string): Promise<void> {
  const columnsBefore = await homeColumns(page).count();
  const quickStarts: string[] = [];
  page.on('request', (req) => { if (isQuickStart(req)) quickStarts.push(req.url()); });

  await askInCard(page, text);

  // The window goes live with the session's own transcript…
  await expect(followUpHistory(page)).toBeVisible({ timeout: 30_000 });
  // …carrying the question that was typed, and the CLI's answer to it.
  await expect(followUp(page).getByText(text, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(followUp(page).getByText(new RegExp(`I processed your message: ${text}`)).first())
    .toBeVisible({ timeout: 60_000 });

  // Nothing was launched and no column appeared: the conversation stayed here.
  expect(quickStarts, 'asking in the card must not launch a session').toHaveLength(0);
  expect(await homeColumns(page).count(), 'asking in the card must not open a column').toBe(columnsBefore);
}

/**
 * The card's own rows step aside while the window is live, because the transcript
 * renders the SAME answer card as its second message — both would be the same
 * rows twice in a panel this narrow. And the header button now offers the column.
 */
export async function expectRowsSteppedAside(page: Page): Promise<void> {
  // DIRECT child on purpose: on a live Mac the transcript inside the window shows
  // that same answer card as its second message, so an unscoped locator would
  // match the window's own rows and this would assert the opposite of the point.
  await expect(panel(page).locator('> .agent-search-results')).toHaveCount(0);
  await expect(panel(page).locator('> .agent-search-summary')).toHaveCount(0);
  await expect(openBtn(page)).toHaveText(/Open full session/);
}

/**
 * The window is a WINDOW: capped in height, scrolling inside itself, and it never
 * widens the task panel (a transcript carries code blocks and long paths).
 */
export async function expectWindowStaysInItsBox(page: Page): Promise<void> {
  const history = followUpHistory(page);
  const geometry = await history.evaluate((el) => ({
    height: Math.round(el.getBoundingClientRect().height),
    viewport: window.innerHeight,
    overflowY: getComputedStyle(el).overflowY,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(geometry.overflowY, JSON.stringify(geometry)).toMatch(/auto|scroll/);
  expect(geometry.height, `the window must stay short: ${JSON.stringify(geometry)}`)
    .toBeLessThanOrEqual(Math.round(geometry.viewport * 0.45));
  expect(geometry.scrollWidth, `the transcript must not scroll sideways: ${JSON.stringify(geometry)}`)
    .toBeLessThanOrEqual(geometry.clientWidth + 1);

  // The panel it lives in is unchanged: no horizontal scrollbar anywhere above it.
  const panelBox = await page.locator('.main-page-todo').evaluate((el) => ({
    scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
  }));
  expect(panelBox.scrollWidth, `the task panel must not scroll sideways: ${JSON.stringify(panelBox)}`)
    .toBeLessThanOrEqual(panelBox.clientWidth + 1);

  // Every control still ends inside the card (the panel CLIPS overflow, so a
  // composer past that edge would be invisible AND unclickable).
  const card = (await panel(page).boundingBox())!;
  const box = (await followUpInput(page).boundingBox())!;
  expect(box.x + box.width, 'the composer must end inside the card').toBeLessThanOrEqual(card.x + card.width + 1);
  expect(box.width, 'the composer must not be collapsed').toBeGreaterThan(10);
}
