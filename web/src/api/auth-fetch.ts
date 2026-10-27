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
 */

import { getDeviceToken } from './device-token';
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

let installed = false;

export function installAuthFetch(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const original = window.fetch.bind(window);
  const testRun = testRunLabel();
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const href = window.location.href;
    const withToken = initWithDeviceToken(input, init, href, getDeviceToken()) ?? init;
    const next = initWithTestRun(input, withToken, href, testRun) ?? withToken;
    return next ? original(input, next) : original(input);
  };
}
