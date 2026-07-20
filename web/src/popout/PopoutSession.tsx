import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { useEvent } from '@/hooks/useWebSocket';
import { wsClient } from '@/api/ws';
import { trackSession } from '@/cache/session-cache';
import { fetchSession } from '@/api/sessions';
import type { SessionRecord } from '@/types/session';

/**
 * Standalone READ-ONLY session viewer for a pop-out window.
 *
 * Renders the shared `SessionChatHistory` (history + live stream) filling the
 * window. Unlike the in-app SessionPanel, it mounts NO task lists, ChatInput,
 * or app-shell providers — the window holds only the one WS connection that
 * `SessionChatHistory` needs.
 *
 * To avoid receiving the full event firehose in this extra window, on mount we
 * narrow the connection's server-side interest to this single session
 * (`setInterest('lightweight', [id])`) and `trackSession(id)` so the global
 * session-cache listeners accumulate its stream. Interest is per-connection and
 * RESETS on reconnect, so we re-apply it on `_ws:reconnected`. On unmount we
 * restore the firehose (`setInterest('global')`) so the main window (if any,
 * sharing this origin's connection in its own tab) isn't left starved.
 *
 * Interaction callbacks (send/edit/delete/retry) are intentionally omitted — the
 * pop-out is a viewer. `SessionChatHistory` renders fine with them undefined.
 *
 * Layout uses a small `.popout-session` wrapper (see globals.css) mirroring the
 * `.popout-file` precedent so the scroll container fills the window.
 */
export function PopoutSession() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? '';
  const host = params.get('host') ?? undefined;
  const cwd = params.get('cwd') ?? undefined;

  const [session, setSession] = useState<SessionRecord | null>(null);

  // Narrow this connection's interest to just this session so the pop-out
  // doesn't pull the whole firehose. Re-applied on reconnect below.
  const applyInterest = useCallback(() => {
    if (!id) return;
    wsClient.setInterest('lightweight', [id]).catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    trackSession(id);
    applyInterest();
    // Restore the firehose when this window closes/unmounts.
    return () => {
      wsClient.setInterest('global').catch(() => {});
    };
  }, [id, applyInterest]);

  // Interest is per-connection and resets when the socket reconnects — re-apply.
  useEvent('_ws:reconnected', applyInterest);

  // Fetch metadata for the header title + to fill cwd/host if not in the URL.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchSession(id)
      .then((s) => { if (!cancelled) setSession(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    const t = session?.title || session?.description || session?.slug || id;
    if (t) document.title = `${t} — Walnut`;
  }, [session, id]);

  if (!id) {
    return (
      <div className="popout-stub">
        <h2>No session</h2>
        <code>(no session)</code>
      </div>
    );
  }

  const title = session?.title || session?.description || session?.slug || id;
  const resolvedCwd = session?.cwd ?? cwd;
  const resolvedHost = session?.host ?? host;

  return (
    <div className="popout-session">
      <div className="popout-session-header">
        <span className="popout-session-title" title={id}>{title}</span>
        {resolvedHost && <span className="popout-session-host">SSH: {resolvedHost}</span>}
      </div>
      <div className="popout-session-body">
        <SessionChatHistory
          key={id}
          sessionId={id}
          engine={session?.engine}
          sessionCwd={resolvedCwd}
          sessionHost={resolvedHost}
        />
      </div>
    </div>
  );
}
