/**
 * SessionWebView — a service the session started (a dev server, a report page)
 * shown in the left column of the session split, next to the chat.
 *
 * The server resolves the URL the session printed into one this browser can
 * load: the URL itself when the service runs on this machine, or the 127.0.0.1
 * end of an SSH forward to the session's host (the same transport the embedded
 * VS Code uses). Page traffic goes straight through ssh, so the service's
 * WebSockets and absolute asset paths work unmodified.
 *
 * The address bar always shows the URL as the session wrote it, never the
 * tunnel's random local port: that is the address the user recognises.
 *
 * States: empty (no URL yet: type one) → resolving (tunnel + reachability
 * probe) → loading (iframe booting, bounded) → ready; or a card for
 * unreachable / refuses-to-be-framed / timeout, each with Retry and a way out
 * to a real browser tab.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { resolveSessionServicePreview, type ServicePreviewInfo } from '@/api/sessions';
import { ApiError } from '@/api/client';
import { normalizeServiceInput } from '@/utils/service-link';
import { log } from '@/utils/log';

/** The iframe must fire `load` within this after its src is set. */
const LOAD_TIMEOUT_MS = 20_000;

/** What to open: a URL, plus a nonce so clicking the same link again reloads it. */
export interface WebViewRequest {
  url: string;
  nonce: number;
}

interface SessionWebViewProps {
  sessionId: string;
  /** Session host alias (`__local__`/empty = this machine), for the loading line. */
  host?: string;
  request: WebViewRequest | null;
  /** The address bar asks the panel to open another URL (keeps panel state the one truth). */
  onNavigate: (url: string) => void;
  /** Chat segment of the full-width bar — see SessionFileExplorer.barRightSlot. */
  barRightSlot?: ReactNode;
}

type Phase = 'empty' | 'resolving' | 'loading' | 'ready' | 'blocked' | 'error';

interface ErrorState { message: string; hint?: string }

function apiErrorHint(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const hint = (err.body as { hint?: unknown } | undefined)?.hint;
  return typeof hint === 'string' ? hint : undefined;
}

