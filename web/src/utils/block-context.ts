/**
 * What else happened during a main-thread block that no traced callback or phase
 * explains, for the main-thread tracer's report: which components drew, how many DOM
 * mutations landed, whether the window had focus, and how long since the user's last
 * input. All of it is counted cheaply as it happens and read once per 100ms sample:
 *  - draws: `countRender` in render-count.ts (one counter add per draw);
 *  - DOM mutations: one MutationObserver on the document that only adds
 *    `records.length` (no per-node work; attribute changes are left out, the noisiest
 *    and least telling kind);
 *  - input: one passive capture listener per input kind that stores a timestamp.
 * Promise continuations are not bracketed: native `await` never calls a patched
 * `then`, so timing them would need an engine hook we do not have.
 */
import { takeDrawsSinceLastTake } from './render-count';

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const TOP_DRAWS = 3;

let installedOn: unknown = null;
let lastInput = -Infinity;
let mutations = 0;

export function installBlockContext(): void {
  if (typeof window === 'undefined' || installedOn === window) return;
  installedOn = window;
  try {
    const onInput = (): void => { lastInput = performance.now(); };
    for (const type of INPUT_EVENTS) {
      window.addEventListener?.(type, onInput, { capture: true, passive: true });
    }
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (typeof MutationObserver === 'function' && root) {
      new MutationObserver((records) => { mutations += records.length; })
        .observe(root, { childList: true, characterData: true, subtree: true });
    }
  } catch { /* attribution is best-effort */ }
}

/** performance.now() of the user's last input, or -Infinity. */
export function lastInputAt(): number {
  return lastInput;
}

export interface TickWindow { draws: Record<string, number> | null; mutations: number }

/** What was counted since the previous sample; resets the counts. */
export function takeTickWindow(): TickWindow {
  const taken = { draws: takeDrawsSinceLastTake(), mutations };
  mutations = 0;
  return taken;
}

/** The report fields for a block nothing traced explains. Small: a few short values. */
export function describeUntracedBlock(win: TickWindow, now: number): Record<string, unknown> {
  const draws = win.draws
    ? Object.entries(win.draws)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_DRAWS)
      .map(([name, n]) => `${name}:${n}`)
      .join(' ')
    : undefined;
  let focused: boolean | undefined;
  try { focused = typeof document.hasFocus === 'function' ? document.hasFocus() : undefined; } catch { /* no document */ }
  return {
    draws,
    domMutations: win.mutations,
    focused,
    sinceInputMs: Number.isFinite(lastInput) ? Math.round(now - lastInput) : undefined,
  };
}
