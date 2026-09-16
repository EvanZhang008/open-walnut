/**
 * ✦ AI search card → "Open as session".
 *
 * The one-shot AI lane answers with a fixed tool budget; this button hands the
 * same question to a FULL Ask Walnut session in one click, no composer step:
 * a session column opens (pending, then the real panel), the task is filed under
 * the Ask Walnut project, and the user can keep asking in that column.
 *
 * The AI lane is stubbed at the network edge (its states are what the button
 * has to survive: still searching, done with rows, done empty, failed, off);
 * the quick-start itself is REAL against the fixture server + mock CLI, so the
 * column, the transcript and the task on the board are the product's own.
 */
import { expect, test } from '@playwright/test';
import { REAL_PANEL, REAL_PANEL_IN_COLUMN, homeColumns } from './draft-helpers';
import {
  AGENT_PAYLOAD, EMPTY_PAYLOAD, SCREENSHOT_DIR, TARGET_TASK_ID, clickOpenSession,
  expectNothingClippedAtNarrowest, expectUnwrappedLabels, isQuickStart, laneToggle, openBtn,
  openHome, panel, stubAgentSearch, stubEmptyInstantSearch, uniqueQuery,
  type QuickStartBody,
} from './agent-search-open-session-helpers';

const STAMP = Date.now().toString(36);
const QUERY = uniqueQuery('c');

