/**
 * WorkflowTranscriptModal — full-screen reader for one subagent's complete transcript.
 *
 * This overlay is THE place a subagent's conversation is read, from every entry:
 * the Background ledger's "View transcript", the Agent row in the chat (persisted
 * or still streaming), and a dynamic workflow's agent node. The chat never unfolds
 * a subagent inline (the 2026-09-08 "is this the previous agent or the current
 * one?" report came from a chat row that looked like a dropdown and expanded the
 * whole subagent into the main conversation). Reuses the app's modal infra
 * (useModalOverlay = Escape + ref-counted scroll lock) and portals to body, the
 * same pattern as ConfirmDialog / the session fullscreen.
 *
 * `TranscriptOverlay` is the bare shell (header + scrolling body) for callers that
 * already hold the content (the streaming Agent row renders its live lane blocks);
 * `WorkflowTranscriptModal` is the fetching variant.
 *
 * Fetch + cache: a WORKFLOW subagent is namespaced `wf:` so it can't collide with a
 * flat Task/Team subagent id; a plain Agent-tool subagent (`workflow: false`) uses
 * the bare agentId. A LIVE target (the agent is still running) polls and never
 * writes the cache: a running agent's transcript is partial, and seeding the shared
 * key with it would pin the truncated version everywhere. The final fetch + cache
 * write happens when the agent finishes while the modal is open.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { fetchSubagentHistory } from '@/api/sessions';
import { getSubagentCache, setSubagentCache } from '@/cache/session-cache';
import { SessionMessage, TaskGroupPrompt } from './SessionMessage';
import type { ReactNode } from 'react';
import { ICON_CLOSE } from '../common/Icons';
import type { SessionHistoryMessage } from '@/types/session';
import { log } from '@/utils/log';
import { renderMarkdownWithRefs } from '@/utils/markdown';

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
  /** Transcript the caller already holds (history embedded the subagent's
   *  messages under the Agent tool): shown as-is, no fetch. */
  preloaded?: SessionHistoryMessage[];
  /** The Agent tool's result text — shown when there is no transcript to read
   *  (an old session whose subagent file is gone, or an agent whose id the
   *  parser never learned). */
  fallbackResult?: string;
  /** The Agent tool's input, for the collapsed "Prompt & settings" row on top. */
  promptInput?: Record<string, unknown>;
}

/** The overlay shell every transcript reader shares: title row (label, live dot,
 *  meta, close) over a scrolling body. Escape and backdrop click close it. */
export function TranscriptOverlay({
  title, meta, live, onClose, children,
}: { title: string; meta?: string; live?: boolean; onClose: () => void; children: ReactNode }) {
  useModalOverlay(onClose);
  return createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <span className="wf-modal-title">{title}</span>
          {live && <span className="wf-modal-live" title="Agent still running — refreshing while open">{'●'}</span>}
          {meta && <span className="wf-modal-meta">{meta}</span>}
          <button className="wf-modal-close" onClick={onClose} aria-label="Close transcript" title="Close (Esc)">
            {ICON_CLOSE}
          </button>
        </div>
        <div className="wf-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** The fetching reader for ONE agent's transcript, without a shell: the modal
 *  below wraps it in the overlay; the Background tasks panel mounts it in its
 *  detail column. Owns the cache/poll rules described in the file header. */
export function TranscriptBody({ target, sessionId }: { target: TranscriptTarget; sessionId: string }) {
  const [messages, setMessages] = useState<SessionHistoryMessage[] | null>(target.preloaded ?? null);
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

  // Switching agents inside the panel: drop the previous agent's messages at once
  // so the old transcript never shows under the new title while the fetch runs.
  useEffect(() => { setMessages(target.preloaded ?? null); setFailed(false); }, [target.agentId, target.preloaded]);

  const preloaded = target.preloaded != null && !live;
  useEffect(() => {
    // Embedded children ARE the transcript for a finished agent; nothing to fetch.
    if (preloaded) return;
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
  }, [sessionId, target.agentId, workflow, live, preloaded]);

  return (
    <>
      {target.promptInput && <TaskGroupPrompt input={target.promptInput} />}
      {loading ? (
        <div className="wf-modal-loading">Loading transcript…</div>
      ) : failed ? (
        <div className="wf-modal-loading">Failed to load transcript. Close and reopen to retry.</div>
      ) : messages && messages.length > 0 ? (
        messages.map((m, i) => <SessionMessage key={i} message={m} sessionId={sessionId} />)
      ) : target.fallbackResult ? (
        <div className="task-group-result">
          <div className="task-group-result-label">Result</div>
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdownWithRefs(target.fallbackResult.slice(0, 3000)) }} />
        </div>
      ) : (
        <div className="wf-modal-loading">{live ? 'Waiting for the agent\u2019s first output…' : 'No transcript available'}</div>
      )}
    </>
  );
}

export function WorkflowTranscriptModal({
  target, sessionId, onClose,
}: { target: TranscriptTarget; sessionId: string; onClose: () => void }) {
  return (
    <TranscriptOverlay title={target.label || target.agentId} meta={target.meta} live={target.live === true} onClose={onClose}>
      <TranscriptBody target={target} sessionId={sessionId} />
    </TranscriptOverlay>
  );
}
