/**
 * LEGACY marker for the retired side-thread cache warm-up (removed 2026-09-22).
 *
 * Walnut used to fire a hidden "reply Ready" turn into a standby fork while the
 * user typed, because a fork's first API call paid a full prefix rewrite — a
 * consequence of the launch-argv model/effort bug (spawn-prefix.ts). With that
 * bug fixed a fork is born warm (measured: first call read 95K / wrote 13K), so
 * the warm-up cost a second full prefix READ plus one junk model reply per
 * thread for sub-second benefit, and was removed.
 *
 * What stays is transcript compatibility: threads created before the removal
 * carry the tagged warm-up line and its reply in their JSONL forever, and
 * session-history still hides both on every surface via this predicate.
 */

export const CACHE_WARMUP_TAG = '<walnut-cache-warmup>';

export function isCacheWarmupText(text: string): boolean {
  return text.startsWith(CACHE_WARMUP_TAG);
}
