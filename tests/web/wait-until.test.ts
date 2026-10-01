/**
 * "Snooze until something happens" starts a message that names its skill for
 * Claude Code (`/walnut-trigger …`, so the skill is loaded for certain) and is
 * the plain sentence for an ACP engine, whose slash commands are its own. A
 * second click must recognise either form and not stack the words.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/session-status', () => ({ resolveTaskSessionId: () => undefined }));

const { startsWithWaitUntil, waitUntilPrefix, WAIT_UNTIL_SKILL, WAIT_UNTIL_TEXT, WAIT_UNTIL_TITLE } = await import('../../web/src/utils/wait-until');

describe('wait-until row title', () => {
  // Waiting is a status now (2026-09-30): the skill sets it after the trigger.
  it('says the task goes to Waiting until the trigger fires', () => {
    expect(WAIT_UNTIL_TITLE).toBe(
      'Tell the AI what to wait for. It sets up a trigger (walnut-trigger skill) and puts the task in Waiting until it fires',
    );
    expect(WAIT_UNTIL_TITLE).not.toMatch(/stays To Do/);
  });
});

describe('wait-until prefix', () => {
  it('names the skill as a leading command by default, and is plain for an ACP engine', () => {
    expect(waitUntilPrefix()).toBe('/walnut-trigger Snooze this task until: ');
    expect(waitUntilPrefix({ acp: true })).toBe('Snooze this task until: ');
    // The command is the first word, followed by a space: the CLI splits on it.
    expect(waitUntilPrefix().startsWith(`${WAIT_UNTIL_SKILL} `)).toBe(true);
  });

  it('recognises either form, typed or not, so a second click only refocuses', () => {
    for (const text of [waitUntilPrefix(), WAIT_UNTIL_TEXT, `  ${waitUntilPrefix()}CR 1234 is approved`, `${WAIT_UNTIL_TEXT}the build is green`]) {
      expect(startsWithWaitUntil(text), text).toBe(true);
    }
    for (const text of ['', 'ship it', '/walnut-trigger watch my inbox', 'Snooze this task']) {
      expect(startsWithWaitUntil(text), text).toBe(false);
    }
  });
});
