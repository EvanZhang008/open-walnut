/**
 * ChatEarlierBlock — what a chat said before this session started.
 *
 * Every phone chat is an ask, and the Mac opens an ask on its main session. That
 * session's transcript is only part of the chat when the chat is older than it: an
 * old phone chat opened again (its warm session never ran a turn), or a lane
 * re-minted after an archive. The rest lives in chat history and in older lane
 * sessions, and the server serves it in the phone's own shape
 * (GET /api/v1/sessions/:id/chat-earlier). Read-only rows above the transcript:
 * none of a session row's actions (rewind, pin, fork) can apply to them.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import { StableMarkdownBody } from './SessionMessage';
import '@/styles/chat-earlier.css';
import { earlierParts, type ChatEarlierMessage } from './chat-earlier-parts';
import { historyTurnWindowLimit, INITIAL_HISTORY_TURNS, EARLIER_HISTORY_TURNS } from '@open-walnut/history-turn-window';

export type { ChatEarlierMessage } from './chat-earlier-parts';

/** One stable empty answer, so a consumer's memo does not rerun for nothing. */
const NO_ROWS: ChatEarlierMessage[] = [];

/** How many times a degraded or failed read is asked again, and after how long. */
const CHAT_EARLIER_RETRIES = 2;
const CHAT_EARLIER_RETRY_MS = 2_000;

/**
 * Fetched once per session, and only when asked (`enabled`: a chat lane session
 * whose own history has been read from its start). A server that ran out of time
 * says `degraded`, and a read that failed says nothing either way: both are asked
 * again a couple of times, because the first read of a cold chat can take the
 * server's whole budget and the next one a second (live, 2026-10-11). After that
 * it reads as "nothing earlier", and the panel shows the session alone, as before.
 */
export function useChatEarlier(sessionId: string, enabled: boolean): ChatEarlierMessage[] {
  const [state, setState] = useState<{ sessionId: string; rows: ChatEarlierMessage[] } | null>(null);
  const fetched = state?.sessionId === sessionId;
  useEffect(() => {
    if (!enabled || fetched) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (attempt: number) => {
      const again = (why: string) => {
        if (cancelled) return;
        if (attempt < CHAT_EARLIER_RETRIES) {
          timer = setTimeout(() => read(attempt + 1), CHAT_EARLIER_RETRY_MS);
          return;
        }
        log.warn('session', 'chat-earlier gave up', { sessionId, why, attempts: attempt + 1 });
        setState({ sessionId, rows: [] });
      };
      apiGet<{ messages?: ChatEarlierMessage[]; degraded?: boolean }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/chat-earlier`, undefined, { priority: 'low' },
      ).then(
        (body) => {
          if (cancelled) return;
          if (body.degraded) { again('degraded'); return; }
          setState({ sessionId, rows: Array.isArray(body.messages) ? body.messages : [] });
        },
        (err: unknown) => again(err instanceof Error ? err.message : String(err)),
      );
    };
    read(0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sessionId, enabled, fetched]);
  return state && fetched ? state.rows : NO_ROWS;
}

export function ChatEarlierBlock({ rows, sessionCwd }: { rows: readonly ChatEarlierMessage[]; sessionCwd?: string }) {
  const parts = useMemo(() => earlierParts(rows), [rows]);
  const windowRows = useMemo(() => parts.map(part => part.kind === 'steps' || part.row.kind === 'notification'
    ? { role: 'assistant', text: '' } : part.row), [parts]);
  const [expanded, setExpanded] = useState(0);
  const shown = Math.max(expanded, historyTurnWindowLimit(windowRows, INITIAL_HISTORY_TURNS));
  const sectionRef = useRef<HTMLElement>(null);
  // The reader's distance from the timeline's bottom when they asked for more:
  // the rows open ABOVE them, and WebKit has no scroll anchoring to hold their
  // place (the timeline's own "Show earlier" restores the same way).
  const pendingBottom = useRef<number | null>(null);
  useLayoutEffect(() => {
    const dist = pendingBottom.current;
    pendingBottom.current = null;
    const scroller = sectionRef.current?.closest<HTMLElement>('.session-history');
    if (dist !== null && scroller) scroller.scrollTop = scroller.scrollHeight - dist;
  }, [shown]);
  if (parts.length === 0) return null;
  const hidden = Math.max(0, parts.length - shown);
  const showMore = () => {
    const scroller = sectionRef.current?.closest<HTMLElement>('.session-history');
    if (scroller) pendingBottom.current = scroller.scrollHeight - scroller.scrollTop;
    setExpanded(parts.length - hidden + historyTurnWindowLimit(windowRows, EARLIER_HISTORY_TURNS, undefined, hidden));
  };
  return (
    <section ref={sectionRef} className="chat-earlier" data-testid="chat-earlier" aria-label="Earlier in this chat">
      <div className="chat-earlier-label">Earlier in this chat</div>
      {hidden > 0 && (
        <button className="session-show-earlier-btn" onClick={showMore}>
          Load earlier turns
        </button>
      )}
      {parts.slice(hidden).map((part) => part.kind === 'steps' ? (
        <div key={`steps-${part.key}`} className="chat-earlier-steps">
          {part.count === 1 ? '1 step' : `${part.count} steps`}
        </div>
      ) : part.row.kind === 'notification' ? (
        <div key={part.row.id} className="chat-earlier-steps">{part.row.text}</div>
      ) : (
        <div
          key={part.row.id}
          className={`session-msg ${part.row.role === 'user' ? 'session-msg-user' : 'session-msg-assistant'} chat-earlier-row`}
          data-testid="chat-earlier-row"
        >
          <div className="session-msg-content">
            <StableMarkdownBody text={part.row.text} cwd={sessionCwd} />
          </div>
        </div>
      ))}
      <div className="chat-earlier-divider" role="separator"><span>This session</span></div>
    </section>
  );
}
