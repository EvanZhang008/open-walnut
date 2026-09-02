/**
 * useEmbeddedImageFreshness — the Files pane's images update by themselves.
 *
 * Wires `revalidateImages` (utils/embedded-image-freshness) to the moments an
 * embedded picture is likely to have changed, so the user never has to press
 * Refresh for one and is never interrupted by one:
 *
 *   - the session's agent finished a tool call that could write a file
 *     (Write/Edit/Bash/anything not read-only) — debounced, since a turn runs
 *     many tools back to back and the diagram script is usually the last;
 *   - the window regained focus / the tab became visible — the user is looking
 *     again after doing something elsewhere;
 *   - a slow idle tick while the pane is on screen, for writers we cannot hear
 *     (another session, a terminal, a sync).
 *
 * Every check is conditional requests that answer 304 unless bytes changed, and
 * a change swaps ONE <img>'s src in the DOM. Nothing here touches editor state.
 */
import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { revalidateImages, READ_ONLY_TOOLS } from '@/utils/embedded-image-freshness';
import { log } from '@/utils/log';

/** A turn's tool results arrive in bursts; one check after the burst settles. */
export const TOOL_RESULT_SETTLE_MS = 1500;
/** A page of pictures finishes loading over a few frames; one baseline pass. */
export const BASELINE_SETTLE_MS = 300;
/** Idle re-check while the pane is visible. Slow on purpose: remote images cost
 *  a daemon stat each (throttled host-side to one per 5s per path). */
export const IDLE_CHECK_MS = 30_000;

export interface UseEmbeddedImageFreshnessOptions {
  /** The pane's content root; images are found under it. */
  rootRef: RefObject<HTMLElement | null>;
  /** Off while loading, or for panes with no rendered images (raw kinds). */
  enabled: boolean;
  /** Session whose tool calls announce writes. Absent → only focus + idle ticks. */
  sessionId?: string;
  /** Identity of the open file — the ETag memory resets when it changes. */
  fileKey: string;
  /**
   * A picture changed and its <img> was swapped to `…&r=<version>`. The parent
   * should adopt `version` as the image version it hands to any renderer, so a
   * later repaint (ProseMirror redrawing the node) emits the same fresh URL
   * instead of falling back to the one the memory cache still holds.
   */
  onChanged: (version: number, count: number) => void;
}

export interface EmbeddedImageFreshness {
  /** Run a check now (the pane's Refresh, after a read that found the same bytes). */
  checkNow: () => Promise<void>;
}

export function useEmbeddedImageFreshness(opts: UseEmbeddedImageFreshnessOptions): EmbeddedImageFreshness {
  const { rootRef, enabled, sessionId, fileKey } = opts;
  const onChangedRef = useRef(opts.onChanged);
  onChangedRef.current = opts.onChanged;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // ETag per picture, the memory that turns "an ETag" into "a CHANGED ETag".
  const etagsRef = useRef(new Map<string, string>());
  useEffect(() => { etagsRef.current = new Map(); }, [fileKey]);

  const inFlightRef = useRef<Promise<void> | null>(null);
  // A trigger that arrived mid-pass asks for one more pass, not a parallel one:
  // a picture that finished loading during the pass still needs its baseline.
  const rerunRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tool-use ids (this session) whose tool may write; a matching result arms a check.
  const writeToolIdsRef = useRef(new Set<string>());

  const checkNow = useCallback(async (): Promise<void> => {
    if (!enabledRef.current) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const root = rootRef.current;
    if (!root) return;
    if (inFlightRef.current) { rerunRef.current = true; return inFlightRef.current; }
    const run = (async () => {
      try {
        do {
          rerunRef.current = false;
          const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('img'));
          if (imgs.length === 0) return;
          const version = Date.now();
          const res = await revalidateImages(imgs, etagsRef.current, version, fetch);
          if (res.changed.length > 0) {
            log.info('file-editor', 'embedded images updated in place', {
              fileKey, count: res.changed.length, version,
            });
            onChangedRef.current(version, res.changed.length);
          }
        } while (rerunRef.current);
      } finally {
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = run;
    return run;
  }, [rootRef, fileKey]);

  const scheduleSettled = useCallback(() => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      void checkNow();
    }, TOOL_RESULT_SETTLE_MS);
  }, [checkNow]);

  useEffect(() => () => {
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
  }, []);

  // ── Baseline ──────────────────────────────────────────────────────────────
  // A picture's first ETag is only recorded, so every picture must have been
  // seen BEFORE it changes or the change is invisible. Pictures arrive over
  // time (ProseMirror mounts, the browser decodes), so the baseline is taken
  // when an <img> under the root finishes loading. `load` does not bubble;
  // capturing at the root hears it. After a swap the fresh <img> loads too and
  // re-checks once — its ETag matches the one just recorded, so it stops there.
  useEffect(() => {
    if (!enabled) return;
    const root = rootRef.current;
    if (!root) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; void checkNow(); }, BASELINE_SETTLE_MS);
    };
    const onLoad = (e: Event) => { if (e.target instanceof HTMLImageElement) arm(); };
    root.addEventListener('load', onLoad, true);
    // Pictures already on screen when this arms (pane re-enabled after a reload).
    if (root.querySelector('img')) arm();
    return () => {
      root.removeEventListener('load', onLoad, true);
      if (t) clearTimeout(t);
    };
  }, [enabled, rootRef, checkNow]);

  // ── The agent wrote something ─────────────────────────────────────────────
  useEvent('session:tool-use', (data) => {
    const d = data as { sessionId?: string; toolName?: string; toolUseId?: string; replayed?: boolean };
    if (!sessionId || d.sessionId !== sessionId || !d.toolUseId || d.replayed) return;
    if (d.toolName && READ_ONLY_TOOLS.has(d.toolName)) return;
    writeToolIdsRef.current.add(d.toolUseId);
  });
  useEvent('session:tool-result', (data) => {
    const d = data as { sessionId?: string; toolUseId?: string };
    if (!sessionId || d.sessionId !== sessionId || !d.toolUseId) return;
    // The result is the "it landed" signal; checking on tool-use would read the
    // picture the script is still writing.
    if (!writeToolIdsRef.current.delete(d.toolUseId)) return;
    scheduleSettled();
  });
  useEffect(() => { writeToolIdsRef.current.clear(); }, [sessionId, fileKey]);

  // ── The user is looking again ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => { if (!document.hidden) void checkNow(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, checkNow]);

  // ── Writers we cannot hear ────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => { void checkNow(); }, IDLE_CHECK_MS);
    return () => clearInterval(t);
  }, [enabled, checkNow]);

  return { checkNow };
}
