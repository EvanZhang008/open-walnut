/**
 * Frozen prompt snapshots + drift detection for the bounded memory stores.
 *
 * Ported from hermes-agent tools/memory_tool.py, which freezes MEMORY.md /
 * USER.md into the system prompt once at session start: mid-session writes DO
 * hit disk immediately (durability is never traded away) but do NOT change what
 * the model sees for the rest of that session.
 *
 * WHY WALNUT NEEDS THIS (the concrete bug, not the abstract nicety)
 * ----------------------------------------------------------------
 * Walnut's memory block lives in the VOLATILE half of the prompt split
 * (`buildSystemPromptSplit` → `dynamic`, injected past the cache breakpoint), so
 * unlike Hermes this is NOT a prompt-cache optimization — nothing here touches
 * the stable prefix. The payoff is semantic consistency across the several
 * INDEPENDENT prompt builds that happen around one user turn:
 *
 *   1. the compaction gate (`chat-history.ts` → `buildSystemPrompt`) sizing the turn
 *   2. the real payload (`runAgentLoop` → `buildSystemPromptSplit`)
 *   3. `background-review`, a FIRE-AND-FORGET fork that runs the same default
 *      prompt path CONCURRENTLY with real turns and whose whole job is writing
 *      memory (`background-review.ts`)
 *   4. observability reads (context inspector, chat stats)
 *
 * Because (3) is unsynchronized with (1), (2) and (4), an unfrozen read means the
 * memory block can differ between the token estimate and the payload it was
 * estimating, and can change under a conversation mid-flight. Two user-visible
 * consequences: the model sees an entry it just wrote appear in its own rules and
 * "re-learns" it, and content shifts under it mid-conversation for no reason it
 * can observe.
 *
 * REFRESH POLICY — "freeze until the next Personal AI turn boundary"
 * ------------------------------------------------------------------
 * A pin is created ONLY by an explicit `beginPromptTurn(scope)` at a turn
 * boundary, and is served to every render for that scope until the next
 * boundary. What invalidates a pin, and why:
 *
 * - NEXT PERSONAL AI TURN BOUNDARY (primary). `loop.ts` re-pins from the SAME
 *   gate that already resets the consolidation breaker — deliberately reusing
 *   that one definition of "a real turn started" instead of inventing a second,
 *   divergent one. That gate excludes subagents (`options.system` set) and the
 *   `background-review` fork.
 * - EXPLICIT `invalidate(scope?)`. Used by the human-facing memory editor
 *   (`PUT /api/memory/global|user` is a full-file replacement — the user's
 *   explicit intent to change what the Personal AI believes, so it must not wait for
 *   a turn) and by tests.
 * - NOTHING ELSE. A write through the store does NOT invalidate: that is the
 *   Hermes rationale, and it is what stops the same-turn re-learn loop.
 *
 * WHY "FREEZE UNTIL WRITE-BY-SELF", NOT "FREEZE FOREVER"
 * ------------------------------------------------------
 * Hermes freezes for a whole session because a Hermes session is a CLI process
 * lifetime — minutes to hours. A Walnut *conversation* is a file that is resumed
 * across restarts and can stay open for days. Freezing for a conversation's
 * lifetime would mean the `background-review` fork could distil a lesson, write
 * it durably, and have it ignored for days — silently throwing away the entire
 * learning loop the fork exists to run. So the fork's writes must reach the next
 * REAL turn, and they do: the write lands on disk mid-fork, the pin holds for the
 * rest of that turn, and the next main-turn boundary re-pins and picks it up.
 * That is strictly "freeze until write-by-self, adopted at the next boundary".
 *
 * UNPINNED SCOPES READ THROUGH
 * ----------------------------
 * `renderForPrompt()` with no scope, or with a scope that has no pin, reads live
 * from disk. Freezing is opt-in per scope, so no caller is silently pinned to
 * stale content by merely existing, and a crashed turn degrades to today's
 * behavior rather than wedging a stale snapshot.
 *
 * DRIFT DETECTION
 * ---------------
 * Every pin records the sha of the RAW file bytes. At the next boundary the new
 * sha is compared to the old one and attributed with a monotonic write epoch the
 * store bumps on each successful mutation:
 *
 * - hash changed, epoch advanced  → `self`: our own write (memory_manage, the
 *   review fork). Expected; logged at debug.
 * - hash changed, epoch unchanged → `external`: a hand edit, a `file_write` on a
 *   memory path, the git-sync data plane, the web editor, or another process.
 *   Logged at WARN with both hashes and recorded on the store, because these
 *   paths bypass every write-time check (budget, entry shape, safety screen) and
 *   a silent mutation of the Personal AI's standing rules is exactly the thing an
 *   operator needs to be able to see after the fact.
 *
 * Attribution is best-effort by construction: if a self write AND an external
 * edit both land between two boundaries, the epoch only proves *a* self write
 * happened, so the pair reports `self`. Detection of the change is still exact —
 * only the blame is coarse.
 */
