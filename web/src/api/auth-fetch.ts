/**
 * Every same-origin `/api/` fetch carries the device token, and in a test window its
 * test-run header (./test-run.ts).
 *
 * client.ts attaches it, but about forty loaders call `fetch('/api/...')`
 * directly (the notifications feed, quiet mode, status items, files, session
 * streams). On the computer Walnut runs on that is fine, since no token is
 * needed there; a signed-in phone got 401 from each of them, so parts of the
 * console stayed empty with no error (2026-10-13). Wrapping fetch once fixes
 * them all and every future one.
 *
 * An explicit Authorization header wins, a request to another origin is left
 * alone, and the sign-in exchange is never given a token (it is how a browser
 * gets one, and a stale one there would only confuse the log).
 *
 * A call this wrapper gave the token is sent once more when its 401 says the
 * browser's sign-in ran out (`token_expired`: renewed first, device-token.ts)
 * or the token was renewed while it was out, as client.ts does, so a loader
 * never shows an empty pane for a sign-in that renews itself. Only a call whose
 * body can be sent twice (none, or a string, form or blob, never a stream).
 */

import { getDeviceToken, renewSignIn } from './device-token';
import { getSignedOutReason, noteAuthRefusal } from './unpaired';
import { TEST_RUN_HEADER, testRunLabel } from './test-run';

const NO_TOKEN_PATHS = new Set(['/api/v1/browser-pair']);

/** The URL a fetch input names, or null when it cannot be read. */
function inputUrl(input: RequestInfo | URL): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return null;
}

/**
 * The init to send instead, or null to send the call untouched. Pure apart from
 * reading the token, so tests drive it without a browser.
 */
export function initWithDeviceToken(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  pageHref: string,
  token: string | null,
): RequestInit | null {
  if (!token) return null;
  const raw = inputUrl(input);
  if (raw === null) return null;
  let url: URL;
  let page: URL;
  try {
    url = new URL(raw, pageHref);
    page = new URL(pageHref);
  } catch {
    return null;
  }
  if (url.origin !== page.origin) return null;
  if (!url.pathname.startsWith('/api/') || NO_TOKEN_PATHS.has(url.pathname)) return null;
  const fromRequest = typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init?.headers ?? fromRequest);
  if (headers.has('Authorization')) return null;
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * The init that adds a test window's `x-walnut-test-run` (./test-run.ts) to a same-origin
 * `/api/` call, or null to leave it. An explicit header wins.
 */
export function initWithTestRun(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  pageHref: string,
  label: string | null,
): RequestInit | null {
  if (!label) return null;
  const raw = inputUrl(input);
  if (raw === null) return null;
  let url: URL;
  let page: URL;
  try {
    url = new URL(raw, pageHref);
    page = new URL(pageHref);
  } catch {
    return null;
  }
  if (url.origin !== page.origin || !url.pathname.startsWith('/api/')) return null;
  const fromRequest = typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined;
  const headers = new Headers(init?.headers ?? fromRequest);
  if (headers.has(TEST_RUN_HEADER)) return null;
  headers.set(TEST_RUN_HEADER, label);
  return { ...init, headers };
}

/** A body fetch can send again: none, or one it did not consume as a stream. */
function replayable(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (typeof Request !== 'undefined' && input instanceof Request) return false;
  const body = init?.body;
  return body === undefined || body === null || typeof body === 'string'
    || (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams)
    || (typeof FormData !== 'undefined' && body instanceof FormData)
    || (typeof Blob !== 'undefined' && body instanceof Blob)
    || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
}

/** The token to send a refused call again with, or null to leave its 401 as it is. */
async function tokenForRetry(res: Response, sent: string): Promise<string | null> {
  const now = getDeviceToken();
  if (now && now !== sent) return now;
  const body = await res.clone().json().catch(() => null) as { code?: unknown } | null;
  if (body?.code !== 'token_expired') return null;
  const renewed = await renewSignIn();
  if (renewed.kind === 'renewed' || renewed.kind === 'held') return getDeviceToken();
  if (renewed.kind === 'refused') noteAuthRefusal(renewed.body);
  return null;
}

/** What a signed-out page may still ask: signing in again, and whether it is signed in. */
const SIGNED_OUT_PATHS = new Set(['/api/v1/browser-pair', '/api/auth/browser/refresh', '/api/v1/me']);

/**
 * Whether a call is answered here instead of sent, once the page heard why it was signed
 * out (removed on the computer, used elsewhere, its cookie gone): a poller that outlived
 * the console (a plugin's timer) kept asking every 15 to 30 s and got 401 each time.
 */
export function heldOffWhileSignedOut(input: RequestInfo | URL, pageHref: string, signedOutFor: string | null): boolean {
  if (!signedOutFor) return false;
  const raw = inputUrl(input);
  if (raw === null) return false;
  try {
    const url = new URL(raw, pageHref);
    return url.origin === new URL(pageHref).origin && url.pathname.startsWith('/api/') && !SIGNED_OUT_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

let installed = false;

export function installAuthFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  const testRun = testRunLabel();
  const send = (input: RequestInfo | URL, init: RequestInit | undefined, token: string | null) => {
    const href = window.location.href;
    const withToken = initWithDeviceToken(input, init, href, token);
    const next = initWithTestRun(input, withToken ?? init, href, testRun) ?? withToken ?? init;
    return { tokened: withToken !== null, response: next ? original(input, next) : original(input) };
  };
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const token = getDeviceToken();
    if (token && heldOffWhileSignedOut(input, window.location.href, getSignedOutReason())) {
      return new Response(JSON.stringify({ error: 'This browser is signed out.', code: 'signed_out_here' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const first = send(input, init, token);
    const res = await first.response;
    if (res.status !== 401 || !first.tokened || !token || !replayable(input, init)) return res;
    const again = await tokenForRetry(res, token);
    return again ? send(input, init, again).response : res;
  };
}
