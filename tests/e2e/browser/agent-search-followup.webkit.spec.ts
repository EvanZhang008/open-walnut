/**
 * The ✦ card's follow-up window in WEBKIT — the engine the Mac app is.
 *
 * Engine-specific, so a Chromium pass alone would not cover the desktop app: this
 * puts a whole session transcript inside a narrow panel that CLIPS its overflow,
 * and WebKit's late scrollbars plus its different min-content rules are exactly
 * what has twice made a card that fits in Chromium overflow here. The send path is
 * engine-relevant too: a WebKit button takes no focus on mousedown, so a composer
 * inside a scrollable strip can have its Enter swallowed.
 *
 * Scenarios live in agent-search-followup-helpers.ts (a `test.use` pin only applies
 * at a spec file's top level).
 */
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  AGENT_PAYLOAD, openHome, panel, stubAgentSearch, stubEmptyInstantSearch, uniqueQuery,
} from './agent-search-open-session-helpers';
import {
  SCREENSHOT_DIR, expectAnsweredInsideTheCard, expectComposerIsOneLine, expectRowsSteppedAside,
  expectWindowStaysInItsBox, followUpInput, seedAdoptedSession, typeSearch,
} from './agent-search-followup-helpers';

const STAMP = Date.now().toString(36);

test.use({ browserName: 'webkit' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

test('the follow-up is asked, answered and boxed in WebKit too', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  await openHome(page);
  await seedAdoptedSession(page, `wk${STAMP}`);

  await typeSearch(page, uniqueQuery(`wk${STAMP}`));
  await expect(followUpInput(page)).toBeVisible({ timeout: 30_000 });
  await expectComposerIsOneLine(page);
  await expectAnsweredInsideTheCard(page, `webkit follow-up ${STAMP}`);
  await expectRowsSteppedAside(page);
  await expectWindowStaysInItsBox(page);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await panel(page).screenshot({ path: `${SCREENSHOT_DIR}/5-webkit.png` });
});

test('at a narrow task panel the window still fits', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD }));
  // The panel's resize clamp — the narrowest the card is ever asked to hold a
  // transcript, where a session's long paths and code blocks would show first.
  await openHome(page, { todoWidthPct: 22 });
  await seedAdoptedSession(page, `wkn${STAMP}`);

  await page.setViewportSize({ width: 900, height: 800 });
  await typeSearch(page, uniqueQuery(`wkn${STAMP}`));
  // The one-liner at the narrowest the card gets: a send button pushed out of a
  // clipped card is invisible AND unclickable (three fixed widths did exactly
  // that in WebKit while Chromium stayed green).
  await expect(followUpInput(page)).toBeVisible({ timeout: 30_000 });
  await expectComposerIsOneLine(page);
  await expectAnsweredInsideTheCard(page, `narrow webkit ${STAMP}`);
  await expectWindowStaysInItsBox(page);
  await expectComposerIsOneLine(page);
  await panel(page).screenshot({ path: `${SCREENSHOT_DIR}/6-webkit-narrow.png` });
});
