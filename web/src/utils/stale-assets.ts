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
 */
import { log } from '@/utils/log';

const RELOAD_LOG_KEY = 'open-walnut-stale-asset-reloads';
/** Reloads allowed inside RELOAD_WINDOW_MS before we stop trying. */
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 5 * 60_000;
/** How often a deferred reload re-checks for a safe moment. */
const RETRY_MS = 10_000;

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

function resolveDeps(deps?: Partial<StaleAssetDeps>): StaleAssetDeps {
  return {
    session: deps?.session ?? window.sessionStorage,
    now: deps?.now ?? Date.now,
    reload: deps?.reload ?? (() => window.location.reload()),
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
