/**
 * One id per user action that writes (docs/plan/walnut-replica-servers-impl.md,
 * section 3, "Op ids"). The web client sends it as `x-walnut-op-id` on every
 * HTTP write and as `opId` on every WS RPC frame. A host replica keeps it when it
 * forwards the write to the Mac or journals it while the Mac is away, so the
 * same action applies once whichever path carried it. Same shape the replica
 * mints for a client that sends none (src/replica/dispatch.ts mintOpId).
 */

export const OP_ID_HEADER = 'x-walnut-op-id';

/**
 * How long this write waits for its answer, sent when a call waits longer than
 * the default 15 s (a calendar change the user confirms on the phone, an image
 * upload). A host replica forwarding the write to the Mac answers it 504 at
 * that deadline (src/replica/dispatch.ts writeBudgetOf); a write that says no
 * wait is never cut while the Mac works on it, so a raw fetch needs none.
 */
export const WAIT_HEADER = 'x-walnut-wait-ms';
export const DEFAULT_WRITE_WAIT_MS = 15_000;

export function mintOpId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `op-${hex}`;
}

/** Whether an HTTP method writes (the ones that carry an op id). */
export function isWriteMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/** Whether a fetch target is this page's own server (a custom header elsewhere would need CORS). */
function sameOrigin(input: RequestInfo | URL, origin: string): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (raw.startsWith('/') && !raw.startsWith('//')) return true;
  try { return new URL(raw, origin).origin === origin; } catch { return false; }
}

/**
 * The init a raw `fetch` write goes out with: an op id added when it has none
 * (a write that went through request() keeps its own). Reads, other origins,
 * and a write that already names one are left as they are.
 */
export function withOpId(input: RequestInfo | URL, init: RequestInit | undefined, origin: string): RequestInit | undefined {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const method = init?.method ?? (isRequest ? (input as Request).method : 'GET');
  if (!isWriteMethod(method) || !sameOrigin(input, origin)) return init;
  const headers = new Headers(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
  if (headers.has(OP_ID_HEADER)) return init;
  headers.set(OP_ID_HEADER, mintOpId());
  return { ...init, headers };
}

let installed = false;

/**
 * Every same-origin write sent with `fetch` directly (file saves and file ops,
 * notification actions, settings and plugin buttons, voice uploads) carries an
 * op id, as request()'s writes do: installed once at boot (main.tsx), so a raw
 * write added later is covered too. Known exception: `navigator.sendBeacon`
 * cannot set a header and never goes through fetch (the time-tracking
 * heartbeat, the browser log flush on unload), so the replica mints an id per
 * beacon; both are counters or logs, where a second copy costs nothing.
 */
export function installOpIdFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => original(input, withOpId(input, init, window.location.origin));
}
