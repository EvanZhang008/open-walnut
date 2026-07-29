import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchConfig, updateConfig } from '@/api/config';
import { useEvent } from '@/hooks/useWebSocket';

/**
 * 'auto' (breakpoint-driven) or an explicit column count as a decimal string.
 * The Settings picker offers every count in [MIN_PANELS, MAX_PANELS] plus Auto.
 *
 * Kept as a string rather than a closed union ('1' | '2' | ...) because the value
 * also arrives from config.yaml and from other/older clients, so parsing has to be
 * range-checked at runtime anyway — see isValidMode/panelCountOf.
 */
export type SessionPanelMode = 'auto' | `${number}`;

export const MIN_PANELS = 1;
/**
 * Most panels the picker offers. Not arbitrary: the session strip maxes out at 70%
 * of the viewport, so on a 2560px screen 5 columns is ~360px each — about the floor
 * for a usable session panel (composer + header + code blocks). Narrower than that
 * is unreadable, and each column is a live CLI session's worth of DOM and streaming.
 */
export const MAX_PANELS = 5;

// Min width (px) of the chat+sessions container to allow N session panels in auto mode.
// Mac 14" content-row ≈ 1305px — too cramped for 2 sessions alongside chat.
// 1400 so Mac 14" gets 1 panel, external monitors (1500px+) get 2. The third step
// adds one panel's worth (~700px of usable strip) before auto will volunteer a 3rd:
// auto must never produce columns too narrow to read. Auto deliberately stops at 3 —
// beyond that is an explicit choice the user makes by picking 4 or 5, not something
// we spring on them for merely having a wide monitor.
const AUTO_MIN_WIDTH_FOR_TWO = 1400;
const AUTO_MIN_WIDTH_FOR_THREE = 2100;

/** Parse a mode into a column count, or null when it isn't an explicit count. */
export function panelCountOf(mode: SessionPanelMode): number | null {
  if (mode === 'auto') return null;
  const n = Number(mode);
  return Number.isInteger(n) && n >= MIN_PANELS && n <= MAX_PANELS ? n : null;
}

function isValidMode(v: unknown): v is SessionPanelMode {
  if (v === 'auto') return true;
  if (typeof v !== 'string' || v.trim() === '') return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= MIN_PANELS && n <= MAX_PANELS;
}

// How long to ignore config:changed events after we caused them (ms)
const SELF_CHANGE_COOLDOWN = 3000;

const FALLBACK_MODE: SessionPanelMode = '2';

// Module-scoped cache of the resolved mode. `session_panels` is ONE app-wide
// setting, but the hook is mounted per component and used to re-derive from
// scratch on every mount — so each new mount rendered the '2' FALLBACK until its
// own fetch landed. Visible as the Settings picker showing "2 Panels" for a beat
// before snapping to the real "3 Panels" every time you navigate back, and as
// the home page briefly computing a 2-column budget. Remembering the resolved
// value makes a remount start from the truth instead of the fallback.
let cachedMode: SessionPanelMode | null = null;

/**
 * Every mounted instance of this hook, so a change made through ONE of them updates
 * the others in the same tick.
 *
 * Required now that the setting has two surfaces (Settings → General AND every session's
 * kebab menu). `setMode` writes the module cache, but a cache write notifies nobody —
 * sibling instances (e.g. MainPage's, which owns the actual column budget) would only
 * catch up via the `config:changed` WS round-trip, measured at ~2s behind a
 * read-modify-write under a file lock. Picking "4" from a session menu and watching the
 * columns sit still for two seconds reads as a broken control, so the fan-out is what
 * makes an in-context switcher feel immediate. Config is still written; this is purely
 * the local echo.
 */
const modeListeners = new Set<(m: SessionPanelMode) => void>();

/**
 * Push `m` to the module cache and every mounted instance.
 *
 * No self-exclusion: the caller has already set its own state, and re-setting a
 * useState to the value it already holds is a no-op React bails out of — so telling
 * everyone is simpler and cheaper than tracking which listener belongs to the caller.
 */
