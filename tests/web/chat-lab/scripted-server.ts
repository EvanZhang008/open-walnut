/**
 * ScriptedServer — the chat lab's stand-in for `GET /history` + the CLI's
 * canonical JSONL, with FAULT KNOBS that reproduce every serving pathology the
 * incident chain documented. The delta resolution itself is THE REAL production
 * code (src/core/history-delta.ts) — the lab proves the shipped contract, not a
 * reimplementation. Only the transport (Express/SSH) is skipped.
 *
 * Fault knobs (each one is a documented production failure, not a hypothetical):
 *  · windowStart > 0     — whale-session 4 MiB sliding tail: the served parse is
 *                          canonical.slice(windowStart), so the index space
 *                          shifts under the client (inc-1785993576822).
 *  · legacyCountDelta    — the PRE-FIX contract: `since <= total → slice(since)`,
 *                          no anchor, no windowed refusal. Turning this on must
 *                          make the whale scenario REPRODUCE the stuck bubble —
 *                          that is the lab's proof it can replicate the bug.
 *  · noUnsettledStamp    — the PRE-FIX contract for late-settling rows: rows are
 *                          served without the `unsettled` flag, so the client
 *                          never re-asks and a mid-flight Agent row stays frozen
 *                          (inc-1785965937858 — the phantom subagent box).
 *  · dropRevisions       — server ignores `reviseIds` (transport regression).
 */

import type { SessionHistoryMessage } from '../../../web/src/types/session';
import {
  resolveDeltaStart,
  deltaCursor,
  collectRequestedRevisions,
  isUnsettledRow,
} from '../../../src/core/history-delta.js';

export interface ServeRequest {
  since?: number;
  anchorMsgId?: string;
  anchorTail?: number;
  reviseIds?: string[];
  /** Lazy tail (?tail=N): full payloads serve only the last N rows, but
   *  total/cursor stay in the FULL count space. Honored deltas ignore it —
   *  mirror of src/web/routes/sessions.ts. */
  tail?: number;
}

export interface ServeResponse {
  messages: SessionHistoryMessage[];
  revisedMessages?: SessionHistoryMessage[];
  cursor: number;
  total: number;
  delta: boolean;
}

export interface ScriptedServerFaults {
  /** Serve the PRE-FIX count-only delta contract (anchor ignored). */
  legacyCountDelta?: boolean;
  /** Do not stamp `unsettled` on late-settling rows (pre-fix behavior). */
  noUnsettledStamp?: boolean;
  /** Ignore reviseIds (never serve revisions). */
  dropRevisions?: boolean;
}

export class ScriptedServer {
  /** The CLI's canonical JSONL, parsed. Scenario scripts append here. */
  canonical: SessionHistoryMessage[] = [];
  /** Whale sliding tail: the served parse starts here (evicted head). */
  windowStart = 0;
  faults: ScriptedServerFaults = {};
  /** Every request served, for scenario assertions (what did the client ask?). */
  readonly requests: ServeRequest[] = [];

  /** What a history read returns right now (the bounded-tail parse). */
  get parse(): SessionHistoryMessage[] {
    return this.canonical.slice(this.windowStart);
  }

  get windowed(): boolean {
    return this.windowStart > 0;
  }

  append(...msgs: SessionHistoryMessage[]): void {
    this.canonical.push(...msgs);
  }

  /** Slide the whale window: evict n rows from the served head. */
  evict(n: number): void {
    this.windowStart += n;
  }

  /** The CLI appended a <task-notification> — the parser now stamps
   *  bgTaskFinished onto the Agent/Task tool of the row that ISSUED it.
   *  This mutates the canonical row IN PLACE (same msgId): the exact
   *  "prefix is not immutable" shape of inc-1785965937858. */
  stampBgFinished(msgId: string, toolUseId: string): void {
    for (const m of this.canonical) {
      if (m.msgId !== msgId || !m.tools) continue;
      for (const t of m.tools) {
        if (t.toolUseId === toolUseId) (t as { bgTaskFinished?: boolean }).bgTaskFinished = true;
      }
    }
  }

