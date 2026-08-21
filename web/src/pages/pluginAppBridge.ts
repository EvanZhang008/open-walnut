/**
 * Host side of the plugin-app postMessage bridge.
 *
 * A plugin app is a static HTML page in a SANDBOXED iframe with no
 * `allow-same-origin`, so it cannot read localStorage, the device token, or any
 * Walnut cookie. Everything it can do goes through the four messages below,
 * which this module implements. The client half that plugin authors load is
 * `web/public/walnut-app-sdk.js` — keep the two in step.
 *
 * Pure module (no React, no direct window/ws imports): every capability arrives
 * as a callback in `BridgeContext`, so the protocol is unit-testable with a fake
 * iframe window.
 */

/** Max event prefixes one app may register (a runaway `on()` loop is a bug). */
export const MAX_EVENT_PREFIXES = 16;

export interface BridgeContext {
  appId: string;
  pluginId: string;
  /** Resolved theme, forwarded so the app can match Walnut's look. */
  theme: 'light' | 'dark';
  /** The live iframe window — the ONLY accepted message source. */
  getFrameWindow: () => Window | null;
  /** Dispatch an HTTP call on the app's behalf (client.ts helpers). */
  apiCall: (method: ApiMethod, path: string, body?: unknown) => Promise<unknown>;
  /** Subscribe to every bus event; returns an unsubscribe. */
  subscribeAll: (cb: (name: string, data: unknown) => void) => () => void;
  /** SPA navigation for `walnut:open`. */
  navigate: (path: string) => void;
  /** Structured log sink (subsystem is fixed by the caller). */
  logWarn: (message: string, data?: Record<string, unknown>) => void;
}

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const API_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface PluginAppBridge {
  /** Feed a window 'message' event in. Non-plugin messages are ignored. */
  handleMessage: (event: MessageEvent) => void;
  /** Drop the event subscription. Call on unmount. */
  dispose: () => void;
  /** Test/diagnostic view of the registered prefixes. */
  getPrefixes: () => string[];
}

/**
 * Validate an `/api/...` path an app asked us to call.
 *
 * Full API access is the product intent: a plugin app is first-party code the
 * user installed, and the point of the bridge is that it can drive Walnut. The
 * one carve-out is CONFIG WRITES — provider credentials and server settings are
 * changed in Settings by a human, never silently by an embedded page. Reads of
 * `/api/config` stay allowed (an app may want the active model or mode).
 */
export function validateApiRequest(method: string, path: unknown): { ok: true; method: ApiMethod; path: string } | { ok: false; error: string } {
  if (!API_METHODS.has(method)) return { ok: false, error: `Unsupported method: ${String(method)}` };
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    return { ok: false, error: 'path must be a string starting with /api/' };
  }
  // Segment-wise traversal check (a substring test would reject an ordinary
  // name like `foo..bar`), applied to the path portion only.
  const pathOnly = path.split(/[?#]/)[0];
  if (pathOnly.split('/').some((seg) => seg === '..')) {
    return { ok: false, error: 'path must not contain .. segments' };
  }
  if (method !== 'GET' && (pathOnly === '/api/config' || pathOnly.startsWith('/api/config/'))) {
    return { ok: false, error: 'config writes are not available to plugin apps — use Settings' };
  }
  return { ok: true, method: method as ApiMethod, path };
}

/** Our own origin, or '' where there is no window (unit tests run under node). */
function selfOrigin(): string {
  return typeof window !== 'undefined' && window.location ? window.location.origin : '';
}

function normalizePrefixes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== 'string' || p.length === 0) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= MAX_EVENT_PREFIXES) break;
  }
  return out;
}

export function createPluginAppBridge(ctx: BridgeContext): PluginAppBridge {
  let prefixes: string[] = [];
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  /**
   * Reply into the iframe.
   *
   * targetOrigin is '*' because the frame's origin is OPAQUE ("null"): a
   * sandbox without allow-same-origin cannot be addressed by any concrete
   * origin string, and passing 'null' throws. This is the standard sandboxed-
   * iframe pattern and is safe here: we only ever post to the exact
   * contentWindow of the iframe we created, which no other document can reach.
   */
  const post = (msg: unknown): void => {
    const frame = ctx.getFrameWindow();
    if (!frame) return;
    frame.postMessage(msg, '*');
  };

  const ensureSubscribed = (): void => {
    if (unsubscribe) return;
    unsubscribe = ctx.subscribeAll((name, data) => {
      if (disposed) return;
      if (!prefixes.some((p) => name.startsWith(p))) return;
      post({ type: 'walnut:event', name, data });
    });
  };

  const handleMessage = (event: MessageEvent): void => {
    if (disposed) return;
    const frame = ctx.getFrameWindow();
    // Identity check first: `source` is the browser's own unforgeable handle on
    // the sending window. Origin can only be compared AFTER that, because a
    // sandboxed frame reports the opaque "null".
    if (!frame || event.source !== frame) return;
    if (event.origin !== 'null' && event.origin !== selfOrigin()) {
      ctx.logWarn('rejected message from unexpected origin', { origin: event.origin, appId: ctx.appId });
      return;
    }
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (!msg.type.startsWith('walnut:')) return;

    switch (msg.type) {
      case 'walnut:ready':
        post({
          type: 'walnut:init',
          payload: { appId: ctx.appId, pluginId: ctx.pluginId, theme: ctx.theme },
        });
        return;

      case 'walnut:api': {
        const id = msg.id;
        if (typeof id !== 'string' && typeof id !== 'number') {
          ctx.logWarn('walnut:api without an id', { appId: ctx.appId });
          return;
        }
        const checked = validateApiRequest(String(msg.method), msg.path);
        if (!checked.ok) {
          post({ type: 'walnut:api-result', id, ok: false, error: checked.error });
          return;
        }
        // No `status` on success on purpose: the client helpers return only the
        // parsed body (a 204 arrives as undefined), so the host genuinely does
        // not know the code — reporting a confident "200" would be a guess. The
        // failure path DOES carry the real status, which is where it matters.
        ctx.apiCall(checked.method, checked.path, msg.body)
          .then((data) => post({ type: 'walnut:api-result', id, ok: true, data }))
          .catch((err: unknown) => {
            const status = typeof (err as { status?: unknown })?.status === 'number'
              ? (err as { status: number }).status
              : undefined;
            const error = err instanceof Error ? err.message : String(err);
            post({ type: 'walnut:api-result', id, ok: false, status, error });
          });
        return;
      }

      case 'walnut:subscribe': {
        const next = normalizePrefixes(msg.prefixes);
        if (Array.isArray(msg.prefixes) && msg.prefixes.length > MAX_EVENT_PREFIXES) {
          ctx.logWarn('event prefixes capped', {
            appId: ctx.appId, asked: msg.prefixes.length, cap: MAX_EVENT_PREFIXES,
          });
        }
        prefixes = next;
        if (prefixes.length > 0) ensureSubscribed();
        return;
      }

      case 'walnut:open': {
        const path = msg.path;
        if (typeof path !== 'string' || !path.startsWith('/')) {
          ctx.logWarn('walnut:open rejected — path must start with /', { appId: ctx.appId });
          return;
        }
        ctx.navigate(path);
        return;
      }

      default:
        ctx.logWarn('unknown bridge message', { type: msg.type, appId: ctx.appId });
    }
  };

  return {
    handleMessage,
    dispose: () => {
      disposed = true;
      prefixes = [];
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    getPrefixes: () => [...prefixes],
  };
}
