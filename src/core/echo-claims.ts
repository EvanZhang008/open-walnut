/**
 * Echo-claim registry: bind walnut queue message ids (`qm-…`) to the CLI's
 * canonical user-echo lines (Phase 1, ACP dialect — user-message identity).
 *
 * WHY THIS EXISTS: the CLI's stdout stream does NOT echo plain user text
 * messages (only tool_results / assistant output), so the live pipeline never
 * sees which canonical `user` line (with its `uuid`) corresponds to which
 * walnut send. The echo only materializes in the canonical JSONL
 * (~/.claude/projects/…/<sid>.jsonl) that history reads parse. Without a
 * binding, the frontend's optimistic-bubble dedup can only match by TEXT —
 * the root cause of the Pattern-A/duplicate-bubble bug family.
 *
 * HOW: at each delivery point (FIFO write / mid-turn inject / --resume spawn)
 * the runner registers a claim {qmIds, text}. When history is parsed,
 * bindEchoClaims() walks the messages chronologically and binds each unbound
 * claim (FIFO order) to the FIRST unclaimed user message whose text matches
 * and whose timestamp is not older than the claim (minus clock slack) — the
 * same forward-claim semantics as parseSessionMessages' Pattern-A twin logic.
 * The bound message is stamped with `walnutMessageId = qmIds[0]`, giving the
 * frontend an exact id to consume instead of a fuzzy text match.
 *
 * Limitations (documented, acceptable):
 *  - Batches >1 queued message are written as ONE combined FIFO payload, so
 *    the echo is one user line with the joined text; only qmIds[0] is stamped
 *    (SessionHistoryMessage has a single walnutMessageId). Remaining bubbles
 *    fall back to the historical count/text semantics — no worse than before.
 *  - The registry is in-memory: a server restart loses unbound claims and the
 *    frontend falls back to text dedup. Bindings only matter for the short
 *    window while optimistic bubbles are still rendered, so this is fine.
 */

const CLAIM_TTL_MS = 2 * 60 * 60 * 1000; // claims older than 2h are stale
const MAX_CLAIMS_PER_SESSION = 100;
const MAX_BINDINGS_PER_SESSION = 500;
/** The echo line's timestamp is written at/after delivery; allow this much
 *  backward clock drift (remote CLI clock vs walnut clock) before rejecting. */
const BIND_CLOCK_SLACK_MS = 5 * 60 * 1000;

interface EchoClaim {
  qmIds: string[];
  text: string;
  registeredAt: number;
}

interface SessionClaims {
  /** Unbound claims, FIFO delivery order. */
  claims: EchoClaim[];
  /** qmId → canonical msgId (uuid / queue-<ts>) — survives re-parses. */
  bindings: Map<string, string>;
  /** msgIds already claimed — a message binds at most one claim. */
  boundMsgIds: Set<string>;
}

/** Minimal structural shape of a parsed history message (avoids importing
 *  session-history types — this module sits below it). Mutated in place. */
export interface EchoBindableMessage {
  role: string;
  text: string;
  timestamp: string;
  msgId?: string;
  walnutMessageId?: string;
}

const store = new Map<string, SessionClaims>();

function getOrCreate(sessionId: string): SessionClaims {
  let sc = store.get(sessionId);
  if (!sc) {
    sc = { claims: [], bindings: new Map(), boundMsgIds: new Set() };
    store.set(sessionId, sc);
  }
  return sc;
}

/**
 * Register a delivered batch so the next history parse can bind its echo.
 * Call right after a successful delivery (FIFO write / mid-turn / resume),
 * with the EXACT combined text that was written to the CLI.
 */
export function registerEchoClaims(sessionId: string, qmIds: string[], text: string): void {
  if (qmIds.length === 0 || !text.trim()) return;
  const sc = getOrCreate(sessionId);
  const now = Date.now();
  // Lazy prune: expired claims + oldest overflow.
  sc.claims = sc.claims.filter(c => now - c.registeredAt < CLAIM_TTL_MS);
  if (sc.claims.length >= MAX_CLAIMS_PER_SESSION) {
    sc.claims.splice(0, sc.claims.length - MAX_CLAIMS_PER_SESSION + 1);
  }
  sc.claims.push({ qmIds: [...qmIds], text, registeredAt: now });
}

