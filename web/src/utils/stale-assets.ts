/**
 * Stale-build recovery for the SPA.
 *
 * Every deploy re-hashes AND wipes `dist/web/static/assets` (vite
 * `emptyOutDir`), so a tab loaded before a deploy is running a build whose
 * code-split chunks no longer exist on the server. The tab looks fine — its
 * main chunk is already in memory — until it reaches for a chunk it never
 * fetched: a CodeMirror grammar, `@/api/agents`, the flight recorder. That
 * fetch then fails for the rest of the tab's life.
 *
 * The failure is invisible, because a best-effort load has a `catch` that
 * shrugs. What the user sees is a feature that quietly does nothing: a `.go`
 * file rendering with ZERO syntax colors, in a tab that highlighted Go fine an
 * hour earlier.
 *
 * Vite fires `vite:preloadError` for exactly this case, so treat it as "this
 * tab is running a build that no longer exists" and reload. Two rules keep the
 * reload from becoming its own bug:
 *  - never reload on top of unsaved text (a half-typed message, a dirty file
 *    editor) — wait for a safe moment instead of discarding it;
 *  - never reload-loop: a few attempts per window, then give up with a log line.
 *
 * We deliberately do NOT `preventDefault()` the event: cancelling it makes the
 * failed `import()` RESOLVE with undefined instead of rejecting, which turns a
 * caller's clean error path into a TypeError. Letting it reject keeps every
 * existing fallback intact while we reload underneath.
 *
 * That reload is the BACKSTOP, not the plan. It fired under the user's click
 * (2026-09-03, Mac app: "clicking a path flashes the page and opens nothing" —
 * the Files panel's grammar chunk 404ed, the page reloaded on top of it, and
 * the second click worked because it ran on the new build). Two things now keep
 * it rare:
 *  - the server keeps previous builds' hashed chunks servable (static-mirror.ts),
 *    so a stale tab loads its own build's chunks instead of failing;
 *  - `initStaleBuildUpgrade` moves a stale tab onto the current build at a
 *    moment nobody is looking: a deploy restarts the server, every tab
 *    reconnects its WebSocket, and a tab whose bundle no longer matches the
 *    server's reloads only while HIDDEN (and with no unsaved text). A visible
 *    tab waits for the next time it is hidden. The Mac app's shell covers the
 *    visible-but-idle case on its own (WebContentWatchdog, `stale_bundle`).
 */
import { log } from '@/utils/log';
import { beaconFlush } from '@/utils/browser-logger';

const RELOAD_LOG_KEY = 'open-walnut-stale-asset-reloads';
/** Reloads allowed inside RELOAD_WINDOW_MS before we stop trying. */
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 5 * 60_000;
/** How often a deferred reload re-checks for a safe moment. */
const RETRY_MS = 10_000;
/**
 * After a reconnect, how long to wait before asking which bundle the server
 * serves: the server is seconds old and every tab is hammering it with its
 * own boot fetches.
 */
const RECONNECT_SETTLE_MS = 5_000;
/**
 * A tab must stay hidden this long before a drift reload: a quick ⌘-tab away
 * and back is not "nobody is looking".
 */
const HIDDEN_GRACE_MS = 20_000;

/** What the DOM told us about work a reload would destroy. */
export interface UnsavedSnapshot {
  /** The Files panel's dirty dot — an editor with explicit-save changes. */
  dirtyEditor: boolean;
  /**
   * Composer drafts (`<textarea>`). Precious whether or not they have focus — a
   * half-written message you left to go read code is exactly what a reload must
   * not eat.
   */
  drafts: string[];
  /**
   * Text in the field that has focus RIGHT NOW: a single-line input, or an
   * inline-editing contenteditable (a task title). Focus-gated on purpose —
   * most single-line inputs here are search and filter boxes, and a stale
   * filter must not block recovery forever.
   */
  focusedText: string;
}

/** Pure half of the safety check, so the rule is testable without a DOM. */
export function isUnsaved(snapshot: UnsavedSnapshot): boolean {
  return snapshot.dirtyEditor
    || snapshot.drafts.some((t) => t.trim().length > 0)
    || snapshot.focusedText.trim().length > 0;
}

