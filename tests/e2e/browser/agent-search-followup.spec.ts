/**
 * Ask the follow-up in the ✦ card itself — the small window in the task panel.
 *
 * The request (2026-09-17): "can we actually just ask a follow-up question in the
 * small window in the task side panel?" The answer already existed one click away
 * (the card's button opens the search's own session in a column); this keeps the
 * user in the search box instead. The first question ADOPTS that same session —
 * the identical request the button makes — so nothing re-runs and nothing new
 * happens server-side.
 *
 * The lane's answer is stubbed at the network edge (the fixture has no AI lane);
 * the session the question lands in is REAL, with the mock CLI answering it.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  AGENT_PAYLOAD, EMPTY_PAYLOAD, openBtn, openHome, panel, stubAgentSearch,
  stubEmptyInstantSearch, uniqueQuery,
} from './agent-search-open-session-helpers';
import {
  SCREENSHOT_DIR, askInCard, expectAnsweredInsideTheCard, expectComposerWaitsForTheAnswer,
  expectRowsSteppedAside, expectWindowStaysInItsBox, followUp, followUpInput, seedAdoptedSession,
  typeSearch,
} from './agent-search-followup-helpers';

const STAMP = Date.now().toString(36);

// Every test mints real sessions on the one fixture server, and the AI toggle is a
// shared localStorage pref. Serial = correctness.
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('the composer appears with the answer, not before it', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 2_000 }));
  await openHome(page);
  await expectComposerWaitsForTheAnswer(page, uniqueQuery(`w${STAMP}`));
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await panel(page).screenshot({ path: `${SCREENSHOT_DIR}/1-composer-under-rows.png` });
});

test('a follow-up is asked and answered inside the card, with no column opening', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);
  const { stub } = await seedAdoptedSession(page, `a${STAMP}`);

  const query = uniqueQuery(`a${STAMP}`);
  await typeSearch(page, query);
  await expect(followUpInput(page)).toBeVisible({ timeout: 30_000 });

  await expectAnsweredInsideTheCard(page, `which one is still open ${STAMP}`);
  await expectRowsSteppedAside(page);
  await panel(page).screenshot({ path: `${SCREENSHOT_DIR}/2-answered-in-card.png` });

  // The server was asked BY QUERY (a client may never name a session id), with the
  // lane's own switch and the card's progress id riding along.
  expect(stub.bodies).toHaveLength(1);
  expect(stub.bodies[0]?.q).toBe(query);
  expect(stub.bodies[0]?.search).toBe(true);
});

test('the window stays a window: capped, scrolling inside, panel unchanged', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);
  await seedAdoptedSession(page, `g${STAMP}`);

  await typeSearch(page, uniqueQuery(`g${STAMP}`));
  await expectAnsweredInsideTheCard(page, `and the geometry ${STAMP}`);
  await expectWindowStaysInItsBox(page);
  await panel(page).screenshot({ path: `${SCREENSHOT_DIR}/3-window-box.png` });
});

test('a second question rides the SAME conversation (one adopt, ever)', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);
  const { stub } = await seedAdoptedSession(page, `s${STAMP}`);

  await typeSearch(page, uniqueQuery(`s${STAMP}`));
  await expectAnsweredInsideTheCard(page, `first question ${STAMP}`);

  const second = `second question ${STAMP}`;
  await askInCard(page, second);
  await expect(followUp(page).getByText(new RegExp(`I processed your message: ${second}`)).first())
    .toBeVisible({ timeout: 60_000 });
  // Adoption happened once: the conversation is already here, and asking again
  // must not re-negotiate which session that is.
  expect(stub.bodies, 'a live window must not adopt again').toHaveLength(1);
});

test('a no-match search still lets you ask — that is when it matters most', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: EMPTY_PAYLOAD }));
  await openHome(page);
  await seedAdoptedSession(page, `e${STAMP}`);

  await typeSearch(page, uniqueQuery(`e${STAMP}`));
  await expect(panel(page)).toContainText('no matches', { timeout: 30_000 });
  await expectAnsweredInsideTheCard(page, `nothing matched so ask ${STAMP}`);
});

test('when there is no conversation to continue, the question comes back', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  // The server's 404: the run aged out and no earlier ask exists.
  await page.route('**/api/search/agent/session', async (route) => {
    await route.fulfill({
      status: 404, contentType: 'application/json',
      body: JSON.stringify({ error: 'no AI search session to continue for this query', code: 'no_session' }),
    });
  });
  await openHome(page);

  await typeSearch(page, uniqueQuery(`f${STAMP}`));
  const typed = `this must not vanish ${STAMP}`;
  await askInCard(page, typed);

  // Said plainly, and the words are back in the box — losing what someone typed is
  // the one failure this window must not have.
  await expect(followUp(page).locator('.agent-search-followup-error'))
    .toContainText('no conversation to continue', { timeout: 30_000 });
  await expect(followUpInput(page)).toHaveValue(typed, { timeout: 15_000 });
  // The header's button is still the way through.
  await expect(openBtn(page)).toHaveText(/Open as session/);
  await panel(page).screenshot({ path: `${SCREENSHOT_DIR}/4-question-handed-back.png` });
});
