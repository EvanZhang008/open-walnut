/**
 * A turn bigger than the server can reach back through keeps the chat whole.
 *
 * Reported 2026-10-05 (a 336 MB session of screenshots): after a turn, every AI reply
 * vanished and the user's own messages piled up at the bottom, until a reload. The
 * turn-end delta reaches back for its anchor (whale-anchor-reach.spec.ts), but only
 * as far as one full read: a turn that appends more than that still comes back as a
 * window sharing no row with what the panel holds. The panel now keeps what it held,
 * lays the window after it with a gap, and fills the gap from older pages
 * (`?before=`). Pinned through the real panel, on 12 MB turns against the fixture's
 * 8 MB ceiling: the earlier replies stay, the user's message shows once, between them
 * and the new reply, never under the reply, and a failed fill offers a retry that
 * closes the gap.
 *
 * Uses its own copy of the whale transcript (WHALE_GAP_SESSION). The chromium and
 * webkit projects share it: run with --workers=1.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { WHALE_GAP_SESSION, WHALE_GAP_TASK } from './whale-history-fixture';

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
test.describe.configure({ mode: 'serial', timeout: 240_000 });

async function openWhale(page: Page, baseURL: string): Promise<Locator> {
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`);
  await page.getByRole('link', { name: 'Open Walnut' }).click();
  await page.locator('.todo-search-input').fill(WHALE_GAP_SESSION);
  const task = page.locator(`.todo-panel-item[data-task-id="${WHALE_GAP_TASK}"]`);
  await expect(task).toBeVisible();
  await task.locator('.todo-item-title').click();
  const panel = page.locator(`.main-page-session-column [data-session-id="${WHALE_GAP_SESSION}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('.session-msg-assistant').first()).toBeVisible({ timeout: 60_000 });
  return panel;
}

/** Each AI reply's text, in DOM order (the row's action strip filtered out). */
const replies = (panel: Locator) => panel.locator('.session-msg-assistant .session-msg-content').evaluateAll((els) =>
  els.map((el) => (el as HTMLElement).innerText.split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(MD|Rich|just now|\d+[smhd] ago)$/.test(l)).join(' ')).filter(Boolean));

/**
 * Where things sit in the timeline, as row indexes in DOM order (-1 = absent): the
 * last of the earlier replies, the user's message (and how many copies), the new
 * reply after it, and the gap divider.
 */
async function order(panel: Locator, earlierReply: string, ask: string) {
  return panel.locator('.session-history').evaluate((root, [reply, words]) => {
    const rows = Array.from(root.querySelectorAll('.session-msg-assistant, .session-msg-user, [data-testid="session-history-gap"]'));
    const text = (el: Element) => (el as HTMLElement).innerText;
    const isUser = (el: Element) => el.classList.contains('session-msg-user') && text(el).includes(words);
    let lastEarlier = -1;
    rows.forEach((el, i) => { if (el.classList.contains('session-msg-assistant') && text(el).includes(reply)) lastEarlier = i; });
    const user = rows.findIndex(isUser);
    const newReply = rows.findIndex((el, i) => i > lastEarlier && el.classList.contains('session-msg-assistant') && text(el).includes('processed your message'));
    const gap = rows.findIndex((el) => el.getAttribute('data-testid') === 'session-history-gap');
    return { lastEarlier, user, users: rows.filter(isUser).length, newReply, gap };
  }, [earlierReply, ask] as const);
}

/** The history requests the send causes (the panel's first load can still be landing). */
function watchHistory(page: Page) {
  let armed = false;
  const after = new WeakSet<object>();
  const seen: Array<{ url: string; delta?: boolean; status: number }> = [];
  page.on('request', (r) => { if (armed) after.add(r); });
  page.on('response', async (r) => {
    if (!after.has(r.request()) || r.request().method() !== 'GET') return;
    if (!r.url().includes(`/api/sessions/${WHALE_GAP_SESSION}/history`)) return;
    const body = await r.json().catch(() => null) as { delta?: boolean } | null;
    seen.push({ url: r.url(), delta: body?.delta, status: r.status() });
  });
  return { arm: () => { armed = true; }, seen };
}