// The AI toggle is a shared open-walnut- localStorage pref, and every test here
// mints real sessions on the one fixture server. Serial = correctness.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('one click while the AI lane is still searching: pending column, real session, Ask Walnut task, and a follow-up works', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  // A slow lane: the button has to work BEFORE the quick search answers (the
  // screenshot that asked for this feature showed a 14s "searching…").
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 20_000 }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveClass(/is-loading/);
  const btn = openBtn(page);
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveText(/Open as session/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-loading-with-button.png`, clip: { x: 0, y: 0, width: 1280, height: 400 } });

  const columnsBefore = await homeColumns(page).count();
  // Armed before the click: the pending column can be a single frame wide when
  // the response carries the session id, so it is noted, never required.
  const pendingSeen = page.locator('.main-page-session-column .pending-session-panel')
    .waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);

  const { body, taskId, sessionId } = await clickOpenSession(page);

  // The payload is the walnut draft's own launch: server-owned cwd, Ask Walnut
  // project, Focus tier, no model (the launch memory applies server-side), and
  // a message that names the question first and asks for the full search.
  expect(body.walnutAgent).toBe(true);
  expect(body.cwd).toBe('');
  expect(body.project).toBe('Ask Walnut');
  expect(body.taskMeta?.pinTier).toBe('focus');
  expect(body.model).toBeUndefined();
  expect(body.message?.split('\n')[0]).toBe(`Find everything about: ${QUERY}`);
  expect(body.message).toMatch(/tasks, sessions \(including their transcripts\), memory and notes/);
  // Still searching → nothing to seed: no candidates section.
  expect(body.message).not.toMatch(/quick AI search already found/);

  // A NEW session column, bound to the id the launch minted, with the real panel.
  const column = page.locator(`.main-page-session-column:has([data-session-id="${sessionId}"])`);
  await expect(column).toBeVisible({ timeout: 60_000 });
  await expect(homeColumns(page)).toHaveCount(columnsBefore + 1);
  const realPanel = column.locator(REAL_PANEL_IN_COLUMN);
  await expect(realPanel).toBeVisible({ timeout: 60_000 });

  // The user's first message is on the transcript, and the (mock) CLI answered
  // it — proof the session ran on the seeded briefing with no typing.
  await expect(column.getByText(`Find everything about: ${QUERY}`).first()).toBeVisible({ timeout: 60_000 });
  await expect(column.getByText(new RegExp(`I processed your message: Find everything about: ${QUERY}`)).first())
    .toBeVisible({ timeout: 60_000 });

  // Filed as an ask: walnut_agent, under the Ask Walnut project, Focus tier.
  const { task } = await (await page.request.get(`/api/tasks/${taskId}`)).json() as {
    task: { project?: string; walnut_agent?: boolean };
  };
  expect(task.project).toBe('Ask Walnut');
  expect(task.walnut_agent).toBe(true);

  // The AI card is untouched by the launch: still searching, button re-enabled.
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveText(/Open as session/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-session-column-open.png`, fullPage: false });

  // FOLLOW-UP — the half of the feature the button promises ("you can keep
  // asking"): the column's composer is the regular session composer, and the
  // session answers the second question.
  const followUp = `and which one is still open ${STAMP}`;
  const composer = column.locator('.chat-input-textarea');
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill(followUp);
  await composer.press('Enter');
  // ANSWERED, live, in the panel the user is looking at.
  await expect(column.getByText(new RegExp(`I processed your message: ${followUp}`)).first())
    .toBeVisible({ timeout: 60_000 });
  // …and on the transcript, so the answer survives the window.
  await expect.poll(async () => {
    const res = await page.request.get(`/api/v1/sessions/${sessionId}/history?tail=50`);
    return res.ok() ? (await res.text()).includes(`I processed your message: ${followUp}`) : false;
  }, { timeout: 60_000, message: 'the follow-up was never answered on the transcript' }).toBe(true);

  // Both turns come back on the next load (the fixture's CLI exits after every
  // turn, so the follow-up rode a cold `--resume` — its reply must be part of the
  // conversation, not just of the live stream).
  await page.reload();
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 });
  const reopened = page.locator(`.main-page-session-column:has([data-session-id="${sessionId}"])`);
  await expect(reopened.getByText(new RegExp(`I processed your message: ${followUp}`)).first())
    .toBeVisible({ timeout: 60_000 });
  await expect(reopened.getByText(new RegExp(`I processed your message: Find everything about: ${QUERY}`)).first())
    .toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-follow-up-answered.png`, fullPage: false });

  if (!(await pendingSeen)) {
    test.info().annotations.push({ type: 'note', description: 'pending column was shorter than one frame (not a failure)' });
  }
});

test('a finished search seeds its rows into the briefing; a double click launches ONE session', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  await expect(panel(page).locator(`.agent-search-row[data-task-id="${TARGET_TASK_ID}"]`)).toBeVisible({ timeout: 15_000 });
  // The header's trailing group holds model tag, button and toggle, in that order.
  const actions = panel(page).locator('.agent-search-header .agent-search-actions');
  await expect(actions.locator('.agent-search-model')).toBeVisible();
  await expect(actions.locator('.agent-search-open-session')).toBeVisible();
  await expect(actions.locator('.agent-search-toggle')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-done-with-button.png`, clip: { x: 0, y: 0, width: 1280, height: 400 } });

  const posts: QuickStartBody[] = [];
  page.on('request', (req) => { if (isQuickStart(req)) posts.push(req.postDataJSON() as QuickStartBody); });

  const quickStart = page.waitForResponse((res) => isQuickStart(res.request()));
  await openBtn(page).dblclick();
  // The FIRST click disables the button until the round-trip lands; the second
  // click of the pair hits a disabled control and does nothing.
  await expect(openBtn(page)).toBeDisabled();
  await expect(openBtn(page)).toHaveText(/Opening…/);
  const response = await quickStart;
  expect(response.status(), await response.text()).toBe(200);
  await expect(openBtn(page)).toBeEnabled({ timeout: 15_000 });
  // Give a second POST every chance to show up before asserting it never did.
  await page.waitForTimeout(500);
  expect(posts).toHaveLength(1);

  const message = posts[0]!.message ?? '';
  expect(message.split('\n')[0]).toBe(`Find everything about: ${QUERY}`);
  expect(message).toMatch(/quick AI search already found these; start from them and go deeper:/);
  expect(message).toContain(`- Playwright test task (pw-fixtures · TODO), task ${TARGET_TASK_ID}: “composer Stop killed the long-lived CLI so the next send cold-resumed”`);
  expect(message).toContain('That quick search summed it up as “The resume-button work lives in one task.” — verify it.');

  const { sessionId } = (await response.json()) as { sessionId: string };
  await expect(page.locator(`.main-page-session-column:has([data-session-id="${sessionId}"])`)).toBeVisible({ timeout: 60_000 });
});

