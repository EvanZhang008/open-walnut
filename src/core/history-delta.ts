/**
 * Identity-anchored delta resolution for `GET /api/sessions/:id/history?since=N`.
 *
 * WHY THIS EXISTS: `since` is a COUNT of parsed messages, and that array is NOT
 * the monotonic append-only space the count assumes:
 *  · a `/compact` rewrite shrinks it — and can land on the SAME count with
 *    DIFFERENT content (inc-1783472776601);
 *  · groupInlineChildren retroactively removes rows once a subagent's parent
 *    result arrives, so the count shrinks mid-conversation;
 *  · a whale transcript over DaemonFileReader's byte ceiling is served from a
 *    4 MiB SLIDING TAIL, so the count moves DOWN as the head is evicted while the
 *    turn appends at the tail. Verified live on a 55.8 MB session (1252 bounded-tail
 *    reads for that one session): the cursor went 1773 → 1764 → 1763 → 1765 → 1768
 *    → 1770 → 1753 → 1754. `since <= total` still passed, so `messages.slice(since)`
 *    silently omitted the NEWEST messages — including the user's own echo. With the
 *    echo missing, the optimistic bubble had no absorption evidence at all and
 *    stayed pinned at the bottom of the timeline forever (inc-1785993576822).
 *
 * FIX: the client also sends the IDENTITY (`msgId`) of the newest message it holds
 * that has one, plus how many id-less rows follow it. We locate that id in the
 * CURRENT parse and slice after it, so identity decides the split point and the
 * count is only a fallback. A shifted index space can then no longer silently drop
 * (or duplicate) messages — it degrades to a full rebuild, which is lossless.
 *
 * The failure direction is deliberate and one-way: every ambiguous case rebuilds.
 * Re-sending history the client already has costs bandwidth; dropping a message
 * costs the user their conversation.
 */

/** What the client claims to already hold. */
export interface DeltaAnchorRequest {
  /** Count of messages the client has rendered (its own array length). */
  since: number;
  /** msgId of the newest client-held message that has one (absent on old bundles). */
  anchorMsgId?: string;
  /** How many id-less client-held rows follow the anchor. */
  anchorTail?: number;
}

export type DeltaResolution =
  | { kind: 'delta'; start: number }
  | { kind: 'rebuild'; reason: string };

interface HasMsgId {
  msgId?: string;
}

/**
 * Decide where the delta slice starts, or that the client must rebuild.
 *
 * `windowed` = this parse came from a bounded sliding tail, so its length is NOT a
 * cursor space. An anchored request still works (identity survives the slide); an
 * anchorless one MUST rebuild.
 */
export function resolveDeltaStart(
  messages: readonly HasMsgId[],
  req: DeltaAnchorRequest,
  opts?: { windowed?: boolean },
): DeltaResolution {
  const total = messages.length;
  const { since, anchorMsgId } = req;
  const anchorTail = Math.max(0, req.anchorTail ?? 0);

  if (!Number.isFinite(since) || since < 0) return { kind: 'rebuild', reason: 'since-invalid' };

  if (anchorMsgId) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < total; i++) {
      if (messages[i].msgId !== anchorMsgId) continue;
      if (first < 0) first = i;
      last = i;
    }
    // Anchor gone = history was rewritten under us (compact / rotation / the
    // window slid past it). Rebuild rather than guess an offset.
    if (first < 0) return { kind: 'rebuild', reason: 'anchor-missing' };
    // The same message id can tag several parsed rows (a tool row inherits its
    // parent message's id). Slicing after the wrong occurrence would DROP
    // messages — the one forbidden direction — so rebuild instead.
    if (first !== last) return { kind: 'rebuild', reason: 'anchor-ambiguous' };
    const start = first + 1 + anchorTail;
    if (start > total) return { kind: 'rebuild', reason: 'anchor-client-ahead' };
    return { kind: 'delta', start };
  }

  // Anchorless (a cached older SPA bundle). A raw count is only meaningful in a
  // stable index space — never in a sliding window.
  if (opts?.windowed) return { kind: 'rebuild', reason: 'windowed-no-anchor' };
  if (since > total) return { kind: 'rebuild', reason: 'since-ahead' };
  return { kind: 'delta', start: since };
}

