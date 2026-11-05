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
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import { CLOUD_BOX_ALIAS, remoteHostTag } from '@/utils/host-display-label';
import { serverKey, type SessionServersState } from '@/hooks/useSessionServers';
import { SessionServerList, type SessionServerListProps } from './SessionServerList';
import { openable, serverLabel } from './session-server-label';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/session-servers.css';

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
  /** The servers this session started (useSessionServers), listed to open or stop. */
  servers?: SessionServersState;
}

type Phase = 'empty' | 'resolving' | 'loading' | 'ready' | 'blocked' | 'error';

/** `unreachable`: nothing answered there (not a page that answered and then stalled). */
interface ErrorState { message: string; hint?: string; title?: string; unreachable?: boolean }

function apiErrorHint(err: unknown): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const hint = (err.body as { hint?: unknown } | undefined)?.hint;
  return typeof hint === 'string' ? hint : undefined;
}

/** The port of a loopback URL (what a listed server opens), else null. */
export function activeLocalPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return null;
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch { return null; }
}

const WAITS_HINT = 'This page reloads by itself when this session starts a server on this port.';

/** What the page says when its listed server stopped (and while nothing listens there). */
function stoppedError(port: number): ErrorState {
  return { message: `The server on :${port} stopped.`, hint: WAITS_HINT, unreachable: true };
}

/** Two spellings of one address (a trailing slash, the case of the host). */
function sameAddress(a: string, b: string): boolean {
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}

