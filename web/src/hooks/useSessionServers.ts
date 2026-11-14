/**
 * The servers a session started, polled while its panel is on screen.
 *
 * The host's daemon owns the scan (GET /api/sessions/:id/servers answers from one
 * pass over its listening sockets), so this only asks: every few seconds while the
 * Web view is open, more slowly while the panel just shows the header's count, and
 * never while the tab is hidden or its page is off show (the hidden Home page,
 * RouteShownContext false; the list it showed stays, and coming back asks at once).
 * A stop removes the row at once and asks again, so a server that ignored SIGTERM
 * comes back into the list rather than vanishing falsely.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { fetchSessionServers, lastSessionServers, stopSessionServer, type SessionServer, type SessionServersResult } from '@/api/session-servers';
import { log } from '@/utils/log';

export const SERVERS_POLL_FAST_MS = 4_000;
export const SERVERS_POLL_SLOW_MS = 20_000;
/** A stopped server a scan still lists comes back after this (it did not really stop). */
const GONE_HIDE_MS = 15_000;

export const serverKey = (s: Pick<SessionServer, 'pid' | 'port'>): string => `${s.pid}:${s.port}`;

export interface SessionServersState {
  servers: SessionServer[];
  state: SessionServersResult['state'] | 'loading';
  host: string;
  /** Keys of servers a Stop is in flight for. */
  stopping: ReadonlySet<string>;
  /** Why the last Stop of a server failed, by key. */
  stopErrors: ReadonlyMap<string, string>;
  /** True once the server is gone (stopped now, or already gone). */
  stop: (server: SessionServer) => Promise<boolean>;
  refresh: () => void;
}

const NO_SERVERS: SessionServer[] = [];

export function useSessionServers(sessionId: string | null | undefined, opts: { enabled: boolean; fast: boolean }): SessionServersState {
  // A view that mounts starts from the tab's last answer (the menu's count shows at once).
  const [result, setResult] = useState<SessionServersResult | null>(() => (sessionId ? lastSessionServers(sessionId) ?? null : null));
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const [stopErrors, setStopErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [tick, setTick] = useState(0);
  const lastJson = useRef('');
  const resultRef = useRef(result);
  resultRef.current = result;
  // Stopped servers, hidden until a scan no longer lists them (at most GONE_HIDE_MS).
  const gone = useRef<Map<string, number>>(new Map());
  // The route is absent on an older server: stop asking for this session.
  const missing = useRef(false);
  const shown = useContext(RouteShownContext) !== false;
  const enabled = opts.enabled && shown;

  useEffect(() => {
    setResult(sessionId ? lastSessionServers(sessionId) ?? null : null); setStopping(new Set()); setStopErrors(new Map());
    lastJson.current = ''; missing.current = false; gone.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !enabled || missing.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    // Each run owns one generation: a run superseded (tab shown again mid-request) neither
    // reports nor schedules, so exactly one poll chain lives.
    let generation = 0;
    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(run, opts.fast ? SERVERS_POLL_FAST_MS : SERVERS_POLL_SLOW_MS);
    };
    const run = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') { schedule(); return; }
      const mine = ++generation;
      const current = () => !cancelled && mine === generation;
      const controller = new AbortController();
      abort = controller;
      fetchSessionServers(sessionId, controller.signal)
        .then((res) => {
          if (!current()) return;
          const listed = new Set(res.servers.map(serverKey));
          const now = Date.now();
          for (const [k, until] of [...gone.current]) if (!listed.has(k) || now > until) gone.current.delete(k);
          // One pid:port is one process: it keeps the start first seen, so a scan whose only
          // news is an older `ageSec` (every scan) changes nothing and renders nothing.
          const before = new Map((resultRef.current?.servers ?? []).map((s) => [serverKey(s), s.startedAtMs]));
          const next = {
            ...res,
            servers: res.servers
              .filter((s) => !gone.current.has(serverKey(s)))
              .map((s) => {
                const kept = before.get(serverKey(s));
                return kept != null ? { ...s, startedAtMs: kept } : s;
              }),
          };
          const json = JSON.stringify({ ...next, servers: next.servers.map(({ ageSec: _age, ...rest }) => rest) });
          if (json !== lastJson.current) { lastJson.current = json; setResult(next); }
        })
        .catch((err: unknown) => {
          if (!current() || controller.signal.aborted) return;
          // A 404 naming the session is a record not written yet: ask again. Any other 404
          // is a server without the route: stop asking.
          if (err instanceof ApiError && err.status === 404 && (err.body as { code?: unknown } | undefined)?.code !== 'session_not_found') {
            missing.current = true;
            return;
          }
          log.warn('session-servers', 'list failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => { if (current() && !missing.current) schedule(); });
    };
    run();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer) clearTimeout(timer);
      generation++;
      abort?.abort();
      run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sessionId, enabled, opts.fast, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const stop = useCallback(async (server: SessionServer): Promise<boolean> => {
    if (!sessionId) return false;
    let ended = false;
    const key = serverKey(server);
    setStopping((s) => new Set(s).add(key));
    setStopErrors((m) => { const n = new Map(m); n.delete(key); return n; });
    try {
      const res = await stopSessionServer(sessionId, server);
      log.info('session-servers', 'server stopped', { sessionId, port: server.port, pid: server.pid, scope: res.scope, signal: res.signal });
      gone.current.set(key, Date.now() + GONE_HIDE_MS);
      setResult((r) => r && { ...r, servers: r.servers.filter((s) => serverKey(s) !== key) });
      ended = true;
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const message = err instanceof Error ? err.message : String(err);
      log.warn('session-servers', 'stop failed', { sessionId, port: server.port, pid: server.pid, status, error: message });
      const code = err instanceof ApiError ? (err.body as { code?: unknown } | undefined)?.code : undefined;
      if (status === 404 && code === 'not_found') {
        // Already gone: the next scan confirms it. (A 404 for the session itself is an error.)
        gone.current.set(key, Date.now() + GONE_HIDE_MS);
        setResult((r) => r && { ...r, servers: r.servers.filter((s) => serverKey(s) !== key) });
        ended = true;
      } else {
        setStopErrors((m) => new Map(m).set(key, message));
      }
    } finally {
      setStopping((s) => { const n = new Set(s); n.delete(key); return n; });
      lastJson.current = '';
      refresh();
    }
    return ended;
  }, [sessionId, refresh]);

  // One object per change, so a context or memo fed with it moves only when a scan does.
  return useMemo(() => ({
    servers: result?.servers ?? NO_SERVERS,
    state: result?.state ?? 'loading',
    host: result?.host ?? '__local__',
    stopping,
    stopErrors,
    stop,
    refresh,
  }), [result, stopping, stopErrors, stop, refresh]);
}
