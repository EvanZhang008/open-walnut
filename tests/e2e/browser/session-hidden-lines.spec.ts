/**
 * A developer sees what Walnut hid from a reply, folded under it; everyone else sees nothing
 * (Settings > Advanced "Show lines Walnut hides", `ui.show_hidden_lines`; 2026-11-25, the user:
 * a developer switch, on by default for him, off for ordinary users, and when shown it is a fold).
 * Unset, it follows the server's `installDir` (Walnut runs from its own source checkout).
 *
 * History and the WS are mocked (mock-session-harness.ts); the config read is answered here, and
 * the config writes go nowhere, so the shared fixture server's setting never changes.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockSession, open, waitForWs } from './mock-session-harness';
import { isolateUiPrefs } from './todo-panel-helpers';

const SHOTS = process.env.HIDDEN_LINES_SHOTS ?? `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots`;

test.describe.configure({ timeout: 120_000 });

const at = (n: number) => new Date(Date.UTC(2026, 10, 25, 1, 0, n)).toISOString();
const SAVED = [
  { role: 'user', text: 'HL_ASK how is it going?', timestamp: at(0) },
  // The server's parse took the status lines out and keeps them beside the text (history-parse.ts).
  {
    role: 'assistant', timestamp: at(1), msgId: 'hl-1', text: 'HL_ANSWER_A the fix is live.',
    hidden: 'FOR_USER_STATE: answered\nth-5eb5fa81b1fd: answered · the fix is live',
  },
  { role: 'user', text: 'HL_ASK2 anything else?', timestamp: at(2) },
  // A reply the view itself hides a line of: the turn-end marker.
  { role: 'assistant', timestamp: at(3), msgId: 'hl-2', text: 'HL_ANSWER_B all good.\n<walnut-turn status="agent-ack"/>' },
  { role: 'user', text: 'HL_ASK3 last one', timestamp: at(4) },
  { role: 'assistant', timestamp: at(5), msgId: 'hl-3', text: 'HL_ANSWER_C nothing hidden here.' },
  { role: 'user', text: 'HL_ASK4 thanks', timestamp: at(6) },
];

/** This page's config read says `ui.show_hidden_lines` is `on` (undefined: unset), and `installDir`. */
async function pinConfig(page: Page, on: boolean | undefined, installDir?: string | null) {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    const res = await route.fetch();
    const body = await res.json() as { config: { ui?: Record<string, unknown> }; installDir?: string | null };
    const ui = { ...(body.config.ui ?? {}) };
    if (on === undefined) delete ui.show_hidden_lines; else ui.show_hidden_lines = on;
    body.config.ui = ui;
    if (installDir !== undefined) body.installDir = installDir;
    await route.fulfill({ response: res, json: body });
  });
}

async function openChat(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockSession(page, SAVED, 'idle');
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('HL_ANSWER_C', { timeout: 60_000 });
  return { hist, errors };
}

test('on: each reply with hidden lines has one closed fold that opens to them and closes again', async ({ page }) => {
  await pinConfig(page, true);
  const { hist, errors } = await openChat(page);
  const a = hist.locator('.session-msg', { hasText: 'HL_ANSWER_A' });
  const fold = a.getByTestId('hidden-lines-fold');
  await expect(fold).toHaveCount(1);
  await expect(fold).toHaveAttribute('data-open', 'false');
  await expect(fold).toContainText('Hidden by Walnut');
  await expect(a).not.toContainText('FOR_USER_STATE');
  await a.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/hidden-lines-closed.png`, clip: (await hist.boundingBox())! }).catch(() => {});

  await fold.getByRole('button', { name: 'Hidden by Walnut' }).click();
  await expect(fold).toHaveAttribute('data-open', 'true');
  await expect(fold.getByTestId('hidden-lines-text')).toHaveText('FOR_USER_STATE: answered\nth-5eb5fa81b1fd: answered · the fix is live');
  await page.screenshot({ path: `${SHOTS}/hidden-lines-open.png`, clip: (await hist.boundingBox())! }).catch(() => {});
  await fold.getByRole('button', { name: 'Hidden by Walnut' }).click();
  await expect(fold).toHaveAttribute('data-open', 'false');
  await expect(fold.getByTestId('hidden-lines-text')).toHaveCount(0);

  // The marker line the view takes out shows in its reply's fold; a reply with nothing hidden has none.
  const b = hist.locator('.session-msg', { hasText: 'HL_ANSWER_B' });
  await b.getByRole('button', { name: 'Hidden by Walnut' }).click();
  await expect(b.getByTestId('hidden-lines-text')).toHaveText('<walnut-turn status="agent-ack"/>');
  await expect(hist.locator('.session-msg', { hasText: 'HL_ANSWER_C' }).getByTestId('hidden-lines-fold')).toHaveCount(0);
  // The reply's words copy without the hidden lines (the fold is not part of the message text).
  await expect(a.locator('.session-msg-content')).toContainText('HL_ANSWER_A the fix is live.');
  expect(errors).toEqual([]);
});

test('off: no fold anywhere, the reply reads as before', async ({ page }) => {
  await pinConfig(page, false);
  const { hist, errors } = await openChat(page);
  await expect(hist.locator('.session-msg', { hasText: 'HL_ANSWER_A' })).toContainText('the fix is live.');
  await expect(hist.getByTestId('hidden-lines-fold')).toHaveCount(0);
  await expect(hist).not.toContainText('FOR_USER_STATE');
  expect(errors).toEqual([]);
});

test('unset: shown where Walnut runs from its source checkout, hidden on any other install', async ({ page }) => {
  await pinConfig(page, undefined, '/src/walnut');
  const { hist } = await openChat(page);
  await expect(hist.locator('.session-msg', { hasText: 'HL_ANSWER_A' }).getByTestId('hidden-lines-fold')).toHaveCount(1);

  const other = await page.context().newPage();
  // Before its app reads it: the first page left the last read ('1') in this context's storage.
  await other.addInitScript(() => { try { localStorage.removeItem('walnut:show-hidden-lines'); } catch { /* none */ } });
  await pinConfig(other, undefined, null);
  const { hist: hist2 } = await openChat(other);
  await expect(hist2.locator('.session-msg', { hasText: 'HL_ANSWER_A' })).toContainText('the fix is live.');
  await expect(hist2.getByTestId('hidden-lines-fold')).toHaveCount(0);
});

test('the Settings switch turns the fold on and off in an open chat', async ({ page }) => {
  // It opens the sidebar to reach Settings: that synced layout pref stays this page's own.
  await isolateUiPrefs(page);
  await pinConfig(page, false);
  const { hist } = await openChat(page);
  await expect(hist.getByTestId('hidden-lines-fold')).toHaveCount(0);
  // Settings > Advanced the way a person goes there: the sidebar, then the pane.
  if ((await page.locator('.sidebar.collapsed').count()) > 0) await page.locator('.sidebar-collapse-btn').click();
  await page.locator('.sidebar-nav a[href^="/settings"]').click();
  await page.getByTestId('settings-nav-advanced').click();
  const row = page.getByTestId('advanced-show-hidden-lines');
  await expect(row).toBeVisible({ timeout: 30_000 });
  const sw = row.getByRole('switch');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/hidden-lines-setting.png`, clip: (await row.boundingBox())! }).catch(() => {});
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await page.goBack();
  await expect(hist.locator('.session-msg', { hasText: 'HL_ANSWER_A' }).getByTestId('hidden-lines-fold')).toHaveCount(1, { timeout: 30_000 });
});
