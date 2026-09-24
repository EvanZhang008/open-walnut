/**
 * Click-time decision for a link in a session's chat: is this a service the
 * session started (open it in the panel's Web view) or an ordinary web link
 * (leave the browser's new-tab behavior alone)?
 *
 * Decided at click time, not render time, so the rendered HTML stays a plain
 * `<a href target=_blank>` everywhere (copy-as-rich-text, rich HTML the model
 * wrote itself, tool output) and the decision can use the session's host and
 * the configured host list, which the renderer does not know.
 *
 * A service link is an http(s) URL on loopback, or on a host name Walnut knows
 * (the session's host or any configured host). The console's own origin is
 * never one (those are in-app links).
 */
import { hostnamesMatch, isLoopbackHostname, parseServiceUrl } from '@open-walnut/service-url';
import { getAllHostStatus, hydrateHostStatus } from '@/hooks/useHostStatus';

export { parseServiceUrl };

/**
 * Warm the configured-host list the click path reads synchronously. Rides the
 * shared host-status store (one request per TTL for every surface, kept fresh
 * by pushes). Loopback links work without it; only named hosts need it.
 */
export function primeKnownServiceHosts(): void {
  void hydrateHostStatus().catch(() => { /* the store records the failure */ });
}

function knownHostNames(): string[] {
  return getAllHostStatus().flatMap((h) => [h.host, h.hostname].filter((x): x is string => !!x));
}

/**
 * The tunnel end the server hands back is 127.0.0.1 on the machine running
 * Walnut. A console opened from another machine (a phone, the cloud companion)
 * cannot reach it, so there the links stay ordinary links.
 */
export function consoleCanEmbedServices(loc: Pick<Location, 'hostname'> = window.location): boolean {
  return isLoopbackHostname(loc.hostname);
}

export interface ServiceLinkContext {
  /** The session's host alias and resolved hostname (either may be empty). */
  sessionHost?: string;
  sessionHostname?: string;
  /** Configured host names/aliases. Defaults to the shared host-status store. */
  knownHosts?: string[];
  /** The console's own origin. Defaults to window.location.origin. */
  consoleOrigin?: string;
}

/** The href as a service URL, or null when it is an ordinary link. */
export function classifyServiceHref(href: string, ctx: ServiceLinkContext = {}): string | null {
  const raw = href.trim();
  // Only absolute http(s): relative hrefs are in-app routes, `#` is a pill.
  if (!/^https?:\/\//i.test(raw)) return null;
  const url = parseServiceUrl(raw);
  if (!url) return null;
  const origin = ctx.consoleOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  if (origin && url.origin === origin) return null;
  // The console under another loopback spelling (127.0.0.1 vs localhost) is
  // still the console, not a service.
  if (origin && isLoopbackHostname(url.hostname)) {
    try {
      const own = new URL(origin);
      if (isLoopbackHostname(own.hostname) && (url.port || defaultPort(url)) === (own.port || defaultPort(own))) return null;
    } catch { /* unparsable origin: no exclusion */ }
  }
  if (isLoopbackHostname(url.hostname)) return url.toString();
  const names = [
    ctx.sessionHost && ctx.sessionHost !== '__local__' ? ctx.sessionHost : '',
    ctx.sessionHostname ?? '',
    ...(ctx.knownHosts ?? knownHostNames()),
  ].filter(Boolean);
  // A named host needs a port: a bare `http://build-box/` is far more often a
  // web UI with its own ingress than something this session started.
  if (!url.port) return null;
  return names.some((n) => hostnamesMatch(url.hostname, n)) ? url.toString() : null;
}

function defaultPort(u: URL): string {
  return u.protocol === 'https:' ? '443' : '80';
}

/** `8080`, `:8080`, `localhost:8080/x`, a full URL → a normalized http(s) URL string. */
export function normalizeServiceInput(input: string): string | null {
  return parseServiceUrl(input)?.toString() ?? null;
}
