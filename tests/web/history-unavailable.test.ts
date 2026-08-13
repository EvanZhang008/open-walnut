/**
 * REGRESSION: "History unavailable — Session history file not found" on a
 * brand-new, perfectly healthy session.
 *
 * Reported symptom: creating a task ALWAYS flashed that card. Reproduced from
 * logs — the UI fetches history ~0.8s after launch, but the CLI writes its first
 * JSONL line ~4.8s after spawn, so for that gap the transcript really is absent.
 * The server no longer calls that a fault during startup; this file pins the
 * CLIENT-side backstop: the card must never be painted above visible content.
 * The user's screenshot showed exactly that contradiction — a Running session
 * with "2 system messages" sitting under a "file not found" box.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHistoryUnavailable,
  visibleHistoryUnavailable,
} from '@/components/sessions/history-unavailable';

const UNAVAILABLE = 'HISTORY_UNAVAILABLE:Session history file not found';

describe('parseHistoryUnavailable', () => {
  it('extracts the reason from the tagged error', () => {
    expect(parseHistoryUnavailable(UNAVAILABLE)).toBe('Session history file not found');
  });
  it('ignores unrelated errors and empty state', () => {
    expect(parseHistoryUnavailable('Network request failed')).toBeNull();
    expect(parseHistoryUnavailable(null)).toBeNull();
    expect(parseHistoryUnavailable(undefined)).toBeNull();
  });
});

describe('visibleHistoryUnavailable', () => {
  it('shows the reason when there is genuinely nothing to render', () => {
    expect(visibleHistoryUnavailable(UNAVAILABLE, false)).toBe('Session history file not found');
  });

  it('SUPPRESSES the card when the session already has content (the reported bug)', () => {
    // The screenshot's exact state: an unavailable answer alongside rendered rows.
    expect(visibleHistoryUnavailable(UNAVAILABLE, true)).toBeNull();
  });

  it('never leaks the raw HISTORY_UNAVAILABLE prefix as a reason', () => {
    const shown = visibleHistoryUnavailable(UNAVAILABLE, false);
    expect(shown).not.toContain('HISTORY_UNAVAILABLE');
  });

  it('stays null for ordinary fetch errors (those use the generic banner)', () => {
    expect(visibleHistoryUnavailable('Network request failed', false)).toBeNull();
    expect(visibleHistoryUnavailable('Network request failed', true)).toBeNull();
  });
});