/** Text-bearing input types only: a checked checkbox is not unsaved typing. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);
/**
 * Editors whose contenteditable holds a DOCUMENT, not unsaved typing: the
 * CodeMirror source editor and the TipTap surfaces. Scanning them for text
 * (the first version of this file did) reports "unsaved" for as long as any
 * file is open, which defers the reload forever — caught in verification, with
 * a JSON grammar failing on a rebuilt server and the tab refusing to heal.
 * Their real dirty state is `.fv-dirty-dot`.
 */
const DOCUMENT_EDITOR_SELECTOR = '.cm-editor, .ProseMirror, .tiptap';

const EDITABLE_ATTR_VALUES = new Set(['', 'true', 'plaintext-only']);

/**
 * DOM half of the safety check. Kept trivial — the rule lives in isUnsaved.
 * `active` is a parameter (not read straight off the document) so the rule can
 * be tested against a headless DOM that has no focus model.
 */
export function readUnsavedSnapshot(doc: Document = document, active: Element | null = doc.activeElement): UnsavedSnapshot {
  const drafts = Array.from(doc.querySelectorAll('textarea'), (el) => (el as HTMLTextAreaElement).value ?? '');
  // An image pasted into a composer is unsent work with no text to find: it
  // lives only in React state, so a reload drops it and the user has to go find
  // the screenshot again. Counted as a draft so every caller (this file's
  // recovery, the drift upgrade, the desktop shell's page-process recycle)
  // treats it the same as half-typed text.
  if (doc.querySelector('.chat-image-preview')) drafts.push('[pending attachment]');
  let focusedText = '';
  const tag = active?.tagName?.toUpperCase();
  if (tag === 'INPUT') {
    const type = (active!.getAttribute('type') ?? '').toLowerCase();
    if (TEXT_INPUT_TYPES.has(type)) focusedText = (active as HTMLInputElement).value ?? '';
  } else if (active && EDITABLE_ATTR_VALUES.has((active.getAttribute('contenteditable') ?? 'off').toLowerCase())) {
    // An inline title being edited counts; a document editor's body does not.
    if (!active.closest?.(DOCUMENT_EDITOR_SELECTOR)) focusedText = active.textContent ?? '';
  }
  return { dirtyEditor: doc.querySelector('.fv-dirty-dot') != null, drafts, focusedText };
}

/** Would reloading right now throw away something the user typed? */
export function hasUnsavedWork(doc: Document = document): boolean {
  return isUnsaved(readUnsavedSnapshot(doc));
}

