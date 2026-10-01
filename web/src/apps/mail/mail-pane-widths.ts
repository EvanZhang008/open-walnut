/**
 * The widths of the Mail console's two left columns (the folders and the message list), as the person
 * dragged them.
 *
 * Only a dragged width is stored. A column nobody dragged follows the stylesheet's defaults, which
 * change at the 1360px breakpoint, so a stored width must never stand in for "the default" or that
 * breakpoint would stop working for everyone who once double-clicked a splitter.
 *
 * The bounds are applied twice: here, when a drag or a key moves a column (so the stored number is
 * always one the layout can honour), and in mail.css, which caps the list so the reader keeps
 * `READER_MIN` when the window later gets narrower than it was when the person dragged.
 *
 * In `localStorage` for the same reason as `mail-sidebar-prefs.ts`: it is nobody's server answer, and
 * every access is guarded, so a private window or a full quota reads as "no widths", the default view.
 */
import type { CSSProperties } from 'react';

export const PANE_WIDTHS_KEY = 'walnut.mail.panes.v1';

export type MailPaneId = 'accounts' | 'list';

export const PANE_BOUNDS: Record<MailPaneId, { min: number; max: number }> = {
  accounts: { min: 168, max: 360 },
  list: { min: 260, max: 760 },
};

/** The reader never gets narrower than this from a drag (mail.css keeps the same floor). */
export const READER_MIN = 380;

/** One arrow key press. */
export const PANE_KEY_STEP = 16;

export type PaneWidths = Partial<Record<MailPaneId, number>>;

/** The stored widths, each re-clamped; anything unreadable is simply absent. Never throws. */
export function readPaneWidths(): PaneWidths {
  try {
    const text = window.localStorage.getItem(PANE_WIDTHS_KEY);
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PaneWidths = {};
    for (const id of ['accounts', 'list'] as MailPaneId[]) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = clampPane(id, value);
    }
    return out;
  } catch {
    return {};
  }
}

export function writePaneWidths(widths: PaneWidths): void {
  try {
    const kept: PaneWidths = {};
    for (const id of ['accounts', 'list'] as MailPaneId[]) {
      if (typeof widths[id] === 'number') kept[id] = Math.round(widths[id]!);
    }
    if (Object.keys(kept).length === 0) window.localStorage.removeItem(PANE_WIDTHS_KEY);
    else window.localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(kept));
  } catch { /* a width is never worth an error */ }
}

/**
 * A column width inside its bounds. With `room` (the console's width minus the OTHER column), the
 * column also stops where the reader would drop under `READER_MIN`; the minimum always wins, so a
 * console too narrow for both floors gives the column its minimum and lets the reader have the rest.
 */
export function clampPane(id: MailPaneId, width: number, room?: number): number {
  const { min, max } = PANE_BOUNDS[id];
  const cap = room === undefined ? max : Math.min(max, room - READER_MIN);
  return Math.round(Math.max(min, Math.min(cap, width)));
}

/** The console's inline style: a custom property per dragged column (mail.css reads them). */
export function paneStyle(widths: PaneWidths): CSSProperties {
  const style: Record<string, string> = {};
  if (typeof widths.accounts === 'number') style['--mail-accounts-w'] = `${widths.accounts}px`;
  if (typeof widths.list === 'number') style['--mail-list-w'] = `${widths.list}px`;
  return style as CSSProperties;
}
