/**
 * The size a person dragged a dialog to (DialogResizeEdges.tsx): kept per kind of dialog, so the
 * file preview opens at the size it was left at, and a confirm dialog keeps its own. A kind is the
 * dialog panel's own classes (`file-viewer-panel file-viewer-panel-explorer`), never a family class.
 */

const KEY = 'walnut:dialog-size';
/** The smallest a dragged dialog gets, and the room it leaves the window on each side. */
export const DIALOG_MIN_WIDTH = 320;
export const DIALOG_MIN_HEIGHT = 200;
export const DIALOG_WINDOW_GAP = 8;

export interface DialogSize { w?: number; h?: number }

/**
 * The kind of a dialog panel: its own classes, less the family's, states and modifiers. All of them,
 * not the first: 21 dialogs share a base class (`app-modal shortcuts-help`), and each keeps its own size.
 */
export function dialogKind(el: Element): string | null {
  const own = Array.from(el.classList).filter((c) => !/^(wn|is|has)-/.test(c) && !c.includes('--'));
  return own.length ? own.join(' ') : null;
}

function readAll(): Record<string, DialogSize> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function storedDialogSize(kind: string): DialogSize | null {
  const s = readAll()[kind];
  if (!s || typeof s !== 'object') return null;
  const w = Number.isFinite(s.w) ? s.w : undefined;
  const h = Number.isFinite(s.h) ? s.h : undefined;
  return w === undefined && h === undefined ? null : { w, h };
}

/** Keep a dragged size (merged with what was kept before: a side edge keeps only the width). */
export function keepDialogSize(kind: string, size: DialogSize | null): void {
  try {
    const all = readAll();
    if (size === null) delete all[kind];
    else {
      // Only the dimensions dragged: a bottom edge keeps the width kept before.
      const next = { ...all[kind] };
      if (size.w !== undefined) next.w = size.w;
      if (size.h !== undefined) next.h = size.h;
      all[kind] = next;
    }
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* private browsing: the size holds for this dialog only */ }
}

/** A size that fits the window: never under the minimum, never past the window less its gap. */
export function clampDialogSize(size: DialogSize, view: { width: number; height: number }): DialogSize {
  const maxW = Math.max(DIALOG_MIN_WIDTH, view.width - 2 * DIALOG_WINDOW_GAP);
  const maxH = Math.max(DIALOG_MIN_HEIGHT, view.height - 2 * DIALOG_WINDOW_GAP);
  return {
    w: size.w === undefined ? undefined : Math.round(Math.min(maxW, Math.max(DIALOG_MIN_WIDTH, size.w))),
    h: size.h === undefined ? undefined : Math.round(Math.min(maxH, Math.max(DIALOG_MIN_HEIGHT, size.h))),
  };
}

/**
 * Put a size on a dialog panel (a dimension left undefined keeps the panel's own CSS). The panel's
 * own caps (max-width 900px and the like) give way to a size the person chose.
 */
export function applyDialogSize(el: HTMLElement, size: DialogSize | null): void {
  const set = (prop: 'width' | 'height', v: number | undefined) => {
    const cap = prop === 'width' ? 'max-width' : 'max-height';
    const floor = prop === 'width' ? 'min-width' : 'min-height';
    if (v === undefined) {
      el.style.removeProperty(prop); el.style.removeProperty(cap); el.style.removeProperty(floor);
    } else {
      el.style.setProperty(prop, `${v}px`); el.style.setProperty(cap, 'none'); el.style.setProperty(floor, '0px');
    }
  };
  set('width', size?.w);
  set('height', size?.h);
  if (size && (size.w !== undefined || size.h !== undefined)) {
    el.style.setProperty('flex', 'none');
    el.setAttribute('data-dialog-sized', '');
  } else {
    el.style.removeProperty('flex');
    el.removeAttribute('data-dialog-sized');
  }
}
