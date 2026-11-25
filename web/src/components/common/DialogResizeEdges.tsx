/**
 * Every dialog can be made bigger or smaller (the user, 2026-11-25, by voice: "this default
 * should be bigger, and I think every pop-up window can be resized"). One layer, mounted once in
 * App, puts eight thin strips on the edges and corners of the topmost `wn-dialog` that is open:
 * drag one to resize it. A dialog the family centres grows on both sides, so the edge stays under
 * the pointer and the dialog stays centred. The size is kept per kind of dialog
 * (utils/dialog-size.ts) and the dialog opens at it next time; a double click on an edge forgets
 * it. Escape during a drag puts back the size from before it. Not on a phone, where a dialog is
 * the whole screen. Every `wn-dialog` gets it by construction, so a new dialog needs nothing
 * (tests/web/dialog-resize.test.ts, tests/e2e/browser/dialog-resize.spec.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDragGesture } from '@/hooks/useDragGesture';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { applyDialogSize, clampDialogSize, dialogKind, keepDialogSize, storedDialogSize, DIALOG_WINDOW_GAP, type DialogSize } from '@/utils/dialog-size';
import '@/styles/dialog-resize.css';

type Side = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const SIDES: Side[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** The newest dialog panel on screen: dialogs portal into <body> in the order they open. */
function topDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('.wn-dialog');
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const el = all[i];
    if (el.closest('[data-no-dialog-resize]')) continue;
    if (el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden') return el;
  }
  return null;
}

/** The panel's box, and on each axis whether it sits in the middle of its layer (then it grows on
 *  both sides) or is anchored at its top or left (then only its far edges move it). */
interface Box { left: number; top: number; width: number; height: number; cx: boolean; cy: boolean }
const sameBox = (a: Box | null, b: Box | null) => a === b || (!!a && !!b
  && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.cx === b.cx && a.cy === b.cy);
function boxOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  const layer = el.parentElement?.getBoundingClientRect();
  const mid = (a: number, b: number, c: number, d: number) => Math.abs((a + b) / 2 - (c + d) / 2) < 3;
  return {
    left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height),
    cx: !!layer && mid(r.left, r.right, layer.left, layer.right),
    cy: !!layer && mid(r.top, r.bottom, layer.top, layer.bottom),
  };
}

/** The size set inline on the panel now (a kept or dragged one), per dimension. */
function inlineSize(el: HTMLElement): DialogSize {
  const px = (v: string) => (v.endsWith('px') ? Number.parseFloat(v) : undefined);
  return { w: px(el.style.width), h: px(el.style.height) };
}

function Edge({ side, dialog, box }: { side: Side; dialog: HTMLElement; box: Box }) {
  const start = useRef<{ w: number; h: number; kx: number; ky: number; room: { width: number; height: number }; inline: DialogSize; kind: string | null } | null>(null);
  const now = useRef<DialogSize>({});
  const horiz = side.includes('e') || side.includes('w');
  const vert = side.includes('n') || side.includes('s');
  const drag = useDragGesture({
    cursor: CURSOR[side],
    onStart: () => {
      const r = dialog.getBoundingClientRect();
      const b = boxOf(dialog);
      // A centred panel may fill the window less its gap on each side; an anchored one only the
      // room from where it starts.
      const room = {
        width: b.cx ? window.innerWidth : window.innerWidth - r.left + DIALOG_WINDOW_GAP,
        height: b.cy ? window.innerHeight : window.innerHeight - r.top + DIALOG_WINDOW_GAP,
      };
      start.current = { w: r.width, h: r.height, kx: b.cx ? 2 : 1, ky: b.cy ? 2 : 1, room, inline: inlineSize(dialog), kind: dialogKind(dialog) };
      now.current = {};
    },
    onMove: ({ dx, dy }) => {
      const s = start.current;
      if (!s) return;
      const size: DialogSize = {};
      if (horiz) size.w = s.w + (side.includes('e') ? 1 : -1) * s.kx * dx;
      if (vert) size.h = s.h + (side.includes('s') ? 1 : -1) * s.ky * dy;
      const fit = clampDialogSize(size, s.room);
      now.current = fit;
      // The other dimension keeps what the panel has now (its own CSS, or a size set before).
      applyDialogSize(dialog, { w: fit.w ?? s.inline.w, h: fit.h ?? s.inline.h });
    },
    onEnd: ({ canceled }) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const moved = (now.current.w !== undefined && Math.abs(now.current.w - s.w) >= 1)
        || (now.current.h !== undefined && Math.abs(now.current.h - s.h) >= 1);
      // A click, or Escape: exactly what the panel had before the press.
      if (canceled || !moved) { applyDialogSize(dialog, s.inline); return; }
      if (s.kind) keepDialogSize(s.kind, now.current);
    },
  });
  const reset = () => {
    const kind = dialogKind(dialog);
    if (kind) keepDialogSize(kind, null);
    applyDialogSize(dialog, null);
  };
  const T = 9; // the strip: 6 px outside the panel's edge, 3 px over it
  const C = 16; // a corner's square
  const style: React.CSSProperties = {};
  if (side === 'n' || side === 's') Object.assign(style, { left: box.left + C / 2, width: Math.max(0, box.width - C), height: T });
  if (side === 'e' || side === 'w') Object.assign(style, { top: box.top + C / 2, height: Math.max(0, box.height - C), width: T });
  if (side === 'n') style.top = box.top - 6;
  if (side === 's') style.top = box.top + box.height - 3;
  if (side === 'w') style.left = box.left - 6;
  if (side === 'e') style.left = box.left + box.width - 3;
  if (side.length === 2) {
    Object.assign(style, { width: C, height: C });
    style.top = side[0] === 'n' ? box.top - 6 : box.top + box.height - C + 6;
    style.left = side[1] === 'w' ? box.left - 6 : box.left + box.width - C + 6;
  }
  return (
    <div
      className={`dialog-resize-edge dialog-resize-edge--${side}${drag.isDragging ? ' is-dragging' : ''}`}
      data-dialog-resize-edge={side}
      data-testid={`dialog-resize-${side}`}
      aria-hidden="true"
      title="Drag to resize; double click for the default size"
      style={style}
      onPointerDown={drag.onPointerDown}
      onDoubleClick={reset}
    />
  );
}

