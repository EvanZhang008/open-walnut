/**
 * Thin HTTP client for the local server's `/api/v1` facade — the CLI's ONLY
 * data path.
 *
 * WHY: the CLI used to import core/task-manager and write SQLite from its own
 * process, which made it a SECOND WRITER alongside the running server (proven
 * mutual-deletion hazard: two processes each holding a stale in-memory store
 * delete each other's rows). Now every command talks HTTP to the server, which
 * is the single writer. Localhost requests bypass auth (web/middleware/auth.ts),
 * so no token plumbing is needed.
 *
 * Rollback lever: `WALNUT_CLI_DIRECT=1` makes each converted command run its
 * original in-process code path (`runXxxDirect`).
 */

/** Server the CLI talks to. Override with OPEN_WALNUT_API_URL (tests, alt port). */
const DEFAULT_BASE_URL = 'http://127.0.0.1:3456';

/** A CLI command must never hang on a wedged server — fail fast and say why. */
const REQUEST_TIMEOUT_MS = 10_000;

export function apiBaseUrl(): string {
  const raw = process.env.OPEN_WALNUT_API_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** The server answered, but with an error status. Carries its message verbatim. */
export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** No usable server at all: connection refused, DNS failure, or no reply in time. */
export class ApiUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    public readonly reason: string,
  ) {
    super(`Cannot reach the Open Walnut server at ${baseUrl} (${reason})`);
    this.name = 'ApiUnreachableError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = apiBaseUrl();
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch only rejects for transport-level failures (refused/DNS/abort) —
    // every HTTP status, including 5xx, resolves. So this branch always means
    // "there is no server answering here".
    const name = (err as { name?: string } | undefined)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError'
      ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s`
      : 'connection refused';
    throw new ApiUnreachableError(base, reason);
  }

  const text = res.status === 204 ? '' : await res.text();
  let parsed: unknown;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  }

  if (!res.ok) {
    // v1 shape: { error: { code, message } }. Older internal routes use
    // { error: "message" } — accept both so a message always reaches the user.
    const raw = (parsed as { error?: unknown } | undefined)?.error;
    let message = `HTTP ${res.status}`;
    let code = 'http_error';
    if (typeof raw === 'string' && raw) {
      message = raw;
    } else if (raw && typeof raw === 'object') {
      const obj = raw as { code?: unknown; message?: unknown };
      if (typeof obj.message === 'string' && obj.message) message = obj.message;
      if (typeof obj.code === 'string' && obj.code) code = obj.code;
    }
    throw new ApiClientError(message, res.status, code);
  }

  return parsed as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body ?? {});
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

/**
 * Print ONE friendly line for an API failure and set exit code 1. Shared by
 * every converted command so the "server isn't running" message is identical
 * everywhere (and can never drift into a stack trace).
 */
export function reportApiError(err: unknown, globals: { json?: boolean }): void {
  const message = err instanceof ApiUnreachableError
    ? `Open Walnut server is not running at ${err.baseUrl} — start it with: open-walnut web`
    : err instanceof Error ? err.message : String(err);

  if (globals.json) {
    // Lazy import keeps this module free of CLI-presentation deps at load time.
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
}
