/**
 * Peer-send throttle — hub-side rate limiting for the agent gateway's
 * `peers.send` capability (all enforcement happens here, single point).
 *
 * Two independent suppressions, both rolling windows (modeled on
 * SessionAutoContinue.firesInWindow — timestamps array, filter on read):
 *  1. per-sender send cap: max PEER_SEND_MAX_PER_WINDOW sends per
 *     PEER_SEND_WINDOW_MS, regardless of target.
 *  2. duplicate suppression: the same (sender, target, sha1(text)) triple is
 *     refused for PEER_DUP_WINDOW_MS after a successful send.
 *
 * `now` is injectable so L1 tests can drive the clock.
 */
import { createHash } from 'node:crypto';

export const PEER_SEND_WINDOW_MS = 60_000; // per-sender rolling window
export const PEER_SEND_MAX_PER_WINDOW = 10;
export const PEER_DUP_WINDOW_MS = 300_000; // same (sender, target, sha1(text)) suppressed
export const PEER_PENDING_CAP = 50; // target queue depth via getQueue()
/**
 * Gateway `tools.call` writes (task_update, task_complete, folder_*, board_*):
 * their own, wider budget. These are bookkeeping, not messages: a leader
 * renaming or completing its 25 workers is one write per worker, and at the
 * send cap of 10 that took minutes of backoff (2026-10-02). A send op riding
 * the gateway is still braked at the send cap by session-send-core's own
 * throttle, so widening this one does not widen message fan-out.
 */
export const GATEWAY_WRITE_WINDOW_MS = 60_000;
export const GATEWAY_WRITE_MAX_PER_WINDOW = 60;

export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export class PeerThrottle {
  /** Per-sender timestamps of admitted sends (pruned lazily on read). */
  private sends = new Map<string, number[]>();
  /** Per-sender timestamps of admitted gateway writes (its own budget). */
  private writes = new Map<string, number[]>();
  /** dupKey → timestamp of the last admitted identical send. */
  private dups = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Check the window + dup suppression and, when allowed, record the send in
   * one step (check-then-record as a single call — no gap for a concurrent
   * admit to overrun the cap).
   */
  admit(senderSid: string, targetSid: string, text: string): ThrottleDecision {
    const t = this.now();

    // 1. Per-sender rolling window.
    const cutoff = t - PEER_SEND_WINDOW_MS;
    const live = (this.sends.get(senderSid) ?? []).filter((ts) => ts >= cutoff);
    if (live.length >= PEER_SEND_MAX_PER_WINDOW) {
      this.sends.set(senderSid, live);
      // Oldest in-window send falling out of the window frees a slot.
      const retryAfterMs = Math.max(1, live[0] + PEER_SEND_WINDOW_MS - t);
      return { allowed: false, retryAfterMs };
    }

    // 2. Duplicate suppression.
    const dupKey = this.dupKey(senderSid, targetSid, text);
    const lastDup = this.dups.get(dupKey);
    if (lastDup !== undefined && lastDup > t - PEER_DUP_WINDOW_MS) {
      this.sends.set(senderSid, live);
      return { allowed: false, retryAfterMs: Math.max(1, lastDup + PEER_DUP_WINDOW_MS - t) };
    }

    live.push(t);
    this.sends.set(senderSid, live);
    this.dups.set(dupKey, t);
    this.pruneDups(t);
    return { allowed: true };
  }

  /**
   * Window-cap-only admission (no duplicate suppression) — used by gateway
   * `tools.call` writes, where an identical retry after a transient failure
   * is legitimate and must not be swallowed as a "duplicate". Its own
   * per-sender window (GATEWAY_WRITE_MAX_PER_WINDOW), apart from peer sends.
   */
  admitWrite(senderSid: string): ThrottleDecision {
    const t = this.now();
    const cutoff = t - GATEWAY_WRITE_WINDOW_MS;
    const live = (this.writes.get(senderSid) ?? []).filter((ts) => ts >= cutoff);
    if (live.length >= GATEWAY_WRITE_MAX_PER_WINDOW) {
      this.writes.set(senderSid, live);
      return { allowed: false, retryAfterMs: Math.max(1, live[0] + GATEWAY_WRITE_WINDOW_MS - t) };
    }
    live.push(t);
    this.writes.set(senderSid, live);
    return { allowed: true };
  }

  private dupKey(senderSid: string, targetSid: string, text: string): string {
    const hash = createHash('sha1').update(text).digest('hex');
    return `${senderSid}\u0000${targetSid}\u0000${hash}`;
  }

  /** Keep the dup map from accumulating one entry per message ever sent. */
  private pruneDups(t: number): void {
    if (this.dups.size < 256) return;
    const cutoff = t - PEER_DUP_WINDOW_MS;
    for (const [key, ts] of this.dups) {
      if (ts <= cutoff) this.dups.delete(key);
    }
  }
}