test('done with zero rows keeps ONE header line with the button (no rows, no summary)', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: EMPTY_PAYLOAD }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  await expect(panel(page)).toHaveClass(/is-done/, { timeout: 15_000 });
  await expect(panel(page).locator('.agent-search-empty-note')).toHaveText('no matches');
  await expect(panel(page).locator('.agent-search-row')).toHaveCount(0);
  await expect(panel(page).locator('.agent-search-summary')).toHaveCount(0);
  await expect(openBtn(page)).toBeVisible();
  // Compact and un-squeezed. The card may drop the trailing controls onto a
  // second line when the task panel is narrow (that is the wrap rule), but the
  // labels themselves must never wrap mid-phrase — "AI search" stacked into two
  // lines was what the first version looked like at ~300px.
  const box = (await panel(page).boundingBox())!;
  expect(box.height, 'the empty card must stay at most two lines').toBeLessThan(70);
  await expectUnwrappedLabels(page);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-empty-one-line.png`, clip: { x: 0, y: 0, width: 1280, height: 300 } });

  const { body } = await clickOpenSession(page);
  expect(body.walnutAgent).toBe(true);
  expect(body.message).not.toMatch(/already found/);
});

test('at the task panel\'s narrowest width nothing is clipped, in either AI-lane state', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: EMPTY_PAYLOAD }));
  // 10% of the viewport is the resize clamp (useResizablePanel PANEL_PCT_MIN) —
  // the narrowest the card can ever be asked to render.
  await openHome(page, { todoWidthPct: 10 });
  await expectNothingClippedAtNarrowest(page, QUERY, '05b-narrowest');
});

test('a question edited after the search finished never carries the OLD answer\'s candidates', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  // The rows below belong to QUERY alone. The message for a DIFFERENT question
  // must not contain them: the panel reads its candidates back from the memo BY
  // QUERY, so an implementation that trusts its last snapshot fails here.
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 20_000 }));
  await page.route('**/api/search/agent**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    // Only the FIRST question is ever answered; the edited one stays in flight,
    // which is exactly the state where a stale payload would be reused.
    if (q === QUERY) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AGENT_PAYLOAD) });
      return;
    }
    await new Promise((r) => setTimeout(r, 20_000));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: [], model: 'haiku', tookMs: 1 }) });
  });
  await openHome(page);

  const input = page.locator('.todo-search-input');
  await input.fill(QUERY);
  await expect(panel(page).locator(`.agent-search-row[data-task-id="${TARGET_TASK_ID}"]`)).toBeVisible({ timeout: 20_000 });

  const edited = `${QUERY} and also the stop button`;
  await input.fill(edited);
  await expect(panel(page)).toHaveClass(/is-loading/, { timeout: 10_000 });

  const { body } = await clickOpenSession(page);
  expect(body.message?.split('\n')[0]).toBe(`Find everything about: ${edited}`);
  expect(body.message, 'the edited question must not inherit the old answer\'s rows').not.toContain(TARGET_TASK_ID);
  expect(body.message).not.toMatch(/already found/);
});

test('clearing the search box mid-launch and retyping does not mint a second session', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 20_000 }));
  // Hold the launch open so the second click lands while the first is in flight.
  // The button's own disabled state cannot help here: clearing the box UNMOUNTS
  // the card, so the retyped one starts enabled — only the owner's latch survives.
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const posts: string[] = [];
  await page.route('**/api/sessions/quick-start', async (route) => {
    posts.push(route.request().postData() ?? '');
    if (posts.length === 1) await held;
    await route.fallback();
  });
  await openHome(page);

  const input = page.locator('.todo-search-input');
  await input.fill(QUERY);
  await expect(openBtn(page)).toBeVisible({ timeout: 15_000 });
  await openBtn(page).click();
  await expect.poll(() => posts.length, { timeout: 15_000 }).toBe(1);

  await input.fill('');
  await expect(panel(page)).toHaveCount(0);
  await input.fill(QUERY);
  await expect(openBtn(page)).toBeEnabled({ timeout: 15_000 });
  await openBtn(page).click();
  await page.waitForTimeout(1000);
  expect(posts, 'the in-flight launch must swallow the second click').toHaveLength(1);

  release!();
  // And once it settles, the button works again (the latch is not a one-shot).
  await expect(page.locator(REAL_PANEL).last()).toBeVisible({ timeout: 60_000 });
  await expect(openBtn(page)).toBeEnabled({ timeout: 15_000 });
  await openBtn(page).click();
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(2);
});

test('the button survives a failed AI lane and an AI lane switched off', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 502, body: { error: 'agent failed', code: 'agent_failed' } }));
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  await expect(panel(page).locator('.agent-search-error')).toBeVisible({ timeout: 15_000 });
  await expect(openBtn(page)).toBeVisible();
  await expect(openBtn(page)).toBeEnabled();

  // Off: the "Enable AI search" row keeps the hand-off too — a full session does
  // not depend on the one-shot lane being on.
  await laneToggle(page).click();
  await expect(panel(page)).toHaveClass(/is-off/);
  await expect(panel(page).locator('.agent-search-enable')).toBeVisible();
  await expect(openBtn(page)).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-off-with-button.png`, clip: { x: 0, y: 0, width: 1280, height: 300 } });

  const { body } = await clickOpenSession(page);
  expect(body.walnutAgent).toBe(true);
  expect(body.message?.split('\n')[0]).toBe(`Find everything about: ${QUERY}`);

  // Leave the pref as the other specs expect it.
  await panel(page).locator('.agent-search-enable').click();
  await expect(panel(page)).not.toHaveClass(/is-off/);
});