function broadcastMode(m: SessionPanelMode) {
  cachedMode = m;
  for (const listener of modeListeners) listener(m);
}

/**
 * @param containerWidth - actual pixel width of the session area container.
 *   Used by auto mode to decide the panel count from available space (not viewport).
 */
export function useSessionPanelMode(containerWidth = 0) {
  const [mode, setModeState] = useState<SessionPanelMode>(() => cachedMode ?? FALLBACK_MODE);
  // False until we have a real value. Until then `mode` is the '2' FALLBACK, which
  // is indistinguishable from a real '2' — so a caller that acts destructively on
  // it (the column-eviction effect) would trim a 3rd restored column to 2 before
  // the user's actual '3' arrives, then never bring it back. Callers must gate
  // irreversible work on this flag, not on `mode` alone.
  const [loaded, setLoaded] = useState(cachedMode !== null);
  const lastSelfChangeRef = useRef(0);

  /**
   * Accept a value pushed by a SIBLING instance (see modeListeners).
   *
   * Also stamps `lastSelfChangeRef` and flips `loaded`: this tab caused the change, so
   * the `config:changed` echo about to arrive is our own and must not trigger a
   * refetch — and a value known good enough to render is by definition loaded, so a
   * sibling's pick must not leave this instance gated as "still waiting".
   */
  const receiveMode = useCallback((m: SessionPanelMode) => {
    lastSelfChangeRef.current = Date.now();
    setModeState(m);
    setLoaded(true);
  }, []);
  const receiveModeRef = useRef(receiveMode);
  receiveModeRef.current = receiveMode;

  const adopt = useCallback((v: unknown) => {
    if (!isValidMode(v)) return;
    cachedMode = v;
    setModeState(v);
  }, []);

  // Subscribe via a stable wrapper: the Set is keyed by identity, so registering
  // `receiveMode` itself would re-subscribe on every render that changes it.
  useEffect(() => {
    const listener = (m: SessionPanelMode) => receiveModeRef.current(m);
    modeListeners.add(listener);
    return () => { modeListeners.delete(listener); };
  }, []);

  // Fetch from config on mount. Still re-fetches even with a cached value: the
  // cache removes the fallback FLICKER, it is not the source of truth (config can
  // change in another tab or on disk while the SPA stays loaded).
  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then(c => { if (!cancelled) adopt(c.ui?.session_panels); })
      .catch(() => { /* keep whatever we already have */ })
      // Settled either way: an unreachable config must not wedge callers waiting
      // forever for a setting that is never coming.
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [adopt]);

  // Sync when UI config changes (from other tabs/sources)
  useEvent('config:changed', useCallback((data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'ui') return;
    if (Date.now() - lastSelfChangeRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchConfig().then(c => adopt(c.ui?.session_panels)).catch(() => {});
  }, [adopt]));

  const setMode = useCallback((m: SessionPanelMode) => {
    // Local echo first (this instance + every sibling), then persist. The layout must
    // react to the click, not to the config round-trip that follows it.
    setModeState(m);
    setLoaded(true);
    broadcastMode(m);
    lastSelfChangeRef.current = Date.now();
    // Merge into existing ui block so sibling keys (e.g. bump_pinned_on_chat) survive —
    // updateConfig replaces the whole `ui` object, not individual sub-keys.
    fetchConfig()
      .then(c => updateConfig({ ui: { ...c.ui, session_panels: m } }))
      .catch(() => {});
  }, []);

  // An explicit count wins; 'auto' (and any value that failed validation on the
  // way in) falls back to the width breakpoints.
  const explicitCount = panelCountOf(mode);
  const effectiveMaxPanels: number =
    explicitCount ??
    (containerWidth >= AUTO_MIN_WIDTH_FOR_THREE ? 3 :
     containerWidth >= AUTO_MIN_WIDTH_FOR_TWO ? 2 : 1);

  return { mode, setMode, effectiveMaxPanels, loaded } as const;
}
