/**
 * A test window: a browser under automation (`navigator.webdriver`, so every Playwright run),
 * or a page opened with `?walnut-test-run=<label>` (kept for the tab; `=0` turns the tab off,
 * an automated one too). Its
 * requests carry `x-walnut-test-run`, so on the user's own Walnut every task and project it
 * creates is a test object: hidden from the user's board, Org and counts, and swept once idle
 * (src/core/test-run.ts). This window still sees them, unmarked, so a UI check can find what
 * it made.
 */

export const TEST_RUN_HEADER = 'x-walnut-test-run';
/** The `plugin_only` owner of a test task (TEST_RUN_OWNER in src/core/test-run.ts). */
export const TEST_RUN_OWNER = '@test-run';
const PARAM = 'walnut-test-run';
/** Stored for a tab that was turned off, so automation does not turn it back on at the next load. */
const OFF = '0';

function clean(raw: string): string {
  return raw.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60);
}

/**
 * Pure: the label for a page, given its URL, its stored label and whether automation drives it.
 * An automated window's label names its browser context (`browser`, kept in its localStorage),
 * so the layout one automated run writes stays that run's (src/core/test-run-prefs.ts) and the
 * next fresh browser opens on the user's own (2026-10-31).
 */
export function decideTestRun(
  href: string,
  stored: string | null,
  webdriver: boolean,
  browser?: string,
): { label: string | null; store: string | undefined } {
  let asked: string | null = null;
  try { asked = new URL(href).searchParams.get(PARAM); } catch { /* unreadable URL: no ask */ }
  if (asked !== null) {
    const label = clean(asked);
    // `=0` turns the tab off, an automated one too (a demo recorded for the user is real work).
    if (!label || label === '0' || label.toLowerCase() === 'false') return { label: null, store: OFF };
    return { label, store: label };
  }
  if (stored === OFF) return { label: null, store: undefined };
  if (stored) return { label: clean(stored) || null, store: undefined };
  return { label: webdriver ? (browser ? `webdriver-${browser}` : 'webdriver') : null, store: undefined };
}

let cached: string | null | undefined;

const BROWSER_KEY = 'walnut-test-run-browser';

/** This browser context's id, made once and kept in its localStorage (none when storage is blocked). */
function browserId(): string | undefined {
  try {
    let id = window.localStorage.getItem(BROWSER_KEY);
    if (!id || !/^[a-z0-9]{6,16}$/.test(id)) {
      id = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
      window.localStorage.setItem(BROWSER_KEY, id);
    }
    return id;
  } catch { return undefined; }
}

/** This window's test-run label, or null for a person's window. Decided once per page load. */
export function testRunLabel(): string | null {
  if (cached !== undefined) return cached;
  if (typeof window === 'undefined') return (cached = null);
  let stored: string | null = null;
  try { stored = window.sessionStorage.getItem(PARAM); } catch { /* storage blocked */ }
  const webdriver = typeof navigator !== 'undefined' && navigator.webdriver === true;
  const { label, store } = decideTestRun(window.location.href, stored, webdriver, webdriver ? browserId() : undefined);
  try {
    if (store !== undefined) window.sessionStorage.setItem(PARAM, store);
  } catch { /* storage blocked: the label still holds for this load */ }
  return (cached = label);
}

/** A test task as this window should hold it: unmarked in a test window, as is elsewhere. */
export function forThisWindow<T extends { plugin_only?: string }>(task: T, label: string | null = testRunLabel()): T {
  if (!label || task.plugin_only !== TEST_RUN_OWNER) return task;
  const { plugin_only: _owner, ...rest } = task;
  return rest as T;
}