/** `host:port` for the loading line and the host badge. */
function hostPort(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function SessionWebView({ sessionId, host, request, onNavigate, barRightSlot, servers }: SessionWebViewProps) {
  const [phase, setPhase] = useState<Phase>(request ? 'resolving' : 'empty');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const hostName = useHostDisplayLabels();
  const [info, setInfo] = useState<ServicePreviewInfo | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);
  const [address, setAddress] = useState(request?.url ?? '');
  const [addressError, setAddressError] = useState(false);
  // Retry re-resolves (a dead tunnel is re-dialed server-side); Reload does
  // the same (a stopped server must not come back as a cached page).
  const [attempt, setAttempt] = useState(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const stripWrapRef = useRef<HTMLDivElement>(null);
  const userStoppedRef = useRef<number | null>(null);
  // The port whose listed server stopped under the page shown: a Retry or Reload that
  // still finds nothing says that again, not a generic "can't open".
  const goneRef = useRef<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 8_000);
    return () => clearTimeout(t);
  }, [notice]);
  const [showAll, setShowAll] = useState(false);
  // The list over the page was opened for a server that is not a web page: it points at those rows.
  const [pointOthers, setPointOthers] = useState(false);
  useEffect(() => { if (!showAll) setPointOthers(false); }, [showAll]);

  const requestedUrl = request?.url ?? '';
  const requestedUrlRef = useRef(requestedUrl);
  requestedUrlRef.current = requestedUrl;
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const nonce = request?.nonce ?? 0;

  useEffect(() => { setAddress(requestedUrl); setAddressError(false); }, [requestedUrl, nonce]);

  useEffect(() => {
    if (!requestedUrl) {
      setPhase('empty');
      setInfo(null);
      // Nothing to pick from: the address is the way in. A list of servers is (no ring over it).
      if (!serversRef.current?.servers.length) requestAnimationFrame(() => addressRef.current?.focus());
      return;
    }
    let cancelled = false;
    // A newer click supersedes this one: abort it so it frees its fetch slot
    // instead of holding it for the server's 30s deadline.
    const abort = new AbortController();
    setPhase('resolving');
    setError(null);
    // The same page asked again (Retry, Reload) keeps its host badge while it asks.
    setInfo((prev) => (prev && sameAddress(prev.requestedUrl, requestedUrl) ? prev : null));
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
        const port = activeLocalPort(requestedUrl);
        setError(port !== null && goneRef.current === port ? stoppedError(port) : { message, hint: apiErrorHint(err), unreachable: true });
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
  }, [phase, info]);

  const handleLoaded = useCallback(() => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    setPhase((p) => (p === 'loading' ? 'ready' : p));
    // A page that loaded is a server that answers: a list that does not show it yet asks again.
    const port = activeLocalPort(requestedUrlRef.current);
    if (port !== null && serversRef.current && !serversRef.current.servers.some((s) => s.port === port)) serversRef.current.refresh();
  }, []);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    // An emptied address goes back to the server list, not to the last page's answer.
    if (!address.trim()) { setAddressError(false); setNotice(null); if (requestedUrl) onNavigate(''); return; }
    const next = normalizeServiceInput(address);
    if (!next) { setAddressError(true); return; }
    setAddressError(false);
    setNotice(null);
    onNavigate(next);
  }, [address, onNavigate, requestedUrl]);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);
  // Reload asks again whether anything still answers (as Retry does), so a server that
  // stopped cannot come back as the browser's cached copy of its page.
  const handleReload = useCallback(() => setAttempt((n) => n + 1), []);

  const listed = servers?.servers ?? [];
  const serversHost = servers && servers.host !== '__local__' ? hostName(servers.host) : '';
  const activePort = activeLocalPort(requestedUrl);
  // The listed server this page shows stopped (here or on its own): say so instead of
  // leaving its last frame up as if it still answered. When a server comes back on the
  // port a failed page shows (restarted, or typed before it was up), the page reloads.
  // The page shown belongs to a server a Stop is in flight for: dim it, say so.
  const stoppingShown = !!servers && activePort !== null && listed.some((s) => s.port === activePort && servers.stopping.has(serverKey(s)));
  const listedPorts = servers?.state === 'ok' ? listed.map((s) => s.port).join(',') : null;
  const prevPortsRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevPortsRef.current;
    prevPortsRef.current = listedPorts;
    if (listedPorts === null || prev === null || activePort === null) return;
    const had = prev.split(',').includes(String(activePort));
    const has = listedPorts.split(',').includes(String(activePort));
    if (!had && has) {
      goneRef.current = null;
      if (phaseRef.current === 'error') setAttempt((n) => n + 1);
      return;
    }
    if (!had || has) return;
    if (userStoppedRef.current === activePort) return;
    goneRef.current = activePort;
    setPhase((p) => {
      if (p !== 'ready' && p !== 'loading') return p;
      setError(stoppedError(activePort));
      return 'error';
    });
  }, [listedPorts, activePort]);

  // The list over the page is one overlay layer: Escape and a press outside close it (a
  // Stop popover opened from it is its own layer above it).
  useOverlayLayer({
    open: showAll,
    refs: [stripWrapRef],
    exemptSelectors: ['.session-server-popover'],
    trapFocus: false,
    onClose: () => setShowAll(false),
  });
  useEffect(() => { if (phase === 'empty' || listed.length === 0) setShowAll(false); }, [phase, listed.length]);
  // A click into the page below goes to its frame, which this document never sees: the
  // window losing focus is the sign (a Stop popover open from the list closes with it).
  useEffect(() => {
    if (!showAll) return;
    const onBlur = () => setShowAll(false);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, [showAll]);

  // The page failed on a port of this machine that none of this session's servers holds now:
  // it reloads by itself when one listens there (the effect above), so the hint says that.
  const waitsForServer = phase === 'error' && !!error?.unreachable && activePort !== null && servers?.state === 'ok'
    && !listed.some((s) => s.port === activePort);
  // A port this session holds with something that is not a web page: say so, and where to stop it.
  const notWeb = phase === 'error' && activePort !== null ? listed.find((s) => s.port === activePort && !openable(s)) : undefined;
  const remote = !!info && info.via === 'tunnel';
  const tunnelHost = remote ? hostName(info!.host) : '';
  // Before an answer (or after none came: a stopped server), the session's host says where it is.
  const sessionRemote = !!host && host !== '__local__';
  const hostBadge = info
    ? (remote ? remoteHostTag(info.host, tunnelHost) : 'Local')
    : requestedUrl && activeLocalPort(requestedUrl) !== null ? (sessionRemote ? remoteHostTag(host!, hostName(host!)) : 'Local') : '';
  // "Open in tab" uses the address this machine can actually reach.
  const tabUrl = info?.url ?? requestedUrl;
  const busy = phase === 'resolving' || phase === 'loading';
  const serverList = (variant: 'strip' | 'list', extra?: Partial<SessionServerListProps>) => servers && listed.length > 0 && (
    <SessionServerList
      variant={variant}
      servers={listed}
      activePort={activePort}
      stopping={servers.stopping}
      stopErrors={servers.stopErrors}
      hostLabel={serversHost}
      onOpen={(s) => { setShowAll(false); setNotice(null); onNavigate(s.url); }}
      onStop={(s) => {
        // Stopping the page shown is the person's own act: back to the list, with a word,
        // not the "stopped" screen kept for a server that ended on its own.
        const shown = s.port === activePort;
        if (shown) userStoppedRef.current = s.port;
        void servers.stop(s).then((ok) => {
          if (shown) userStoppedRef.current = null;
          if (!ok) return;
          // Every stop says so (the newest one), over the page or the list.
          setNotice(`Stopped :${s.port}${s.title ? ` (${s.title})` : ''}.`);
          if (shown) {
            setShowAll(false);
            onNavigate('');
          }
        });
      }}
      {...extra}
    />
  );

  return (
    <div className="session-code-panel session-web-panel">
      <div className="session-code-header session-web-header">
        <form className="session-web-address-form" onSubmit={handleSubmit}>
          <span className="session-code-label">Web</span>
          <input data-no-draft="search"
            ref={addressRef}
            className={`session-web-address${addressError ? ' session-web-address-invalid' : ''}`}
            value={address}
            onChange={(e) => { setAddress(e.target.value); setAddressError(false); }}
            onKeyDown={(e) => {
              // Escape here undoes the typing (a browser's address bar does the same); the
              // panel's own Escape (leave full screen) is for a key nobody took.
              if (e.key !== 'Escape') return;
              e.preventDefault();
              setAddress(requestedUrl);
              setAddressError(false);
              e.currentTarget.blur();
            }}
            placeholder="localhost:3000 or http://host:8080/"
            spellCheck={false}
            autoComplete="off"
            aria-label="Service address"
            aria-invalid={addressError || undefined}
          />
          {hostBadge && (
            <span className="session-code-host" title={remote ? `Tunnelled to ${tunnelHost}:${info!.remotePort}${info!.host === CLOUD_BOX_ALIAS ? '' : ' over SSH'}` : undefined}>
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
      {phase !== 'empty' && listed.length > 0 && (
        <div className="session-servers-strip-wrap" ref={stripWrapRef}>
          {serverList('strip', {
            onShowAll: () => setShowAll((v) => !v),
            showingAll: showAll,
          })}
          {showAll && (
            <div className="session-servers-overlay" data-testid="session-servers-overlay">
              {serverList('list', { onClose: () => setShowAll(false), pointAtOthers: pointOthers })}
            </div>
          )}
        </div>
      )}
      {/* A page of this machine open before the first scan answers (a reload): the strip's place
          is kept, so it does not vanish and push the page when it comes. */}
      {phase !== 'empty' && listed.length === 0 && servers?.state === 'loading' && activeLocalPort(requestedUrl) !== null && (
        <div className="session-servers-strip-wrap">
          <div className="session-servers-strip session-servers-strip-pending" aria-busy="true" data-testid="session-servers-strip-pending">
            <span className="session-servers-strip-label">Looking for this session's servers…</span>
          </div>
        </div>
      )}

      <div className="session-web-stage">
      {notice && (
        <div className="session-servers-notice" role="status" data-testid="session-servers-notice">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{notice}</span>
        </div>
      )}
      {phase === 'error' && error ? (
        <div className="session-code-error-card">
          <div className="session-code-error-title" data-testid="session-web-error-title">{error.title ?? `Can't open ${hostPort(requestedUrl)}`}</div>
          {notWeb ? (
            <>
              <p className="session-code-error-body" data-testid="session-web-not-web">:{notWeb.port} ({notWeb.title || serverLabel(notWeb)}) is running, but it does not serve a web page.</p>
              <p className="session-code-error-hint">See it, or stop it, in this session's server list.</p>
              <button type="button" className="session-code-btn" onClick={() => { setShowAll(true); setPointOthers(true); }}>Show in Servers</button>
            </>
          ) : (
            <>
              <p className="session-code-error-body">{waitsForServer && !goneRef.current ? `Nothing this session started is listening on :${activePort}.` : error.message}</p>
              {(waitsForServer ? WAITS_HINT : error.hint) && <p className="session-code-error-hint">{waitsForServer ? WAITS_HINT : error.hint}</p>}
              <button type="button" className="session-code-btn" onClick={handleRetry}>Retry</button>
            </>
          )}
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
      ) : phase === 'empty' && listed.length > 0 ? (
        <div className="session-web-empty session-web-empty-servers">
          {serverList('list')}
          <p className="session-code-error-hint">
            Or type an address above, or click a localhost or host:port link in the chat. A port on a remote host opens through an SSH tunnel.
          </p>
        </div>
      ) : phase === 'empty' ? (
        <div className="session-code-error-card session-web-empty">
          {servers?.state === 'ok' ? (
            <>
              <div className="session-code-error-title" data-testid="session-servers-none">No servers started by this session are running</div>
              <p className="session-code-error-body">Any server this session starts shows up here, to open or stop.</p>
              <p className="session-code-error-hint">
                Or click a localhost or host:port link in the chat, or type an address above. A port on a remote host opens through an SSH tunnel.
              </p>
            </>
          ) : (
            <>
              <div className="session-code-error-title">Open a service this session started</div>
              <p className="session-code-error-body">
                Click a localhost or host:port link in the chat, or type an address above. A port on a remote host opens through an SSH tunnel.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className={`session-code-body${stoppingShown ? ' session-web-body-stopping' : ''}`}>
          {busy && (
            <div className="session-code-loading session-web-loading">
              <div className="session-code-spinner" />
              <span>
                {phase === 'resolving'
                  ? `Connecting to ${hostPort(requestedUrl)}${host && host !== '__local__' ? ` through ${hostName(host)}` : ''}…`
                  : `Loading ${hostPort(requestedUrl)}…`}
              </span>
            </div>
          )}
          {info && info.embeddable && phase !== 'resolving' && (
            <iframe
              key={`${info.url}-${attempt}`}
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
    </div>
  );
}