const CURSOR: Record<Side, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

/** Mounted once in App: the edges of the topmost dialog, and a kept size on each dialog that opens. */
export function DialogResizeEdges() {
  const phone = usePhoneLayout();
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const sized = useRef(new WeakSet<HTMLElement>());
  // Each dialog gets its own layer, appended after it: a dialog opened over another is portalled
  // later into <body>, and the same layer token would leave the old strips under its scrim.
  const ids = useRef(new WeakMap<HTMLElement, number>());
  const nextId = useRef(0);

  useEffect(() => {
    if (phone) { setDialog(null); return; }
    let frame = 0;
    let still = 0;
    let watched: HTMLElement | null = null;
    let last: Box | null = null;
    const ro = new ResizeObserver(() => wake());
    const look = () => {
      frame = 0;
      const top = topDialog();
      // A dialog that just opened takes the size kept for its kind, fitted to this window.
      if (top && !sized.current.has(top)) {
        sized.current.add(top);
        const kind = dialogKind(top);
        const kept = kind ? storedDialogSize(kind) : null;
        if (kept) applyDialogSize(top, clampDialogSize(kept, { width: window.innerWidth, height: window.innerHeight }));
      }
      if (top !== watched) {
        if (watched) ro.unobserve(watched);
        if (top) ro.observe(top);
        watched = top;
      }
      setDialog((d) => (d === top ? d : top));
      const next = top ? boxOf(top) : null;
      const changed = !sameBox(last, next);
      if (changed) { last = next; setBox(next); }
      // While it moves (it animates in, its content grows) its box is followed every frame, then
      // the observers wake it again.
      still = changed ? 0 : still + 1;
      if (top && still < 20) frame = requestAnimationFrame(look);
    };
    const wake = () => { still = 0; if (!frame) frame = requestAnimationFrame(look); };
    const mo = new MutationObserver(wake);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    window.addEventListener('resize', wake);
    wake();
    return () => {
      mo.disconnect(); ro.disconnect();
      window.removeEventListener('resize', wake);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [phone]);

  if (phone || !dialog || !box) return null;
  let id = ids.current.get(dialog);
  if (id === undefined) { id = nextId.current += 1; ids.current.set(dialog, id); }
  // An anchored axis (a panel pinned at its top, say) moves only by its far edge.
  const sides = SIDES.filter((s) => (box.cx || !s.includes('w')) && (box.cy || !s.includes('n')));
  return createPortal(
    <div className="dialog-resize-layer" key={id}>
      {sides.map((side) => <Edge key={side} side={side} dialog={dialog} box={box} />)}
    </div>,
    document.body,
    String(id),
  );
}
