// The roll-up a session column plays when its task is completed from the column header:
// the body rolls up into the header strip (a clip-path, so nothing reflows and the chat is
// never laid out again), and the caller then closes the column the ordinary way, where the
// sessions area's own removal fades the strip and slides the neighbours in.

/** The ring's tick is read before the column moves (also the window in which a refused
 *  completion rolls back, so a refusal never costs the person a column). */
export const ROLL_UP_TICK_MS = 400;
/** Picked by the user from ten candidates, at half the speed of the first draft. */
export const ROLL_UP_MS = 890;
const ROLL_UP_EASING = 'cubic-bezier(0.65, 0, 0.25, 1)';

export interface RollUp {
  /** true: the strip was reached; false: cancelled first. Settles once. */
  finished: Promise<boolean>;
  /** Give the column back exactly as it was. Safe to call after the end. */
  cancel: () => void;
  /** Stop where it is and keep the clip on the node, for a column that is about to be
   *  removed: the removal's fade re-inserts this very node, and clearing the clip would
   *  show it whole again for that fade. */
  freeze: () => void;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The two clips of the roll: the whole column, then only the top `keep` pixels. */
export function rollUpClips(height: number, keep: number): { from: string; to: string } {
  const strip = Math.min(Math.max(Math.ceil(keep), 0), Math.max(Math.floor(height), 0));
  return {
    from: 'inset(0px 0px 0px 0px)',
    to: `inset(0px 0px ${Math.max(Math.floor(height) - strip, 0)}px 0px)`,
  };
}

/** Roll `col` up into its header. null when there is no header to roll into (the caller
 *  then just closes the column). */
export function rollUpColumn(col: HTMLElement): RollUp | null {
  const header = col.querySelector<HTMLElement>('.session-panel-header');
  if (!header) return null;
  const colRect = col.getBoundingClientRect();
  if (colRect.height <= 0) return null;
  const { from, to } = rollUpClips(colRect.height, header.getBoundingClientRect().bottom - colRect.top + 1);

  col.dataset.rollingUp = 'true';
  const anim = col.animate([{ clipPath: from }, { clipPath: to }], {
    duration: ROLL_UP_MS,
    easing: ROLL_UP_EASING,
    fill: 'forwards',
  });

  let settle: (reached: boolean) => void = () => {};
  const finished = new Promise<boolean>((resolve) => { settle = resolve; });
  anim.onfinish = () => {
    // Hold the strip on the element itself: the removal that follows re-inserts this very
    // node to fade it out, and an animation effect is not what should keep it clipped then.
    col.style.clipPath = to;
    settle(true);
    anim.cancel();
  };
  const cancel = () => {
    settle(false);
    anim.cancel();
    col.style.clipPath = '';
    delete col.dataset.rollingUp;
  };
  const freeze = () => {
    settle(false);
    // Read the running clip before the animation goes: once it is cancelled the node is whole.
    const now = anim.playState === 'finished' ? to : getComputedStyle(col).clipPath;
    anim.cancel();
    col.style.clipPath = now;
  };
  return { finished, cancel, freeze };
}