interface EventTargetLike {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

export interface StaleAssetDeps {
  session: Storage;
  now: () => number;
  reload: () => void;
  /** True while a reload would destroy unsaved text. */
  hasUnsaved: () => boolean;
  /** Where `vite:preloadError` is dispatched (window in the browser). */
  target: EventTargetLike;
  /** Schedule the re-check for a deferred reload; returns its canceller. */
  retry: (check: () => void) => () => void;
}

/**
 * The default reload: push the buffered log lines out FIRST. A reload is the
 * one moment the periodic WS flush cannot reach, and the Mac app's WKWebView
 * never fires beforeunload — so the very line saying "reloading to pick up
 * the current build" used to vanish with the page it described.
 */
function reloadWithLogs(): void {
  try { beaconFlush(); } catch { /* logging must never block recovery */ }
  window.location.reload();
}

function resolveDeps(deps?: Partial<StaleAssetDeps>): StaleAssetDeps {
  return {
    session: deps?.session ?? window.sessionStorage,
    now: deps?.now ?? Date.now,
    reload: deps?.reload ?? reloadWithLogs,
    hasUnsaved: deps?.hasUnsaved ?? (() => hasUnsavedWork()),
    target: deps?.target ?? window,
    retry: deps?.retry ?? ((check) => {
      const id = window.setInterval(check, RETRY_MS);
      return () => window.clearInterval(id);
    }),
  };
}

/**
 * Record a reload attempt and decide whether to actually do it. Rate-limited
 * through sessionStorage so a server that keeps failing can't spin the tab.
 */
export function recordStaleReload(deps?: Partial<Pick<StaleAssetDeps, 'session' | 'now'>>): 'reload' | 'give-up' {
  const session = deps?.session ?? window.sessionStorage;
  const now = deps?.now ?? Date.now;
  let history: number[] = [];
  try {
    const parsed = JSON.parse(session.getItem(RELOAD_LOG_KEY) ?? '[]');
    if (Array.isArray(parsed)) history = parsed.filter((t): t is number => typeof t === 'number');
  } catch { /* corrupt — start fresh */ }
  const t = now();
  history = history.filter((prev) => t - prev < RELOAD_WINDOW_MS);
  if (history.length >= MAX_RELOADS) return 'give-up';
  history.push(t);
  try { session.setItem(RELOAD_LOG_KEY, JSON.stringify(history)); } catch { /* quota */ }
  return 'reload';
}

/**
 * Wire the recovery. Returns a teardown so tests (and any host that unmounts
 * the app) can detach it.
 */
export function initStaleAssetRecovery(deps?: Partial<StaleAssetDeps>): () => void {
  const { session, now, reload, hasUnsaved, target, retry } = resolveDeps(deps);
  let cancelRetry: (() => void) | null = null;

  const stopRetrying = () => { cancelRetry?.(); cancelRetry = null; };

  const attempt = () => {
    if (hasUnsaved()) {
      // Deferred, not cancelled: poll for the moment the draft is gone.
      if (!cancelRetry) cancelRetry = retry(attempt);
      return;
    }
    stopRetrying();
    if (recordStaleReload({ session, now }) === 'give-up') {
      log.error('assets', 'stale build assets keep failing — not reloading again', { maxReloads: MAX_RELOADS });
      return;
    }
    log.warn('assets', 'reloading to pick up the current build');
    reload();
  };

  const onPreloadError = (e: Event) => {
    const payload = (e as Event & { payload?: unknown }).payload;
    log.warn('assets', 'chunk from a previous build failed to load (a deploy replaced it)', {
      error: String((payload as Error | undefined)?.message ?? payload ?? ''),
      deferred: hasUnsaved(),
    });
    attempt();
  };

  target.addEventListener('vite:preloadError', onPreloadError);
  return () => {
    stopRetrying();
    target.removeEventListener('vite:preloadError', onPreloadError);
  };
}

// ── Stale-tab upgrade (bundle drift, reload only while hidden) ──

/** The entry bundle a document is running, read off its own <script> tag. */
export function runningBundleId(doc: Document = document): string | null {
  for (const s of Array.from(doc.scripts)) {
    const m = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(s.src ?? '');
    if (m) return m[1];
  }
  return null;
}

export interface StaleBuildUpgradeDeps {
  /** Bundle this tab runs; null = unknown (never reload on a guess). */
  running: () => string | null;
  /** Bundle the server serves now; null = unknown / request failed. */
  served: () => Promise<string | null>;
  /** True while the tab is not on screen. */
  hidden: () => boolean;
  /** Subscribe to reconnects; returns the unsubscribe. */
  onReconnect: (cb: () => void) => () => void;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibility: (cb: () => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** True while a reload would destroy unsaved text. */
  hasUnsaved: () => boolean;
  reload: () => void;
  session: Storage;
  now: () => number;
}

function resolveUpgradeDeps(deps?: Partial<StaleBuildUpgradeDeps>): StaleBuildUpgradeDeps {
  return {
    running: deps?.running ?? (() => runningBundleId()),
    served: deps?.served ?? fetchServedBundle,
    hidden: deps?.hidden ?? (() => document.visibilityState === 'hidden'),
    onReconnect: deps?.onReconnect ?? subscribeReconnect,
    onVisibility: deps?.onVisibility ?? ((cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    }),
    setTimeout: deps?.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms)),
    clearTimeout: deps?.clearTimeout ?? ((id) => window.clearTimeout(id as number)),
    hasUnsaved: deps?.hasUnsaved ?? (() => hasUnsavedWork()),
    reload: deps?.reload ?? reloadWithLogs,
    session: deps?.session ?? window.sessionStorage,
    now: deps?.now ?? Date.now,
  };
}