test('a refused quick-start lands in the pending column with Retry, and the button comes back', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 20_000 }));
  // Fail the launch at the edge once; a Retry from the pending column goes through.
  let failed = false;
  await page.route('**/api/sessions/quick-start', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected launch failure' }) });
      return;
    }
    await route.fallback();
  });
  await openHome(page);

  await page.locator('.todo-search-input').fill(QUERY);
  await expect(openBtn(page)).toBeVisible();
  const columnsBefore = await homeColumns(page).count();
  const quickStart = page.waitForResponse((res) => isQuickStart(res.request()));
  await openBtn(page).click();
  expect((await quickStart).status()).toBe(500);

  // The existing pending-column error surface owns the failure; the card's
  // button is usable again for another attempt.
  const pending = page.locator('.main-page-session-column .pending-session-panel');
  await expect(pending).toBeVisible({ timeout: 20_000 });
  await expect(pending).toContainText(/injected launch failure/);
  await expect(homeColumns(page)).toHaveCount(columnsBefore + 1);
  // READABLE, not merely mounted: a failure the user cannot see is a launch that
  // silently did nothing, and Playwright's toBeVisible() passes for a box parked
  // outside the viewport. Polled, because the sessions area is sized by a resize
  // observer: for the first frames after the column appears it is still ~0 wide
  // (measuring once, right after toBeVisible, reads that transient and fails).
  const view = page.viewportSize()!;
  await expect.poll(async () => {
    const box = await pending.boundingBox();
    return box ? Math.round(Math.min(box.x + box.width, view.width) - box.x) : 0;
  }, { timeout: 15_000, message: 'the failure panel never became readable inside the viewport' })
    .toBeGreaterThan(240);
  await expect(openBtn(page)).toBeEnabled({ timeout: 15_000 });
  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-launch-failed-pending.png`, fullPage: false });

  const retryResponse = page.waitForResponse((res) => isQuickStart(res.request()));
  await pending.getByRole('button', { name: /Retry/ }).click();
  expect((await retryResponse).status()).toBe(200);
  await expect(page.locator(`${REAL_PANEL}`).last()).toBeVisible({ timeout: 60_000 });
});
