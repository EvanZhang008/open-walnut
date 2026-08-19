/**
 * SessionCodeView — embedded VS Code (code-server) for a session, filling the
 * left column of the session full-screen split (matching Changed / Files /
 * Terminal).
 *
 * The iframe points at a 127.0.0.1 URL the server resolved: a local
 * code-server for local sessions, or the local end of an SSH tunnel to the
 * session host's code-server (daemon-owned) for remote ones. First use on a
 * host can install code-server (~100MB), so the ensure call runs with a long
 * timeout and the loading state names what it's doing.
 *
 * Lessons borrowed from other code-server embeddings:
 * - clipboard-read/write must be granted on the iframe or VS Code's own
 *   copy/paste silently fails.
 * - a load timeout turns "spinner forever" into an error card with Retry.
 * - the iframe never unmounts while the panel is open (VS Code boot is
 *   expensive); only an explicit Retry replaces the URL.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ensureSessionVscodeEmbed, type VscodeEmbedInfo } from '@/api/sessions';
import { ApiError } from '@/api/client';
import { log } from '@/utils/log';

/** iframe must emit onload within this after the URL is set. */
const LOAD_TIMEOUT_MS = 20_000;

interface SessionCodeViewProps {
  sessionId: string;
  host?: string;
  /** Chat segment of the full-width bar (the panel's chat toggle) — see
   *  SessionFileExplorer.barRightSlot. */
  barRightSlot?: ReactNode;
}

type Phase = 'ensuring' | 'loading' | 'ready' | 'error';

export function SessionCodeView({ sessionId, host, barRightSlot }: SessionCodeViewProps) {
  const [phase, setPhase] = useState<Phase>('ensuring');
  const [info, setInfo] = useState<VscodeEmbedInfo | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bump to force a fresh ensure→iframe cycle (Retry).
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPhase('ensuring');
    setError(null);
    ensureSessionVscodeEmbed(sessionId)
      .then((res) => {
        if (cancelled) return;
        setInfo(res);
        setPhase('loading');
        loadTimerRef.current = setTimeout(() => {
          setPhase((p) => {
            if (p !== 'loading') return p;
            setError({ message: 'VS Code did not finish loading', hint: 'The tunnel or code-server may have stalled — Retry re-resolves both.' });
            return 'error';
          });
        }, LOAD_TIMEOUT_MS);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const hint = err instanceof ApiError && typeof (err.body as { hint?: string } | undefined)?.hint === 'string'
          ? (err.body as { hint: string }).hint
          : undefined;
        const message = err instanceof Error ? err.message : String(err);
        log.error('session-code', 'vscode embed ensure failed', { sessionId, error: message });
        setError({ message, hint });
        setPhase('error');
      });
    return () => {
      cancelled = true;
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    };
  }, [sessionId, attempt]);

  const handleLoaded = useCallback(() => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    setPhase((p) => (p === 'loading' ? 'ready' : p));
  }, []);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);

  const openLabel = info ? info.open.path.split('/').pop() || info.open.path : '';

  return (
    <div className="session-code-panel">
      <div className="session-code-header">
        <div className="session-code-title">
          <span className="session-code-label">VS Code</span>
          {openLabel && <span className="session-code-target" title={info?.open.path}>{openLabel}</span>}
          {host && host !== '__local__' && <span className="session-code-host">SSH: {host}</span>}
        </div>
        <div className="session-code-actions">
          {info && phase === 'ready' && (
            <a className="session-code-btn" href={info.url} target="_blank" rel="noreferrer" title="Open this editor in its own browser tab">
              Open in tab
            </a>
          )}
          {barRightSlot}
        </div>
      </div>

      {phase === 'error' && error ? (
        <div className="session-code-error-card">
          <div className="session-code-error-title">Can't open embedded VS Code</div>
          <p className="session-code-error-body">{error.message}</p>
          {error.hint && <p className="session-code-error-hint">{error.hint}</p>}
          <button className="session-code-btn" onClick={handleRetry}>Retry</button>
        </div>
      ) : (
        <div className="session-code-body">
          {phase === 'ensuring' && (
            <div className="session-code-loading">
              <div className="session-code-spinner" />
              <span>
                Starting code-server{host && host !== '__local__' ? ` on ${host}` : ''}…
                first use downloads it (~100MB), which can take a minute
              </span>
            </div>
          )}
          {info && (
            <iframe
              // token in the key: a restarted code-server (new token) must
              // remount the iframe — same URL + dead service worker otherwise
              // wedges the old document.
              key={`${info.token}-${attempt}`}
              className="session-code-iframe"
              src={info.url}
              title="Embedded VS Code"
              allow="clipboard-read; clipboard-write"
              onLoad={handleLoaded}
              style={phase === 'ensuring' ? { visibility: 'hidden' } : undefined}
            />
          )}
        </div>
      )}
    </div>
  );
}