import { log } from '../logging/index.js';

/** Scope with no conversation attached (forks and callers that pass nothing). */
export const DEFAULT_PROMPT_SCOPE = 'general:_default';

/**
 * Build the freeze scope key. One pin per (agent, conversation): two
 * conversations interleaving turns must not evict each other's view.
 */
export function promptScope(agentId?: string, conversationId?: string): string {
  return `${agentId ?? 'general'}:${conversationId ?? '_default'}`;
}

/** A frozen render of a bounded store, as injected for one turn. */
export interface MemoryPromptPin {
  /** The rendered block, or null when the store was empty at freeze time. */
  block: string | null;
  /** sha of the RAW file bytes at freeze time — the drift anchor. */
  contentHash: string;
  /** The store's write epoch at freeze time — used to attribute drift. */
  epoch: number;
  frozenAt: number;
}

/** An observed on-disk change between two consecutive pins of one scope. */
export interface MemoryPromptDrift {
  scope: string;
  previousHash: string;
  currentHash: string;
  /** `self` = a write through this store since the last pin; `external` = not ours. */
  origin: 'self' | 'external';
  at: number;
}

/**
 * How many scopes keep a pin. Bounded so a long-lived server that cycles through
 * many conversations can't grow this map without limit; eviction is oldest-first
 * and only costs the evicted scope a live re-read (correct, just unfrozen).
 */
const MAX_PINNED_SCOPES = 8;

/**
 * Per-store pin table. One instance per BoundedMemoryStore, so MEMORY.md and
 * USER.md freeze and drift independently.
 */
export class MemoryPromptSnapshots {
  private readonly pins = new Map<string, MemoryPromptPin>();
  private drift: MemoryPromptDrift | null = null;
  private driftCount = 0;

  constructor(private readonly label: string) {}

  /** The pin for `scope`, or undefined when that scope reads through. */
  get(scope: string): MemoryPromptPin | undefined {
    return this.pins.get(scope);
  }

  /**
   * Freeze `block` for `scope` at a turn boundary, attributing any on-disk change
   * since this scope's previous pin. Returns the drift record when the content
   * changed, so the caller can surface it.
   */
  pin(
    scope: string,
    block: string | null,
    contentHash: string,
    epoch: number,
  ): MemoryPromptDrift | null {
    const previous = this.pins.get(scope);
    let observed: MemoryPromptDrift | null = null;

    if (previous && previous.contentHash !== contentHash) {
      // Epoch advanced ⇒ at least one write went through this store since the
      // last pin ⇒ treat the change as ours. See the header note on why this
      // attribution is deliberately coarse.
      const origin: 'self' | 'external' = epoch > previous.epoch ? 'self' : 'external';
      observed = {
        scope,
        previousHash: previous.contentHash,
        currentHash: contentHash,
        origin,
        at: Date.now(),
      };
      this.drift = observed;
      this.driftCount += 1;
      if (origin === 'external') {
        log.memory.warn('memory snapshot drift: on-disk change not written by this store', {
          store: this.label,
          scope,
          previousHash: previous.contentHash,
          currentHash: contentHash,
          // The new content is adopted from this turn on — this is a report of an
          // unattributed write, not a rejection of it.
          adopted: true,
        });
      } else {
        log.memory.debug('memory snapshot refreshed after own write', {
          store: this.label, scope, previousHash: previous.contentHash, currentHash: contentHash,
        });
      }
    }

    // Evict oldest first (Map preserves insertion order); re-pinning an existing
    // scope must refresh in place, so delete before set.
    this.pins.delete(scope);
    while (this.pins.size >= MAX_PINNED_SCOPES) {
      const oldest = this.pins.keys().next();
      if (oldest.done) break;
      this.pins.delete(oldest.value);
    }
    this.pins.set(scope, { block, contentHash, epoch, frozenAt: Date.now() });
    return observed;
  }

  /** Drop one scope's pin, or all of them when `scope` is omitted. */
  invalidate(scope?: string): void {
    if (scope === undefined) this.pins.clear();
    else this.pins.delete(scope);
  }

  /** Most recent observed drift, for tests and observability. */
  lastDrift(): MemoryPromptDrift | null {
    return this.drift;
  }

  /** Total drifts observed since process start. */
  totalDrifts(): number {
    return this.driftCount;
  }

  /** Test hook — forget drift history without touching pins. */
  resetDrift(): void {
    this.drift = null;
    this.driftCount = 0;
  }
}
