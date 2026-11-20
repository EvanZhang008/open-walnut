/**
 * A reply never shows Walnut's own lines (src/lib/internal-lines.ts): the status report a session
 * wrote at its end ("FOR_USER_STATE: working" / FOR_USER_NOW / FOR_USER_NEXT, 2026-11-20, the
 * user: "why it show?") nor an old version tag in front of a line ("[v16908844]", 2026-11-19),
 * whether the reply comes from the history or is still streaming in. A field name inside a
 * sentence or a code block stays as written.
 *
 * History and the WS are mocked (mock-session-harness.ts).
 */
import { test, expect } from '@playwright/test';
import { mockSession, open, waitForWs } from './mock-session-harness';

const SHOTS = process.env.INTERNAL_LINES_SHOTS ?? `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots`;

test.describe.configure({ timeout: 120_000 });

const at = (n: number) => new Date(Date.UTC(2026, 10, 20, 1, 0, n)).toISOString();
const SAVED = [
  { role: 'user', text: 'IL_ASK how is the move going?', timestamp: at(0) },
  {
    role: 'assistant', timestamp: at(1), msgId: 'il-1',
    text: 'IL_ANSWER_A two subagents still run; I check, review and ship after.\n\nFOR_USER_STATE: working\nFOR_USER_NOW: two subagents finish phase one\nFOR_USER_NEXT: check, review, ship',
  },
  { role: 'user', text: 'IL_ASK2 and the tag?', timestamp: at(2) },
  { role: 'assistant', timestamp: at(3), msgId: 'il-2', text: '[v16908844] **IL_ANSWER_B** done.\n[v16908844] A second line.' },
  { role: 'user', text: 'IL_ASK3 explain the field', timestamp: at(4) },
  { role: 'assistant', timestamp: at(5), msgId: 'il-3', text: 'IL_ANSWER_C the side question asks the FOR_USER_STATE line.\n\n```\nFOR_USER_STATE: working\n```' },
  { role: 'user', text: 'IL_ASK4 one more', timestamp: at(6) },
];
const LIVE = 'IL_ANSWER_D still going.\n\nFOR_USER_STATE: working\nFOR_USER_THREAD t1: working | on it';

test('a reply shows no status report lines and no version tags, from the history or streaming in', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mockSession(page, SAVED, 'running', { blocks: [{ type: 'text', content: LIVE, msgId: 'il-live' }], isStreaming: true });
  const hist = await open(page);
  await waitForWs(page);
  await expect(hist).toContainText('IL_ANSWER_C', { timeout: 60_000 });
  await expect(page.locator('.session-panel')).toContainText('IL_ANSWER_D', { timeout: 30_000 });

  const a = hist.locator('.session-msg', { hasText: 'IL_ANSWER_A' });
  await expect(a).toContainText('ship after');
  await expect(a).not.toContainText('FOR_USER_');
  const b = hist.locator('.session-msg', { hasText: 'IL_ANSWER_B' });
  await expect(b).toContainText('A second line.');
  await expect(b).not.toContainText('[v16908844]');
  // A mention in a sentence and a code block are the session's words: kept.
  const c = hist.locator('.session-msg', { hasText: 'IL_ANSWER_C' });
  await expect(c).toContainText('asks the FOR_USER_STATE line');
  await expect(c.locator('pre').filter({ hasText: 'FOR_USER_STATE: working' })).toHaveCount(1);

  const panel = page.locator('.session-panel');
  const live = panel.locator(':text("IL_ANSWER_D")').locator('xpath=ancestor::*[contains(@class,"session-msg") or contains(@class,"streaming")][1]');
  await expect(live).not.toContainText('FOR_USER_');

  await hist.locator('.session-msg', { hasText: 'IL_ANSWER_A' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-internal-lines.png`, clip: (await panel.boundingBox())! }).catch(() => {});
  expect(errors).toEqual([]);
});
