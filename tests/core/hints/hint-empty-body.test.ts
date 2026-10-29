/**
 * A message that would be only Walnut's hints carries one plain line of its own,
 * so the model has something to answer besides the notes (2026-10-29).
 */
import { describe, expect, it } from 'vitest';
import type { Config } from '../../../src/core/types.js';
import { EMPTY_BODY_LINE, WAIT_WAKE_EMPTY_LINE, parseHinted, prepareHintedSend } from '../../../src/core/hints/hint-send.js';

const config = { session: {} } as Pick<Config, 'session'>;
const record = { claudeSessionId: 's1', output_mode: 'rich' as const };

describe('a send with no words of its own', () => {
  it('carries the plain line in front of its hints, and shows that line', async () => {
    const out = await prepareHintedSend('s1', record, '  \n', { config });
    expect(out.hints.length).toBeGreaterThan(0);
    expect(out.displayText).toBe(EMPTY_BODY_LINE);
    expect(out.enqueueText.startsWith(EMPTY_BODY_LINE)).toBe(true);
    expect(parseHinted(out.enqueueText).text.trim()).toBe(EMPTY_BODY_LINE);
  });

  it('takes the caller\'s line when it names one (the wait_until clock)', async () => {
    const out = await prepareHintedSend('s1', record, '', { config, emptyBodyLine: WAIT_WAKE_EMPTY_LINE });
    expect(out.displayText).toBe(WAIT_WAKE_EMPTY_LINE);
    expect(out.enqueueText.startsWith(WAIT_WAKE_EMPTY_LINE)).toBe(true);
  });

  it('a message with words keeps them as they are', async () => {
    const out = await prepareHintedSend('s1', record, 'Check the build.', { config });
    expect(out.displayText).toBe('Check the build.');
    expect(out.enqueueText).not.toContain(EMPTY_BODY_LINE);
  });

});
