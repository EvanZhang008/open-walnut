/**
 * REGRESSION: server-snapshot adoption rules for the streaming block view
 * (inc-1783357192826 — "reply visible while streaming, gone when done").
 *
 * Root cause chain of the incident:
 *   1. attach()ed sessions had hasPipe=false → every turn end was classified
 *      'stopped' → the server wiped the stream buffer instantly (markDone +
 *      clear, blocksRetained N→0 within ~10ms).
 *   2. The mount/resubscribe snapshot then arrived EMPTY, and the "bothIdle
 *      stale-cache correction" adopted it over non-empty local blocks —
 *      erasing the evidence-kept, not-yet-archived tail of the conversation.
 *
 * shouldAdoptSnapshot is the single decision point (extracted from
 * useSessionStream). Its rules have failed in BOTH directions in production,
 * so every branch is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { shouldAdoptSnapshot } from '@/cache/snapshot-adoption';

describe('shouldAdoptSnapshot', () => {
  it('adopts on initial load (no local blocks)', () => {
    expect(shouldAdoptSnapshot({
      prevLen: 0, snapshotLen: 5,
      snapshotIsStreaming: false, localIsStreaming: false,
    })).toBe(true);
    // Even an empty snapshot is fine when there is nothing to lose.
    expect(shouldAdoptSnapshot({
      prevLen: 0, snapshotLen: 0,
      snapshotIsStreaming: false, localIsStreaming: false,
    })).toBe(true);
  });

  // ⭐ THE incident: empty server buffer (cleared at turn end / prune /
  // restart) must NEVER wipe non-empty local blocks — regardless of
  // streaming flags.
  it('NEVER adopts an empty snapshot over non-empty local blocks (inc-1783357192826)', () => {
    for (const snapshotIsStreaming of [false, true]) {
      for (const localIsStreaming of [false, true]) {
        expect(shouldAdoptSnapshot({
          prevLen: 3, snapshotLen: 0,
          snapshotIsStreaming, localIsStreaming,
        })).toBe(false);
      }
    }
  });

  it('keeps local blocks while a turn is live on either side', () => {
    // Local live (deltas already applied, snapshot lagging) — the original
    // "1. 2. 3 → restart 1. 2. 3" replay-clobber protection.
    expect(shouldAdoptSnapshot({
      prevLen: 3, snapshotLen: 2,
      snapshotIsStreaming: false, localIsStreaming: true,
    })).toBe(false);
    // Server live — incremental handlers will catch us up; don't jump-cut.
    expect(shouldAdoptSnapshot({
      prevLen: 3, snapshotLen: 7,
      snapshotIsStreaming: true, localIsStreaming: false,
    })).toBe(false);
  });

  // The opposite production bug this rule fixes: a cache seeded from a
  // finished turn duplicates history forever unless the (non-empty,
  // both-idle) server buffer is allowed to win.
  it('adopts a NON-EMPTY snapshot when both sides are idle (stale-cache correction)', () => {
    expect(shouldAdoptSnapshot({
      prevLen: 5, snapshotLen: 2,
      snapshotIsStreaming: false, localIsStreaming: false,
    })).toBe(true);
  });

  it('skips adoption when both idle and lengths match (avoid churn)', () => {
    expect(shouldAdoptSnapshot({
      prevLen: 4, snapshotLen: 4,
      snapshotIsStreaming: false, localIsStreaming: false,
    })).toBe(false);
  });

  // ── Phase 1 (ACP dialect): seq comparison replaces length guessing ──
  describe('seq comparison (both sides know their seq)', () => {
    it('equal seq → never adopt, even when lengths differ (zero churn)', () => {
      expect(shouldAdoptSnapshot({
        prevLen: 5, snapshotLen: 2,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 7, lastAdoptedSeq: 7,
      })).toBe(false);
    });

    it('greater seq → adopt, even at EQUAL lengths (length rule would miss the mutation)', () => {
      expect(shouldAdoptSnapshot({
        prevLen: 4, snapshotLen: 4,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 9, lastAdoptedSeq: 7,
      })).toBe(true);
    });

    it('smaller seq (buffer recreated — new generation) → falls back to length rules', () => {
      // Length rule says: different non-empty lengths, both idle → adopt.
      expect(shouldAdoptSnapshot({
        prevLen: 5, snapshotLen: 2,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 1, lastAdoptedSeq: 7,
      })).toBe(true);
      // Length rule says: identical lengths → skip.
      expect(shouldAdoptSnapshot({
        prevLen: 4, snapshotLen: 4,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 1, lastAdoptedSeq: 7,
      })).toBe(false);
    });

    it('seq never overrides the hard guards (empty snapshot / live turn)', () => {
      // Empty snapshot must never wipe, even with a newer seq.
      expect(shouldAdoptSnapshot({
        prevLen: 3, snapshotLen: 0,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 99, lastAdoptedSeq: 7,
      })).toBe(false);
      // Live local turn keeps blocks, even with a newer seq.
      expect(shouldAdoptSnapshot({
        prevLen: 3, snapshotLen: 2,
        snapshotIsStreaming: false, localIsStreaming: true,
        snapshotSeq: 99, lastAdoptedSeq: 7,
      })).toBe(false);
    });

    it('undefined seq on either side → legacy length behavior preserved', () => {
      // Pre-seq server (snapshotSeq undefined).
      expect(shouldAdoptSnapshot({
        prevLen: 5, snapshotLen: 2,
        snapshotIsStreaming: false, localIsStreaming: false,
        lastAdoptedSeq: 7,
      })).toBe(true);
      // Never adopted yet (lastAdoptedSeq undefined).
      expect(shouldAdoptSnapshot({
        prevLen: 4, snapshotLen: 4,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 9,
      })).toBe(false);
      // snapshotSeq 0 = no buffer server-side — but snapshotLen 0 already
      // blocks that path; a 0/positive-len mismatch treats seq as absent.
      expect(shouldAdoptSnapshot({
        prevLen: 5, snapshotLen: 2,
        snapshotIsStreaming: false, localIsStreaming: false,
        snapshotSeq: 0, lastAdoptedSeq: 7,
      })).toBe(true);
    });
  });
});