/**
 * Rows whose CONTENT can still change after they are served — the second lossy
 * assumption in the old delta contract.
 *
 * inc-1785965937858 — the contract used to claim "native history messages are immutable
 * by the time this endpoint exposes them, so slicing messages[N..] is lossless". That is
 * FALSE for Agent/Task tools: `bgTaskFinished` is stamped onto the assistant message
 * that ISSUED the tool_use, from a `task-notification` line the CLI appends much later —
 * 74 s later in the measured incident. The client synced that row while the agent was
 * still running, so its copy never gained the flag, that agent's lane blocks never got
 * absorption proof, and a phantom Agent box sat at the bottom of the timeline until a
 * manual reload. Three delta refetches all returned 200 and all were structurally
 * incapable of carrying the fix.
 *
 * WHO DECIDES WHAT TO RE-SEND — the client, not the server. The server cannot infer
 * which version the client holds: by the time it serves the next delta its own row is
 * already settled, so "re-send my unsettled rows" would re-send nothing, which is
 * exactly the bug. Instead the server STAMPS `unsettled` on rows it serves, and the
 * client asks for those ids back by name. That makes the request self-terminating (once
 * the client holds a settled copy it stops asking) and keeps the predicate in ONE place
 * — the client never re-implements it, it just reads the flag.
 *
 * Re-sending a few rows rather than falling through to a full rebuild is deliberate: a
 * whale transcript's full payload is tens of MB over SSH, and pulling it every turn
 * while a subagent runs is what wedged the tunnel in inc-1783532915925.
 *
 * "Unsettled" is deliberately NOT a tool-name allowlist — a tool whose result hasn't
 * landed is unsettled by definition, whatever it is called. A future tool with late
 * metadata is covered without another patch.
 */
export interface RevisableRow {
  msgId?: string;
  tools?: { toolUseId?: string; name?: string; result?: string; bgTaskFinished?: boolean }[];
}

/** Groupable agent tools mint a lane whose only completion proof is bgTaskFinished. */
const LANE_TOOL_NAMES = new Set(['Task', 'Agent']);

/** True when this row's content can still change after it is served. */
export function isUnsettledRow(row: RevisableRow): boolean {
  if (!row.tools || row.tools.length === 0) return false;
  return row.tools.some(t => {
    if (!t.toolUseId) return false;
    // A lane-minting agent is settled only once its completion is proven — its
    // tool_result is launch metadata written while the agent still runs, so
    // result-presence proves nothing here.
    if (t.name && LANE_TOOL_NAMES.has(t.name)) return !t.bgTaskFinished;
    // Any other tool is settled once its result has landed.
    return t.result === undefined;
  });
}

/** Most unsettled ids a client may ask about — past this a full rebuild is honest. */
export const MAX_REVISION_REQUESTS = 20;

/**
 * Fresh copies of the rows the client asked to re-check, by msgId.
 *
 * `ambiguous` = at least one requested id is missing from the current parse, or tags
 * more than one row. Either way we cannot hand back an unambiguous replacement, so the
 * caller must rebuild — which also guarantees the client stops asking (an unanswerable
 * request would otherwise repeat every turn while the row stayed stale).
 */
export function collectRequestedRevisions<T extends RevisableRow>(
  messages: readonly T[],
  requestedIds: readonly string[],
): { revised: T[]; ambiguous: boolean } {
  if (requestedIds.length === 0) return { revised: [], ambiguous: false };
  if (requestedIds.length > MAX_REVISION_REQUESTS) return { revised: [], ambiguous: true };
  const byId = new Map<string, { row: T; count: number }>();
  for (const row of messages) {
    if (!row.msgId) continue;
    const hit = byId.get(row.msgId);
    if (hit) hit.count++;
    else byId.set(row.msgId, { row, count: 1 });
  }
  const revised: T[] = [];
  for (const id of requestedIds) {
    const hit = byId.get(id);
    if (!hit || hit.count !== 1) return { revised: [], ambiguous: true };
    revised.push(hit.row);
  }
  return { revised, ambiguous: false };
}

/**
 * The cursor to report back for a delta response.
 *
 * Anchored deltas keep the count space CLIENT-anchored: `since + slice.length` is
 * exactly what the client's array will measure after appending, so its
 * length-consistency guard is meaningful again (it was tautological when the
 * server echoed its own `total`, which is why the sliding window went undetected —
 * zero mismatch logs across the whole incident).
 */
export function deltaCursor(
  req: DeltaAnchorRequest,
  sliceLength: number,
  total: number,
): number {
  if (req.anchorMsgId) return req.since + sliceLength;
  return total;
}