/** `host:port` for the loading line and the host badge. */
function hostPort(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function SessionWebView({ sessionId, host, request, onNavigate, barRightSlot }: SessionWebViewProps) {
  const [phase, setPhase] = useState<Phase>(request ? 'resolving' : 'empty');
  const [info, setInfo] = useState<ServicePreviewInfo | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [address, setAddress] = useState(request?.url ?? '');
  const [addressError, setAddressError] = useState(false);
  // Retry re-resolves (a dead tunnel is re-dialed server-side); Reload only
  // remounts the iframe on the URL already resolved.
  const [attempt, setAttempt] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);

  const requestedUrl = request?.url ?? '';
  const nonce = request?.nonce ?? 0;

  useEffect(() => { setAddress(requestedUrl); setAddressError(false); }, [requestedUrl, nonce]);

  useEffect(() => {
    if (!requestedUrl) {
      setPhase('empty');
      setInfo(null);
      requestAnimationFrame(() => addressRef.current?.focus());
      return;
    }
    let cancelled = false;
    // A newer click supersedes this one: abort it so it frees its fetch slot
    // instead of holding it for the server's 30s deadline.
    const abort = new AbortController();
    setPhase('resolving');
    setError(null);
    setInfo(null);
    const startedAt = performance.now();
    resolveSessionServicePreview(sessionId, requestedUrl, abort.signal)
      .then((res) => {
        if (cancelled) return;
        log.info('session-web', 'service preview resolved', {
          sessionId, url: requestedUrl, via: res.via, host: res.host, localPort: res.localPort,
          embeddable: res.embeddable, reachability: res.reachability, ms: Math.round(performance.now() - startedAt),
        });
        setInfo(res);
        if (!res.embeddable) { setPhase('blocked'); return; }
        setPhase('loading');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        log.warn('session-web', 'service preview failed', { sessionId, url: requestedUrl, error: message });
        setError({ message, hint: apiErrorHint(err) });
        setPhase('error');
      });
    return () => { cancelled = true; abort.abort(); };
  }, [sessionId, requestedUrl, nonce, attempt]);

  // Bounded iframe boot: a stalled tunnel turns into a card, not a blank pane.
  useEffect(() => {
    if (phase !== 'loading') return;
    loadTimerRef.current = setTimeout(() => {
      setPhase((p) => {
        if (p !== 'loading') return p;
        setError({ message: 'The page did not finish loading', hint: 'The service or the tunnel may have stalled. Retry reconnects both.' });
        return 'error';
      });
    }, LOAD_TIMEOUT_MS);
    return () => { if (loadTimerRef.current) clearTimeout(loadTimerRef.current); };
  }, [phase, reloadKey, info]);

  const handleLoaded = useCallback(() => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    setPhase((p) => (p === 'loading' ? 'ready' : p));
  }, []);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    const next = normalizeServiceInput(address);
    if (!next) { setAddressError(true); return; }
    setAddressError(false);
    onNavigate(next);
  }, [address, onNavigate]);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);
  const handleReload = useCallback(() => {
    if (!info) { setAttempt((n) => n + 1); return; }
    setPhase(info.embeddable ? 'loading' : 'blocked');
    setReloadKey((n) => n + 1);
  }, [info]);

  const remote = !!info && info.via === 'tunnel';
  const hostBadge = info ? (remote ? `SSH: ${info.host}` : 'Local') : '';
  // "Open in tab" uses the address this machine can actually reach.
  const tabUrl = info?.url ?? requestedUrl;
  const busy = phase === 'resolving' || phase === 'loading';

  return (
    <div className="session-code-panel session-web-panel">
      <div className="session-code-header session-web-header">
        <form className="session-web-address-form" onSubmit={handleSubmit}>
          <span className="session-code-label">Web</span>
          <input
            ref={addressRef}
            className={`session-web-address${addressError ? ' session-web-address-invalid' : ''}`}
            value={address}
            onChange={(e) => { setAddress(e.target.value); setAddressError(false); }}
            placeholder="localhost:3000 or http://host:8080/"
            spellCheck={false}
            autoComplete="off"
            aria-label="Service address"
            aria-invalid={addressError || undefined}
          />
          {hostBadge && (
            <span className="session-code-host" title={remote ? `Tunnelled to ${info!.host}:${info!.remotePort} over SSH` : undefined}>
              {hostBadge}
            </span>
          )}
        </form>
        <div className="session-code-actions">
          {requestedUrl && (
            <button type="button" className="session-code-btn" onClick={handleReload} disabled={phase === 'resolving'} title="Reload the page">
              Reload
            </button>
          )}
          {tabUrl && (
            <a className="session-code-btn" href={tabUrl} target="_blank" rel="noreferrer" data-native-link
               title="Open this page in its own browser tab">
              Open in tab
            </a>
          )}
          {barRightSlot}
        </div>
      </div>

      {phase === 'error' && error ? (
        <div className="session-code-error-card">
          <div className="session-code-error-title">Can't open {hostPort(requestedUrl)}</div>
          <p className="session-code-error-body">{error.message}</p>
          {error.hint && <p className="session-code-error-hint">{error.hint}</p>}
          <button type="button" className="session-code-btn" onClick={handleRetry}>Retry</button>
        </div>
      ) : phase === 'blocked' && info ? (
        <div className="session-code-error-card">
          {info.embedBlockedBy === 'certificate' ? (
            <>
              <div className="session-code-error-title">This page's certificate is not trusted here</div>
              <p className="session-code-error-body">
                {hostPort(requestedUrl)} is served over https with a certificate the browser will not accept inside a frame. Open it in a tab to review the warning.
              </p>
            </>
          ) : (
            <>
              <div className="session-code-error-title">This page does not allow being shown inside another page</div>
              <p className="session-code-error-body">
                {hostPort(requestedUrl)} sends {info.embedBlockedBy === 'frame-ancestors' ? 'a frame-ancestors policy' : 'X-Frame-Options'}, so it can only open in its own tab.
              </p>
            </>
          )}
          <a className="session-code-btn" href={info.url} target="_blank" rel="noreferrer" data-native-link>Open in tab</a>
        </div>
      ) : phase === 'empty' ? (
        <div className="session-code-error-card session-web-empty">
          <div className="session-code-error-title">Open a service this session started</div>
          <p className="session-code-error-body">
            Click a localhost or host:port link in the chat, or type an address above. A port on a remote host opens through an SSH tunnel.
          </p>
        </div>
      ) : (
        <div className="session-code-body">
          {busy && (
            <div className="session-code-loading session-web-loading">
              <div className="session-code-spinner" />
              <span>
                {phase === 'resolving'
                  ? `Connecting to ${hostPort(requestedUrl)}${host && host !== '__local__' ? ` through ${host}` : ''}…`
                  : `Loading ${hostPort(requestedUrl)}…`}
              </span>
            </div>
          )}
          {info && info.embeddable && (
            <iframe
              key={`${info.url}-${reloadKey}-${attempt}`}
              className="session-web-iframe"
              src={info.url}
              title={`Service ${requestedUrl}`}
              onLoad={handleLoaded}
              // The page may not navigate the console away (no top navigation);
              // everything a dev server needs (scripts, its own storage, forms,
              // popups, downloads) stays allowed.
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          )}
        </div>
      )}
    </div>
  );
}
