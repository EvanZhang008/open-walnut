/**
 * The launching tab's own copy of its launch prompt (web/src/components/sessions/
 * launch-prompt-seed.ts). It must carry the SAME id as the server's launch prompt,
 * or the queue answer would add a second bubble next to the seeded one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clearLaunchSeeds, launchPromptId, launchSeedFor, seedLaunchPrompt } from '@/components/sessions/launch-prompt-seed';
import { launchPromptId as serverLaunchPromptId } from '../../src/core/sessions/launch-prompts';

const SID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => { clearLaunchSeeds(); });

describe('launch prompt seed', () => {
  it('uses the server id format', () => {
    expect(launchPromptId(SID)).toBe(serverLaunchPromptId(SID));
  });

  it('is readable more than once within its TTL (a panel can mount twice)', () => {
    seedLaunchPrompt(SID, 'first words', 1_000);
    expect(launchSeedFor(SID, 2_000)).toEqual({ id: `launch-${SID}`, text: 'first words', at: new Date(1_000).toISOString() });
    expect(launchSeedFor(SID, 3_000)?.text).toBe('first words');
    expect(launchSeedFor(SID, 1_000 + 60_001)).toBeUndefined();
  });

  it('keeps nothing for an empty message and is capped', () => {
    seedLaunchPrompt(SID, '  ');
    expect(launchSeedFor(SID)).toBeUndefined();
    for (let i = 0; i < 25; i++) seedLaunchPrompt(`s${i}`, `m${i}`);
    expect(launchSeedFor('s4')).toBeUndefined();
    expect(launchSeedFor('s5')?.text).toBe('m5');
  });
});
