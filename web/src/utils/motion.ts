/**
 * How much the app moves (styles/motion.css), written once on <html> as `data-motion`, again only
 * when the system's Reduce Motion setting changes (never from a path that runs while the page
 * moves: an attribute on the root restyles the document):
 *
 *  - `full`: everything in motion.css;
 *  - `reduced`, when the system asks for it (`prefers-reduced-motion: reduce`): the fades stay, as
 *    in Apple's own apps, and nothing grows, slides or lingers on its way out;
 *  - `off`, in a browser under automation (`navigator.webdriver`, every Playwright run): nothing
 *    moves. A spec that measures a menu or reads its pixels the moment it opens must get its
 *    resting box and colour, not one 96 % grown and half faded, and a closing menu's fading copy
 *    (overlay-exit.ts) must not be found as a second menu. A spec or a proof recording that means
 *    to see the motion sets `localStorage['walnut.motion'] = 'full'` before the page loads.
 */
export type MotionMode = 'full' | 'reduced' | 'off';

export const MOTION_OVERRIDE_KEY = 'walnut.motion';

/** styles/motion.css's tokens, for motion run from script (tests/web/motion.test.ts keeps them equal). */
export const MOTION_MS = { fast: 120, base: 200, slow: 280 } as const;
export const EASE = {
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  inOut: 'cubic-bezier(0.45, 0, 0.2, 1)',
} as const;

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

export interface MotionInputs {
  reduceMotion: boolean;
  automated: boolean;
  /** `localStorage['walnut.motion']`: 'full', 'reduced' or 'off' wins over both. */
  override: string | null;
}

export function decideMotion({ reduceMotion, automated, override }: MotionInputs): MotionMode {
  if (override === 'full' || override === 'reduced' || override === 'off') return override;
  if (automated) return 'off';
  return reduceMotion ? 'reduced' : 'full';
}

function inputs(): MotionInputs {
  let reduceMotion = false;
  let override: string | null = null;
  try { reduceMotion = window.matchMedia(REDUCE_QUERY).matches; } catch { /* no matchMedia */ }
  try { override = window.localStorage.getItem(MOTION_OVERRIDE_KEY); } catch { /* storage blocked */ }
  return { reduceMotion, automated: typeof navigator !== 'undefined' && navigator.webdriver === true, override };
}

let mode: MotionMode | null = null;

/** The app's motion now. Cheap: read once, kept up to date by installMotionMode. */
export function motionMode(): MotionMode {
  if (mode === null) mode = decideMotion(inputs());
  return mode;
}

/** Grows, slides and closing fades run. */
export const fullMotion = (): boolean => motionMode() === 'full';
/** Fades run (full or reduced motion). */
export const fadesRun = (): boolean => motionMode() !== 'off';

/** At boot: write `data-motion` on <html> and follow the system setting from then on. */
export function installMotionMode(): void {
  if (typeof document === 'undefined') return;
  const apply = () => {
    mode = decideMotion(inputs());
    if (document.documentElement.dataset.motion !== mode) document.documentElement.dataset.motion = mode;
  };
  apply();
  try { window.matchMedia(REDUCE_QUERY).addEventListener('change', apply); } catch { /* no matchMedia */ }
}
