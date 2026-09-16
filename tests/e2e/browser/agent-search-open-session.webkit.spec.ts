/**
 * ✦ AI search card → "Open as session", in WEBKIT — the engine the desktop app is.
 *
 * Two things here are engine-specific, so a Chromium-only pass would not cover
 * the Mac app: (1) a WebKit button does not take focus on mousedown, so a click
 * on a control that lives inside a scrollable strip can be eaten by the scroll
 * (shipped twice, on the CronPill and the TRIGGER pill); (2) the card survives a
 * narrow task panel by wrapping as groups and ellipsizing the chip's label, and
 * wrap/ellipsis geometry is exactly where the two engines disagree.
 *
 * Scenarios live in agent-search-open-session-helpers.ts — a `test.use` browser
 * pin only applies at a spec file's top level, which is why this is its own file
 * rather than a flag on the Chromium spec.
 */
import { expect, test } from '@playwright/test';
import {
  AGENT_PAYLOAD, EMPTY_PAYLOAD, expectNothingClippedAtNarrowest, expectOneClickOpensSession,
  openHome, stubAgentSearch, stubEmptyInstantSearch, uniqueQuery,
} from './agent-search-open-session-helpers';

test.use({ browserName: 'webkit' });
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit');
});

test('one click opens a real Ask Walnut session', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  // Still searching when the button is pressed: the launch must not depend on the
  // one-shot lane having answered.
  await stubAgentSearch(page, () => ({ status: 200, body: AGENT_PAYLOAD, delayMs: 20_000 }));
  await openHome(page);
  await expectOneClickOpensSession(page, uniqueQuery('w'));
});

test('at the task panel\'s narrowest width nothing is clipped, in either AI-lane state', async ({ page }) => {
  await stubEmptyInstantSearch(page);
  await stubAgentSearch(page, () => ({ status: 200, body: EMPTY_PAYLOAD }));
  await openHome(page, { todoWidthPct: 10 });
  await expectNothingClippedAtNarrowest(page, uniqueQuery('wn'), 'webkit-narrowest');
});
