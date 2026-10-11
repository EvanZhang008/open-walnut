/**
 * A trigger message that sat in a session's queue says how old it is when it is
 * written (2026-10-10: a fire queued on 10-06 reached a new CLI four days later
 * with nothing saying so).
 */
import { describe, it, expect } from 'vitest';
import { STALE_TRIGGER_MESSAGE_MS, staleTriggerText } from '../../../src/core/routines/trigger-stale.js';
import { buildTriggerMessage } from '../../../src/core/routines/trigger-envelope.js';
import { parseWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import type { CronJob } from '../../../src/core/cron/types.js';

const job = { id: 'job-1', name: 'Pipeline watch' } as CronJob;
const queuedAt = '2026-10-06T01:20:05.000Z';
const queuedMs = Date.parse(queuedAt);
const envelope = buildTriggerMessage(job, { atMs: queuedMs, items: [{ id: 'run-7' }] }, 'Check the run.');

describe('staleTriggerText', () => {
  it('leaves a fresh trigger message and any other message alone', () => {
    expect(staleTriggerText(envelope, queuedAt, queuedMs + STALE_TRIGGER_MESSAGE_MS - 1)).toBeNull();
    expect(staleTriggerText('hello, how is it going?', queuedAt, queuedMs + 4 * 86_400_000)).toBeNull();
    const peer = '<walnut-message kind="peer-note" from="x">\nhi\n</walnut-message>';
    expect(staleTriggerText(peer, queuedAt, queuedMs + 4 * 86_400_000)).toBeNull();
    expect(staleTriggerText(envelope, 'not a date', queuedMs + 4 * 86_400_000)).toBeNull();
  });

  it('puts one line under the opening tag naming when it was queued and how late it is', () => {
    const out = staleTriggerText(envelope, queuedAt, queuedMs + 4 * 86_400_000)!;
    const parsed = parseWalnutMessage(out)!;
    expect(parsed.kind).toBe('trigger');
    expect(parsed.body.split('\n')[0]).toBe(
      'Walnut note: this trigger message was queued at 2026-10-06T01:20:05.000Z and reaches you 4d later, '
      + 'so what it reports may be out of date. Check the current state before you act on it.',
    );
    // Everything else is the original envelope, byte for byte.
    expect(out.replace(/\nWalnut note: [^\n]*\n/, '\n')).toBe(envelope);
    expect(parsed.body).toContain('run-7');
  });

  it('a later write rewrites the note instead of stacking a second one', () => {
    const first = staleTriggerText(envelope, queuedAt, queuedMs + 2 * 3_600_000)!;
    expect(first).toContain('reaches you 2h later');
    const second = staleTriggerText(first, queuedAt, queuedMs + 4 * 86_400_000)!;
    expect(second.match(/Walnut note:/g)).toHaveLength(1);
    expect(second).toContain('reaches you 4d later');
    // The same wait again changes nothing.
    expect(staleTriggerText(second, queuedAt, queuedMs + 4 * 86_400_000)).toBeNull();
  });
});