  private stampUnsettled(msgs: SessionHistoryMessage[]): SessionHistoryMessage[] {
    // DEEP copy — production serves over HTTP JSON, so the client's copy never
    // shares references with the server's parse. A shallow copy here would leak
    // stampBgFinished's in-place tool mutation into rows the client "synced"
    // earlier, silently un-reproducing the frozen-prefix bug.
    const cloned = msgs.map(m => JSON.parse(JSON.stringify(m)) as SessionHistoryMessage);
    if (this.faults.noUnsettledStamp) return cloned;
    return cloned.map(m => (isUnsettledRow(m) ? { ...m, unsettled: true } : m));
  }

  /** Full payload, tail-bounded when the request carried ?tail=N — the exact
   *  shape of the route's final res.json (slice(-tail), full-space total). */
  private full(messages: SessionHistoryMessage[], total: number, tail?: number): ServeResponse {
    const sliced = tail && tail > 0 ? messages.slice(-tail) : messages;
    return { messages: this.stampUnsettled(sliced), cursor: total, total, delta: false };
  }

  /** The /history endpoint. Mirrors src/web/routes/sessions.ts' delta branch. */
  serve(req: ServeRequest = {}): ServeResponse {
    this.requests.push({ ...req, reviseIds: req.reviseIds ? [...req.reviseIds] : undefined });
    const messages = this.parse;
    const total = messages.length;

    if (req.since === undefined) {
      return this.full(messages, total, req.tail);
    }

    if (this.faults.legacyCountDelta) {
      // PRE-FIX contract, verbatim: a bare count sliced against a shifting
      // index space. `since <= total` still passes after the window slid, so
      // the newest rows silently fall out of the slice.
      if (Number.isFinite(req.since) && req.since >= 0 && req.since <= total) {
        return {
          messages: this.stampUnsettled(messages.slice(req.since)),
          cursor: total, total, delta: true,
        };
      }
      return this.full(messages, total, req.tail);
    }

    const resolved = resolveDeltaStart(
      messages,
      { since: req.since, anchorMsgId: req.anchorMsgId, anchorTail: req.anchorTail },
      { windowed: this.windowed },
    );
    if (resolved.kind === 'rebuild') {
      return this.full(messages, total, req.tail);
    }
    const slice = messages.slice(resolved.start);
    const reviseIds = this.faults.dropRevisions ? [] : (req.reviseIds ?? []);
    const { revised, ambiguous } = collectRequestedRevisions(messages, reviseIds);
    if (ambiguous) {
      return this.full(messages, total, req.tail);
    }
    return {
      messages: this.stampUnsettled(slice),
      ...(revised.length > 0 ? { revisedMessages: this.stampUnsettled(revised) } : {}),
      cursor: deltaCursor(
        { since: req.since, anchorMsgId: req.anchorMsgId, anchorTail: req.anchorTail },
        slice.length, total,
      ),
      total,
      delta: true,
    };
  }
}

// ── Canonical-row builders (neutral fixture content only — public repo) ──────

let rowSeq = 0;
export function resetRowSeq(): void { rowSeq = 0; }

export function userRow(text: string, opts?: { walnutMessageId?: string }): SessionHistoryMessage {
  return {
    role: 'user', text, timestamp: new Date(1700000000000 + rowSeq * 1000).toISOString(),
    msgId: `u_${++rowSeq}`,
    ...(opts?.walnutMessageId ? { walnutMessageId: opts.walnutMessageId } : {}),
  };
}

export function assistantRow(text: string, opts?: {
  msgId?: string;
  tools?: SessionHistoryMessage['tools'];
  thinking?: string;
}): SessionHistoryMessage {
  return {
    role: 'assistant', text, timestamp: new Date(1700000000000 + rowSeq * 1000).toISOString(),
    msgId: opts?.msgId ?? `m_${++rowSeq}`,
    ...(opts?.tools ? { tools: opts.tools } : {}),
    ...(opts?.thinking ? { thinking: opts.thinking } : {}),
  };
}

export function agentTool(toolUseId: string, opts?: { finished?: boolean; name?: string }): NonNullable<SessionHistoryMessage['tools']>[number] {
  return {
    name: opts?.name ?? 'Agent',
    input: { description: 'lab agent', prompt: 'do the thing' },
    toolUseId,
    result: `agentId: ${toolUseId.replace(/[^a-f0-9]/g, '')}abc launched`,
    ...(opts?.finished ? { bgTaskFinished: true } : {}),
  };
}
