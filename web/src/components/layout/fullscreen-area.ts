/**
 * Where a full screen sheet's area starts: `--fullscreen-left` on `<html>`, written only
 * while a sheet that reads it is on screen.
 *
 * 2026-11-22, the user, in the Mac app: "the sidebar is extremely laggy when I open and
 * close it, and many animations feel laggy." Measured in the system WebKit on the page he
 * had open: ONE write of this variable cost 57 ms on Home and 96 ms on Org. A custom
 * property on the root is inherited by every element, so changing it restyles the whole
 * document. The shell wrote it from a ResizeObserver on every change of the page area: on
 * each frame of the sidebar's slide (a 250 ms slide drew 3 frames), on each frame of a side
 * bar's width drag, and once for every side bar that opened or closed. Nothing read the value
 * unless a sheet was full screen.
 *
 * So the edge is measured and written when a reader asks for it: a sheet retains the area
 * while it shows (`useFullscreenArea`), which writes the current edge before its first paint
 * and keeps it current until the sheet leaves. With no reader a move of the page area costs
 * nothing. A write of a value already there is skipped.
 *
 * Every rule that reads the variable belongs to a component that retains the area:
 * tests/web/layout-animation-guard.test.ts lists them and fails on a reader that is not there.
 */
import { useLayoutEffect } from 'react';

export const FULLSCREEN_LEFT_VAR = '--fullscreen-left';

export interface FullscreenArea {
  /**
   * The shell says how to measure the edge. `settle` runs before each measure: it ends a
   * slide of the page under way, whose transform would be measured as the edge and would
   * carry a sheet fixed to the window along. Returns the unbind.
   */
  bind(read: () => number, settle?: () => void): () => void;
  /** The page area moved (sidebar, side bar, window). Free unless a sheet is on screen. */
  moved(): void;
  /** A sheet is on screen: write the edge now and keep it current. Returns the release. */
  retain(): () => void;
  /** A sheet that reads the edge is on screen. */
  inUse(): boolean;
}

export function createFullscreenArea(write: (value: string) => void): FullscreenArea {
  let read: (() => number) | null = null;
  let settle: (() => void) | undefined;
  let readers = 0;
  let written: string | null = null;
  const publish = (): void => {
    if (!read) return;
    settle?.();
    const value = `${read()}px`;
    if (value === written) return;
    written = value;
    write(value);
  };
  return {
    bind(next, nextSettle) {
      read = next;
      settle = nextSettle;
      if (readers > 0) publish();
      return () => { if (read === next) { read = null; settle = undefined; } };
    },
    moved() { if (readers > 0) publish(); },
    retain() {
      readers += 1;
      publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        readers -= 1;
      };
    },
    inUse: () => readers > 0,
  };
}

export const fullscreenArea = createFullscreenArea((value) => {
  document.documentElement.style.setProperty(FULLSCREEN_LEFT_VAR, value);
});

/** Call from every component whose full screen rule reads `--fullscreen-left`. */
export function useFullscreenArea(active: boolean): void {
  useLayoutEffect(() => (active ? fullscreenArea.retain() : undefined), [active]);
}
