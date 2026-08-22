/**
 * PluginAppPage — a plugin's own HTML surface, embedded full-bleed.
 *
 * The page itself is static HTML the server serves under `/plugin-apps/…`. It
 * runs in a sandbox WITHOUT `allow-same-origin`, so it has no access to
 * localStorage, the device token, or any Walnut cookie: everything it can do
 * arrives over postMessage (see pluginAppBridge.ts and the SDK at
 * `web/public/walnut-app-sdk.js`).
 *
 * Mount/unmount per navigation is deliberate for v1 — a plugin page boots in
 * milliseconds, unlike code-server, so there is no keep-alive machinery here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApps } from '@/hooks/useApps';
import { useTheme } from '@/hooks/useTheme';
import { wsClient } from '@/api/ws';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from '@/api/client';
import { createPluginAppBridge, type ApiMethod, type PluginAppBridge } from './pluginAppBridge';
import { log } from '@/utils/log';

/** The iframe must fire onload within this, or the user gets a Retry card. */
const LOAD_TIMEOUT_MS = 20_000;

function callApi(method: ApiMethod, path: string, body?: unknown): Promise<unknown> {
  switch (method) {
    case 'GET': return apiGet<unknown>(path);
    case 'POST': return apiPost<unknown>(path, body);
    case 'PUT': return apiPut<unknown>(path, body);
    case 'PATCH': return apiPatch<unknown>(path, body);
    case 'DELETE': return apiDelete<unknown>(path);
  }
}

export function PluginAppPage() {
  const { appId } = useParams<{ appId: string }>();
  const { apps, loading } = useApps();
  const { resolvedTheme } = useTheme();
  const navigate = useNavigate();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  // Bump to remount the iframe (Retry).
  const [attempt, setAttempt] = useState(0);
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const app = useMemo(() => apps.find((a) => a.id === appId), [apps, appId]);

  useEffect(() => {
    document.title = app ? `${app.title} — Walnut` : 'App — Walnut';
  }, [app]);

  // Load watchdog — armed per (app, attempt), cleared by onLoad.
  useEffect(() => {
    if (!app) return;
    setPhase('loading');
    loadTimerRef.current = setTimeout(() => {
      setPhase((p) => (p === 'loading' ? 'error' : p));
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    };
  }, [app, attempt]);

  // Theme lives in a ref so a light/dark flip never rebuilds the bridge below:
  // a rebuild drops the app's registered event prefixes, and the already-loaded
  // page never re-handshakes, so its live feed would die silently.
  const themeRef = useRef(resolvedTheme);
  themeRef.current = resolvedTheme;
  const bridgeRef = useRef<PluginAppBridge | null>(null);

  // postMessage bridge. Lives for as long as this app is mounted; a Retry keeps
  // the same bridge (the frame identity is read live via getFrameWindow).
  useEffect(() => {
    if (!app) return;
    const bridge = createPluginAppBridge({
      appId: app.id,
      pluginId: app.pluginId,
      getTheme: () => themeRef.current,
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      apiCall: callApi,
      subscribeAll: (cb) => wsClient.subscribeAll(cb),
      navigate: (path) => navigate(path),
      logWarn: (message, data) => log.warn('plugin-app', message, data),
    });
    bridgeRef.current = bridge;
    const onMessage = (event: MessageEvent) => bridge.handleMessage(event);
    window.addEventListener('message', onMessage);
    log.info('plugin-app', 'bridge attached', { appId: app.id, pluginId: app.pluginId });
    return () => {
      window.removeEventListener('message', onMessage);
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [app, navigate]);

  // Push theme changes to an app that already handshook (skips the first run:
  // the initial value rides `walnut:init`).
  const themePushed = useRef(resolvedTheme);
  useEffect(() => {
    if (themePushed.current === resolvedTheme) return;
    themePushed.current = resolvedTheme;
    bridgeRef.current?.sendTheme(resolvedTheme);
  }, [resolvedTheme]);

  const handleLoad = useCallback(() => {
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current);
    setPhase((p) => (p === 'loading' ? 'ready' : p));
  }, []);

  const handleRetry = useCallback(() => setAttempt((n) => n + 1), []);

  // Still fetching the catalogue — an unknown id here would be a lie.
  if (!app && loading) {
    return (
      <div className="plugin-app-page" data-testid="plugin-app-page">
        <div className="plugin-app-loading">
          <div className="plugin-app-spinner" />
          <span>Loading apps…</span>
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="plugin-app-page" data-testid="plugin-app-page">
        <div className="plugin-app-message-card" data-testid="plugin-app-not-found">
          <div className="plugin-app-message-title">App not found</div>
          <p className="plugin-app-message-body">
            No installed plugin provides an app called <code>{appId}</code>. It may have been
            removed, or its plugin may be disabled.
          </p>
          <Link className="plugin-app-btn" to="/">Back to Walnut</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-app-page" data-testid="plugin-app-page">
      {phase === 'error' ? (
        <div className="plugin-app-message-card" data-testid="plugin-app-load-error">
          <div className="plugin-app-message-title">{app.title} didn't finish loading</div>
          <p className="plugin-app-message-body">
            The page took more than {Math.round(LOAD_TIMEOUT_MS / 1000)} seconds to load. Retry
            reloads it from the plugin.
          </p>
          <button className="plugin-app-btn" onClick={handleRetry}>Retry</button>
        </div>
      ) : (
        <>
          {phase === 'loading' && (
            <div className="plugin-app-loading">
              <div className="plugin-app-spinner" />
              <span>Loading {app.title}…</span>
            </div>
          )}
          <iframe
            key={`${app.id}-${attempt}`}
            ref={frameRef}
            className="plugin-app-iframe"
            data-testid="plugin-app-iframe"
            src={app.url}
            title={app.title}
            // NO allow-same-origin: that is the security boundary. The page gets
            // an opaque origin, so it cannot read Walnut's localStorage (device
            // token) or call our APIs directly — only the postMessage bridge.
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            allow="clipboard-read; clipboard-write"
            onLoad={handleLoad}
            style={phase === 'loading' ? { visibility: 'hidden' } : undefined}
          />
        </>
      )}
    </div>
  );
}
