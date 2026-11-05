import { apiGet, apiPost } from './client';

/** One server a session started. Mirrors SessionServer in src/core/session-servers.ts. */
export interface SessionServer {
  port: number;
  /** Every address it listens on (`127.0.0.1`, `::`, `*`, ...). */
  addresses: string[];
  /** Reachable only on its own host. */
  loopbackOnly: boolean;
  pid: number;
  pgid: number;
  /** Short process name (`node`, `python3`). */
  name: string;
  /** Command line, truncated by the host. */
  command: string;
  ageSec: number | null;
  /** When its process started on this tab's clock (`ageSec` read when the list arrived); set by fetchSessionServers. */
  startedAtMs?: number | null;
  /** `terminal`: started in the session's terminal; otherwise by its agent. */
  via: 'env' | 'terminal' | 'tree';
  /** What answered on the port: a web page (http/https), something else, or no answer in time. */
  kind: 'http' | 'https' | 'other' | 'unknown';
  /** The page's `<title>`, when `/` is a web page that has one. */
  title?: string;
  /** `none`: it shares the agent's process group, so Walnut will not stop it. */
  stopScope: 'group' | 'process' | 'none';
  /** What the Web view opens (`http://localhost:<port>/` on the session's host). */
  url: string;
}

export interface SessionServersResult {
  state: 'ok' | 'unsupported' | 'offline' | 'error';
  /** The session's host alias, `__local__` for this machine. */
  host: string;
  servers: SessionServer[];
  error?: string;
}

/** A list answer this fresh serves every caller (the panel, the menu's count, the Open row). */
const SHARE_MS = 1_500;
const shared = new Map<string, { at: number | null; result: Promise<SessionServersResult> }>();
/** The last answer per session, so a view that mounts (the menu's count) starts from it. */
const lastKnown = new Map<string, SessionServersResult>();

/** Each server's start on this tab's clock, so a later render never reads an `ageSec` gone stale. */
function stampStarts(res: SessionServersResult): SessionServersResult {
  const at = Date.now();
  return {
    ...res,
    servers: (res.servers ?? []).map((s) => ({
      ...s,
      startedAtMs: typeof s.ageSec === 'number' && Number.isFinite(s.ageSec) ? at - s.ageSec * 1000 : null,
    })),
  };
}

/** The last list this tab received for a session, if any. */
export function lastSessionServers(sessionId: string): SessionServersResult | undefined {
  return lastKnown.get(sessionId);
}

/**
 * One session's servers. Callers asking within SHARE_MS of each other share one request;
 * a caller's `signal` ends only its own wait, never the shared request.
 */
export function fetchSessionServers(sessionId: string, signal?: AbortSignal): Promise<SessionServersResult> {
  let entry = shared.get(sessionId);
  if (!entry || (entry.at !== null && Date.now() - entry.at >= SHARE_MS)) {
    const made: { at: number | null; result: Promise<SessionServersResult> } = {
      at: null,
      result: apiGet<SessionServersResult>(`/api/sessions/${sessionId}/servers`, undefined, {
        timeoutMs: 20_000, priority: 'low', quietStatuses: [404],
      }).then(stampStarts),
    };
    made.result.then((res) => { made.at = Date.now(); lastKnown.set(sessionId, res); }, () => { if (shared.get(sessionId) === made) shared.delete(sessionId); });
    shared.set(sessionId, made);
    entry = made;
  }
  if (!signal) return entry.result;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    entry!.result.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Forget a shared answer (a Stop changed what is listening). */
export function forgetSessionServers(sessionId: string): void {
  shared.delete(sessionId);
}

/** Stop one listed server (its process group, or the listener alone). 404 = gone already, 409 = not Walnut's to stop. */
export function stopSessionServer(sessionId: string, server: Pick<SessionServer, 'pid' | 'port'>): Promise<{ stopped: true; scope: 'group' | 'process'; signal: string }> {
  forgetSessionServers(sessionId);
  return apiPost<{ stopped: true; scope: 'group' | 'process'; signal: string }>(`/api/sessions/${sessionId}/servers/stop`, { pid: server.pid, port: server.port }, {
    timeoutMs: 30_000, quietStatuses: [403, 404, 409, 502, 503],
  }).finally(() => forgetSessionServers(sessionId));
}