/** A 12 MB turn (ten 1.2 MB tool results) that takes 15 s, the way a run of
 *  screenshots does: past the 8 MB ceiling the delta can reach back through. */
async function sendHeavyTurn(panel: Locator, ask: string) {
  const box = panel.locator('.chat-input-textarea').first();
  await box.click();
  await box.fill(`slow:15000 ${ask} MOCK_HEAVY_RESULTS:10x1200`);
  await box.press('Enter');
}

test('a turn past the reach keeps the earlier replies and fills the gap in order', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const panel = await openWhale(page, baseURL!);
  const earlier = await replies(panel);
  expect(earlier.length, 'earlier replies are on screen').toBeGreaterThan(0);
  const lastEarlier = earlier[earlier.length - 1];

  const history = watchHistory(page);
  history.arm();
  const ask = `gap screenshots ${Date.now()}`;
  await sendHeavyTurn(panel, ask);
  await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 90_000 });
  await expect.poll(() => history.seen.some((r) => r.url.includes('before=')), { timeout: 60_000 }).toBe(true);
  await expect(panel.getByTestId('session-history-gap')).toHaveCount(0, { timeout: 60_000 });
  await page.waitForTimeout(1000);

  expect(history.seen.some((r) => r.url.includes('since=') && r.delta === false), 'the delta was declined').toBe(true);
  expect(await replies(panel), 'the last earlier reply is still on screen').toContain(lastEarlier);
  const at = await order(panel, lastEarlier, ask);
  expect(at.users, 'the user message shows once').toBe(1);
  expect(at.user, 'after the earlier replies').toBeGreaterThan(at.lastEarlier);
  expect(at.newReply, 'and before the new reply').toBeGreaterThan(at.user);
  expect(errors).toEqual([]);
});

test('while the gap cannot be filled the message is never under the reply; retry fills it', async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const panel = await openWhale(page, baseURL!);
  const earlier = await replies(panel);
  const lastEarlier = earlier[earlier.length - 1];

  // Older pages fail until released.
  let failPages = true;
  await page.route((url) => url.pathname.endsWith(`/api/sessions/${WHALE_GAP_SESSION}/history`) && url.searchParams.has('before'), async (route) => {
    if (failPages) await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"read failed"}' });
    else await route.continue();
  });
  const ask = `gap retry ${Date.now()}`;
  await sendHeavyTurn(panel, ask);
  const divider = panel.getByTestId('session-history-gap');
  await expect(divider).toHaveAttribute('data-state', 'failed', { timeout: 90_000 });
  await expect(divider).toContainText('Could not load the messages here.');
  await expect(panel.locator('.session-history')).toContainText('processed your message');
  await page.waitForTimeout(1000);

  const during = await order(panel, lastEarlier, ask);
  expect(during.lastEarlier, 'the earlier replies are still there').toBeGreaterThanOrEqual(0);
  expect(during.gap, 'the gap sits after them').toBeGreaterThan(during.lastEarlier);
  expect(during.newReply, 'and before the new reply').toBeGreaterThan(during.gap);
  // The user's row is in the gap or before it: never a second copy, never a bubble
  // pinned under the reply.
  expect(during.users, 'the user message shows at most once').toBeLessThanOrEqual(1);
  if (during.users === 1) expect(during.user, 'and not under the reply').toBeLessThan(during.newReply);

  failPages = false;
  await divider.getByRole('button', { name: 'Try again' }).click();
  await expect(divider).toHaveCount(0, { timeout: 60_000 });
  const after = await order(panel, lastEarlier, ask);
  expect(after.users).toBe(1);
  expect(after.user).toBeGreaterThan(after.lastEarlier);
  expect(after.newReply).toBeGreaterThan(after.user);
  expect(errors).toEqual([]);
});
