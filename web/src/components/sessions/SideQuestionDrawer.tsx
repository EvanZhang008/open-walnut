/**
 * SideQuestionDrawer — a small "💬 btw" PILL (sits inline next to the Bypass pill)
 * that opens a FLOATING POPOVER above it. Asks the NATIVE Claude Code `/btw` side
 * question inside this live coding session (reuses the session's own prompt-cache
 * prefix), so the answer never enters the main conversation.
 *
 * The popover is deliberately detached (shadow + border, floats over the panel) so
 * it never reads as "the chat input continued". Inside: a SCROLLING STACK of fully
 * boxed, independent Q&A cards (oldest top → newest bottom), and a SEPARATE, labelled
 * "Ask a new question" composer — together making clear every question is a one-shot
 * answered against the session's CURRENT state, NOT a follow-up thread. Each card can
 * be promoted into a task (optimistic).
 *
 * Single-shot UX (the native protocol returns one control_response, no token
 * streaming): show a spinner card, then the full answer. See web/src/api/sideQuestions.ts
 * and backend ClaudeCodeSession.askSideQuestion.
 *
 * Mounted in SessionPanel.tsx (home session column — the only session surface).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { renderMarkdown } from '@/components/chat/ChatMessage';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { NO_AUTOFILL_PROPS } from '@/utils/no-autofill';
import {
  listSideQuestions,
  askSideQuestion,
  promoteSideQuestion,
  type SideQuestion,
} from '@/api/sideQuestions';

interface SideQuestionDrawerProps {
  /** The Claude session id. Drawer is disabled until the session has a real id. */
  sessionId: string | undefined;
}

/** Sentinel promotedTaskId used for optimistic promote before the real id arrives. */
const PENDING_PROMOTE = '__pending__';

export function SideQuestionDrawer({ sessionId }: SideQuestionDrawerProps) {
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SideQuestion[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest card / spinner in view as the stack grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, asking, expanded]);

  // Load history when expanded / session changes.
  useEffect(() => {
    if (!expanded || !sessionId) return;
    let cancelled = false;
    listSideQuestions(sessionId)
      .then((r) => { if (!cancelled) setHistory(r.sideQuestions); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [expanded, sessionId]);

  // Live updates: another tab/route asked a side question on this session.
  useEvent('session:side-question-done', useCallback((data: unknown) => {
    const d = data as { sessionId?: string; id?: string };
    if (d?.sessionId !== sessionId) return;
    setHistory((prev) => (prev.some((q) => q.id === d.id)
      ? prev
      : [...prev, data as SideQuestion]));
  }, [sessionId]));

  const submit = useCallback(async () => {
    const q = question.trim();
    if (!q || !sessionId || asking) return;
    setAsking(true);
    setError(null);
    log.info('sideQuestion', 'asking', { sessionId, questionLen: q.length });
    try {
      const { sideQuestion } = await askSideQuestion(sessionId, q);
      setHistory((prev) => (prev.some((x) => x.id === sideQuestion.id) ? prev : [...prev, sideQuestion]));
      setQuestion('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      log.warn('sideQuestion', 'ask failed', { sessionId, error: msg });
    } finally {
      setAsking(false);
    }
  }, [question, sessionId, asking]);

  // Optimistic promote: the task is created server-side in ~750ms, but the shared
  // event loop can occasionally stall (background plugin sync), making the POST
  // appear to hang. Rather than block the user behind a long timeout, we mark the
  // entry promoted IMMEDIATELY and reconcile in the background — replacing the
  // optimistic flag with the real taskId/subtask result on success, or rolling
  // back (and surfacing an error) only if the server genuinely rejects it.
  const promote = useCallback(async (id: string) => {
    if (!sessionId) return;
    setError(null);
    setHistory((prev) => prev.map((q) => (q.id === id ? { ...q, promotedTaskId: PENDING_PROMOTE } : q)));
    try {
      const { taskId, parentTaskId } = await promoteSideQuestion(sessionId, id);
      setHistory((prev) => prev.map((q) => (q.id === id ? { ...q, promotedTaskId: taskId, promotedAsSubtask: !!parentTaskId } : q)));
    } catch (err) {
      // Roll back the optimistic mark so the Promote button returns.
      setHistory((prev) => prev.map((q) => (q.id === id && q.promotedTaskId === PENDING_PROMOTE ? { ...q, promotedTaskId: undefined } : q)));
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Promote failed: ${msg}`);
      log.warn('sideQuestion', 'promote failed', { sessionId, id, error: msg });
    }
  }, [sessionId]);

  const disabled = !sessionId;

  // Close the popover on outside-click / Escape.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [expanded]);

  return (
    <div className="side-question-root" ref={rootRef}>
      {/* Pill trigger — sits inline like the Bypass pill, NOT a full-width bar. */}
      <button
        className={`side-question-pill${expanded ? ' is-open' : ''}`}
        onClick={() => setExpanded((v) => !v)}
        disabled={disabled}
        title={disabled ? 'Available once the session has started' : 'Ask a quick, independent question — kept out of the main conversation'}
      >
        <span>btw</span>
        {history.length > 0 && <span className="side-question-count">{history.length}</span>}
      </button>

      {expanded && (
        // Floating popover above the pill — visually detached (shadow + border) so
        // it never reads as "the chat input continued". Its own composer makes clear
        // each question is NEW and independent, not a follow-up to the thread below.
        <div className="side-question-popover">
          <div className="side-question-popover-header">
            <span className="side-question-popover-title">Side questions</span>
            <span className="side-question-popover-hint">each one independent · kept out of the chat</span>
          </div>

          <div className="side-question-stack" ref={scrollRef}>
            {history.length === 0 && !asking && (
              <div className="side-question-empty">
                No questions yet — ask one below.
              </div>
            )}

            {history.map((q) => (
              <div key={q.id} className="side-question-card">
                <div className="side-question-card-q">{q.question}</div>
                <div
                  className="markdown-body side-question-card-a"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(q.answer) }}
                />
                <div className="side-question-card-actions">
                  {q.promotedTaskId === PENDING_PROMOTE ? (
                    <span className="side-question-promoted">{'✓'} creating…</span>
                  ) : q.promotedTaskId ? (
                    <span className="side-question-promoted">{'✓'} {q.promotedAsSubtask ? 'subtask created' : 'task created'}</span>
                  ) : (
                    <button className="btn btn-sm" onClick={() => promote(q.id)}>
                      {'➜ Promote to task'}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {asking && (
              <div className="side-question-card side-question-card-pending">
                <span className="side-question-spinner" /> Asking the session…
              </div>
            )}
          </div>

          {error && <div className="side-question-error">{error}</div>}

          {/* Composer — separated by a top divider + a quiet label so it reads as
              "ask a NEW question", without a loud coloured box fighting the cards. */}
          <div className="side-question-composer">
            <label className="side-question-composer-label">New question</label>
            <div className="side-question-composer-row">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
                placeholder="Ask about this session…"
                disabled={disabled || asking}
                autoFocus
                {...NO_AUTOFILL_PROPS}
              />
              <button className="btn btn-sm btn-primary" onClick={submit} disabled={disabled || asking || !question.trim()}>
                Ask
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