async function fetchServedBundle(): Promise<string | null> {
  // Lazy import: this module is loaded before React mounts, and the API client
  // pulls in the WS client and its logging; keep boot lean.
  const { apiGet } = await import('@/api/client');
  const res = await apiGet<{ webAssets?: { bundle?: string | null } | null }>('/api/config', undefined, { timeoutMs: 8_000 });
  return res?.webAssets?.bundle ?? null;
}

function subscribeReconnect(cb: () => void): () => void {
  let off: (() => void) | null = null;
  let cancelled = false;
  void import('@/api/ws').then(({ wsClient }) => {
    if (cancelled) return;
    wsClient.onEvent('_ws:reconnected', cb);
    off = () => wsClient.offEvent('_ws:reconnected', cb);
  });
  return () => { cancelled = true; off?.(); };
}

/**
 * Wire the upgrade. Pure sequencing over injected deps so the rule is
 * unit-testable without a DOM or a server:
 *
 *   reconnect → settle → bundles differ?
 *     no  → done
 *     yes → hidden now? reload (unsaved-gated, rate-limited)
 *           visible?   wait for the tab to be hidden HIDDEN_GRACE_MS, then the same
 *
 * Any unknown (either bundle null) means "do nothing": a reload on a guess is
 * exactly the bug this file exists to prevent.
 */
export function initStaleBuildUpgrade(deps?: Partial<StaleBuildUpgradeDeps>): () => void {
  const d = resolveUpgradeDeps(deps);
  let settleTimer: unknown = null;
  let graceTimer: unknown = null;
  let offVisibility: (() => void) | null = null;
  let checking = false;

  const clearGrace = () => { if (graceTimer != null) { d.clearTimeout(graceTimer); graceTimer = null; } };
  const disarm = () => { clearGrace(); offVisibility?.(); offVisibility = null; };

  const tryReload = (served: string, running: string) => {
    if (!d.hidden()) return false;
    if (d.hasUnsaved()) {
      log.info('assets', 'newer build on the server; tab is hidden but has unsaved text — not reloading', { running, served });
      return false;
    }
    if (recordStaleReload({ session: d.session, now: d.now }) === 'give-up') {
      log.error('assets', 'stale build keeps coming back after reload — not reloading again', { running, served });
      return true; // stop trying either way
    }
    log.warn('assets', 'reloading hidden tab onto the current build', { running, served });
    d.reload();
    return true;
  };

  const armForHidden = (served: string, running: string) => {
    disarm();
    const onChange = () => {
      clearGrace();
      if (!d.hidden()) return;
      graceTimer = d.setTimeout(() => {
        graceTimer = null;
        if (tryReload(served, running)) disarm();
      }, HIDDEN_GRACE_MS);
    };
    offVisibility = d.onVisibility(onChange);
    onChange();
  };

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const running = d.running();
      if (!running) return;
      const served = await d.served();
      if (!served || served === running) { disarm(); return; }
      log.info('assets', 'server serves a newer build than this tab runs', { running, served, hidden: d.hidden() });
      // A tab that is hidden right now gets the same grace as one that hides
      // later: a reconnect can land mid ⌘-tab, seconds before the user is back.
      armForHidden(served, running);
    } catch (err) {
      log.warn('assets', 'could not compare bundles after reconnect', { error: String((err as Error)?.message ?? err) });
    } finally {
      checking = false;
    }
  };

  const offReconnect = d.onReconnect(() => {
    if (settleTimer != null) d.clearTimeout(settleTimer);
    settleTimer = d.setTimeout(() => { settleTimer = null; void check(); }, RECONNECT_SETTLE_MS);
  });

  return () => {
    offReconnect();
    if (settleTimer != null) { d.clearTimeout(settleTimer); settleTimer = null; }
    disarm();
  };
}
