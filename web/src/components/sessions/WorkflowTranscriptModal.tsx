/**
 * WorkflowTranscriptModal — full-screen reader for one dynamic-workflow subagent's
 * complete transcript.
 *
 * The inline accordion in WorkflowProgress shows only the prompt + result preview;
 * the full per-agent conversation (subagents/workflows/<run>/agent-<id>.jsonl) is too
 * long for that cramped box. This opens it in a large overlay (≈90vw×90vh) so it's
 * actually readable — reusing the app's modal infra (useModalOverlay = Escape +
 * ref-counted scroll lock) and portal-to-body, the same pattern as ConfirmDialog /
 * the session fullscreen.
 *
 * Lazy-fetches on mount via the subagent history endpoint and caches per agentId. A
 * WORKFLOW subagent is namespaced `wf:` so it can't collide with a flat Task/Team
 * subagent id; a plain Agent-tool subagent (`workflow: false`, the Background panel's
 * ledger rows) uses the bare agentId — the SAME key the chat's TaskGroup lazy-load
 * writes, so the two surfaces share one fetch.
 *
 * A LIVE target (`live: true`, the agent is still running) polls every 5s and never
 * writes the cache: a running agent's transcript is partial, and seeding the shared key
 * with it would pin the truncated version in the chat too. The final fetch + cache write
 * happens when the agent finishes while the modal is open.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { fetchSubagentHistory } from '@/api/sessions';
import { getSubagentCache, setSubagentCache } from '@/cache/session-cache';
import { SessionMessage } from './SessionMessage';
import { ICON_CLOSE } from '../common/Icons';
import type { SessionHistoryMessage } from '@/types/session';
import { log } from '@/utils/log';

/** How often a still-running agent's transcript is re-read while the modal is
 *  open. Each poll is a full read + parse of the agent's JSONL on the server
 *  (a remote host's file crosses the tunnel), so ticks are skipped while a
 *  previous read is in flight or the tab is hidden. */
const LIVE_POLL_MS = 8000;

export interface TranscriptTarget {
  agentId: string;
  label?: string;
  model?: string;
  meta?: string; // pre-formatted "model · tokens · duration"
  /** Dynamic-workflow subagent (the default, so the WorkflowGraph caller is unchanged).
   *  false = a plain Agent-tool subagent: bare cache key + the flat history layout. */
  workflow?: boolean;
  /** The agent is still running → poll, and don't cache a partial transcript. */
  live?: boolean;
}

export function WorkflowTranscriptModal({
  target, sessionId, onClose,
}: { target: TranscriptTarget; sessionId: string; onClose: () => void }) {
  useModalOverlay(onClose);
  const [messages, setMessages] = useState<SessionHistoryMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  // Distinct from an empty transcript: a fetch failure must NOT render the same as
  // "this agent produced nothing" — otherwise a backend/network error silently looks
  // like a legitimately empty run.
  const [failed, setFailed] = useState(false);
  const workflow = target.workflow !== false;
  const live = target.live === true;
  // Previous `live` — a true→false flip means the agent finished while we watched, which
  // is the one moment a cache hit would be wrong (it holds nothing, we never wrote one)
  // and a final fetch is owed.
  const wasLiveRef = useRef(live);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = workflow ? `wf:${target.agentId}` : target.agentId;
    const justFinished = wasLiveRef.current && !live;
    wasLiveRef.current = live;

    const cached = justFinished ? undefined : getSubagentCache(sessionId, cacheKey);
    if (cached) setMessages(cached);
    // A cache hit is the whole answer only for a finished agent; a live one keeps polling.
    if (cached && !live) return;

    let inFlight = false;
    // `isFirst` = nothing is on screen yet: only then may a load show the
    // spinner or declare failure. The final fetch after a live→finished flip
    // and every poll refresh in place — a transient error must never blank a
    // transcript that already painted.
    const load = (isFirst: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (isFirst) { setLoading(true); setFailed(false); }
      return fetchSubagentHistory(sessionId, target.agentId, { workflow })
        .then((res) => {
          if (cancelled) return;
          setMessages(res.messages);
          // Only a finished agent's transcript is complete enough to cache.
          if (!live) setSubagentCache(sessionId, cacheKey, res.messages);
          log.info('workflow', `loaded subagent transcript ${target.agentId}: ${res.messages.length} msgs`, { sessionId });
        })
        .catch((err) => {
          if (cancelled) return;
          log.warn('workflow', 'failed to load subagent transcript', { agentId: target.agentId, error: String(err) });
          if (isFirst) { setMessages([]); setFailed(true); }
        })
        .finally(() => { inFlight = false; if (!cancelled && isFirst) setLoading(false); });
    };

    load(!cached && !justFinished);
    if (!live) return () => { cancelled = true; };
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      load(false);
    }, LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionId, target.agentId, workflow, live]);

  return createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <span className="wf-modal-title">{target.label || target.agentId}</span>
          {live && <span className="wf-modal-live" title="Agent still running — refreshing while open">{'●'}</span>}
          {target.meta && <span className="wf-modal-meta">{target.meta}</span>}
          <button className="wf-modal-close" onClick={onClose} aria-label="Close transcript" title="Close (Esc)">
            {ICON_CLOSE}
          </button>
        </div>
        <div className="wf-modal-body">
          {loading ? (
            <div className="wf-modal-loading">Loading transcript…</div>
          ) : failed ? (
            <div className="wf-modal-loading">Failed to load transcript. Close and reopen to retry.</div>
          ) : messages && messages.length > 0 ? (
            messages.map((m, i) => <SessionMessage key={i} message={m} sessionId={sessionId} />)
          ) : (
            <div className="wf-modal-loading">No transcript available</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