/**
 * Stamp walnutMessageId onto parsed history messages: first re-apply existing
 * bindings (stable across re-parses via msgId), then bind unbound claims in
 * FIFO order to the earliest unclaimed matching user message. Mutates the
 * message objects in place; no-op when the session has no claims/bindings.
 */
export function bindEchoClaims(sessionId: string, messages: EchoBindableMessage[]): void {
  const sc = store.get(sessionId);
  if (!sc) return;

  // Re-stamp from existing bindings (parse results are rebuilt every read).
  if (sc.bindings.size > 0) {
    const byMsgId = new Map<string, string>();
    for (const [qmId, msgId] of sc.bindings) byMsgId.set(msgId, qmId);
    for (const msg of messages) {
      if (msg.role !== 'user' || msg.walnutMessageId || !msg.msgId) continue;
      const qmId = byMsgId.get(msg.msgId);
      if (qmId) msg.walnutMessageId = qmId;
    }
  }

  if (sc.claims.length === 0) return;

  const stillUnbound: EchoClaim[] = [];
  for (const claim of sc.claims) {
    const wanted = claim.text.trim();
    let bound = false;
    for (const msg of messages) {
      if (msg.role !== 'user' || msg.walnutMessageId || !msg.msgId) continue;
      if (sc.boundMsgIds.has(msg.msgId)) continue;
      if (msg.text.trim() !== wanted) continue;
      // Echoes are written at/after delivery — never bind to a message that
      // predates the claim (identical short texts recur across old turns).
      const ts = Date.parse(msg.timestamp);
      if (!Number.isNaN(ts) && ts < claim.registeredAt - BIND_CLOCK_SLACK_MS) continue;
      sc.bindings.set(claim.qmIds[0], msg.msgId);
      sc.boundMsgIds.add(msg.msgId);
      msg.walnutMessageId = claim.qmIds[0];
      bound = true;
      break;
    }
    if (!bound) stillUnbound.push(claim);
  }
  sc.claims = stillUnbound;

  // Bindings cap: drop oldest (Map preserves insertion order).
  while (sc.bindings.size > MAX_BINDINGS_PER_SESSION) {
    const oldest = sc.bindings.keys().next().value as string;
    const msgId = sc.bindings.get(oldest);
    sc.bindings.delete(oldest);
    if (msgId) sc.boundMsgIds.delete(msgId);
  }
}

/**
 * Revoke the UNBOUND claims of a batch that failed to reach the CLI.
 *
 * A failed delivery leaves a claim that will never have an echo — but the user
 * then hits Retry, which re-sends the SAME text under a NEW qm id. Claims bind in
 * FIFO order by text match, so the dead claim wins the race for the retry's echo
 * line: the new bubble never receives its `walnutMessageId` and falls back to text
 * matching (which for an attachment send can't match either) — the bubble stays
 * pinned at the bottom of the timeline (inc-1785091339102).
 *
 * Only unbound claims are dropped; existing bindings are untouched (they belong to
 * echoes that already materialized). Safe to call for ids that were never
 * registered — a failed spawn may precede any claim.
 */
export function revokeEchoClaims(sessionId: string, qmIds: string[]): void {
  const sc = store.get(sessionId);
  if (!sc || qmIds.length === 0) return;
  const revoked = new Set(qmIds);
  sc.claims = sc.claims.filter(c => !c.qmIds.some(id => revoked.has(id)));
}

/** Drop all state for a session (session removed / tests). */
export function clearEchoClaims(sessionId: string): void {
  store.delete(sessionId);
}

/** Test-only: wipe the whole registry. */
export function _resetEchoClaimsForTest(): void {
  store.clear();
}
