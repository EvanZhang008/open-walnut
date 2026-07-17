/**
 * Crash-loop self-healing for the SPA.
 *
 * React 19 unmounts the whole root on an uncaught render error → blank page.
 * Worse, the state that triggered the crash is often PERSISTED (sessionStorage
 * restore of the focused task / session columns, `?task=` URL params written
 * back by useUrlSync, server-synced layout prefs), so every reload crashes
 * again — a permanent blank page that even a server restart cannot fix.
 *
 * This module records render crashes in sessionStorage and progressively
 * clears the persisted UI state that reproduces them:
 *
 *   crash 1 (within window) → no auto action; AppErrorBoundary shows recover UI
 *   crash 2                 → SOFT heal: clear sessionStorage + URL params, reload
 *   crash 3                 → HARD heal: also clear walnut layout keys from
 *                             localStorage (through the instance methods, so the
 *                             ui-prefs sync layer pushes delete tombstones and a
 *                             poisoned server copy dies too) and skip the server
 *                             prefs merge for one boot, then reload
 *   crash 4+                → give up auto-healing (never reload-loop); the
 *                             recover UI stays up with a manual reset button
 */

const CRASH_LOG_KEY = 'open-walnut-crash-log';
/** Read by initUiPrefsSync: when set, skip adopting server prefs for one boot. */
export const SKIP_PREFS_MERGE_FLAG = 'open-walnut-skip-prefs-merge';
const CRASH_WINDOW_MS = 60_000;

const LOCAL_KEY_PREFIXES = ['open-walnut-', 'walnut-todo-'];

export type HealAction = 'none' | 'soft' | 'hard' | 'give-up';

interface StorageDeps {
  session: Storage;
  local: Storage;
  now: () => number;
}

function resolveDeps(deps?: Partial<StorageDeps>): StorageDeps {
  return {
    session: deps?.session ?? window.sessionStorage,
    local: deps?.local ?? window.localStorage,
    now: deps?.now ?? Date.now,
  };
}

/** Record one crash and decide how aggressively to heal. Never throws. */
export function recordCrash(deps?: Partial<StorageDeps>): HealAction {
  const { session, now } = resolveDeps(deps);
  let log: number[] = [];
  try {
    const parsed = JSON.parse(session.getItem(CRASH_LOG_KEY) ?? '[]');
    if (Array.isArray(parsed)) log = parsed.filter((t): t is number => typeof t === 'number');
  } catch { /* corrupt — start fresh */ }
  const t = now();
  log = log.filter((prev) => t - prev < CRASH_WINDOW_MS);
  log.push(t);
  try { session.setItem(CRASH_LOG_KEY, JSON.stringify(log)); } catch { /* quota */ }
  if (log.length <= 1) return 'none';
  if (log.length === 2) return 'soft';
  if (log.length === 3) return 'hard';
  return 'give-up';
}

/**
 * Clear the persisted UI state that re-triggers a crash on every load.
 * - session: everything except the crash log (it must survive to escalate,
 *   and to stop the loop at give-up).
 * - hard also removes walnut layout keys from localStorage. Deliberately via
 *   the (possibly monkey-patched) instance methods: the ui-prefs sync layer
 *   then records delete tombstones, so a poisoned server-synced pref cannot
 *   come straight back on the next boot. Layout prefs are cosmetic — losing
 *   them beats a permanently blank page.
 * Never touches non-walnut keys (device tokens, drafts live outside the
 * cleared prefixes).
 */
export function clearPersistedUiState(hard: boolean, deps?: Partial<StorageDeps>): void {
  const { session, local } = resolveDeps(deps);
  let keep: string | null = null;
  try { keep = session.getItem(CRASH_LOG_KEY); } catch { /* ignore */ }
  try { session.clear(); } catch { /* ignore */ }
  if (keep !== null) {
    try { session.setItem(CRASH_LOG_KEY, keep); } catch { /* ignore */ }
  }
  if (!hard) return;
  const doomed: string[] = [];
  try {
    for (let i = 0; i < local.length; i++) {
      const k = local.key(i);
      if (k && k !== SKIP_PREFS_MERGE_FLAG && LOCAL_KEY_PREFIXES.some((p) => k.startsWith(p))) {
        doomed.push(k);
      }
    }
  } catch { /* ignore */ }
  for (const k of doomed) {
    try { local.removeItem(k); } catch { /* ignore */ }
  }
  // Belt-and-braces: the tombstone flush above rides pagehide keepalive and can
  // lose the race with the next page load's GET — skip that one merge entirely.
  try { session.setItem(SKIP_PREFS_MERGE_FLAG, '1'); } catch { /* ignore */ }
}

/**
 * One-stop handler for a fatal render error: record the crash and, on a
 * repeat, clear poisoned state and reload at a clean URL. Returns true when a
 * reload was initiated (caller should render nothing), false when the caller
 * should show its recover UI (first crash, or give-up after repeated heals).
 */
export function maybeSelfHeal(): boolean {
  let action: HealAction = 'none';
  try { action = recordCrash(); } catch { return false; }
  if (action !== 'soft' && action !== 'hard') return false;
  try {
    console.error(`[crash-recovery] repeated render crash — ${action} heal: clearing persisted UI state and reloading`);
    clearPersistedUiState(action === 'hard');
  } catch { /* still reload — a clean URL alone may break the loop */ }
  // replace('/') both strips poisoned ?task=/?s1= params and reloads.
  window.location.replace('/');
  return true;
}

/** Manual "factory reset" for the recover UI's last-resort button. */
export function resetUiStateAndReload(): void {
  try { clearPersistedUiState(true); } catch { /* ignore */ }
  try { window.sessionStorage.removeItem(CRASH_LOG_KEY); } catch { /* ignore */ }
  window.location.replace('/');
}
