/**
 * The tree drawer's left-edge hover entry (spec 6.1, C63): an 8px band inside
 * the panel's left edge that opens the drawer in `peek` after a 300ms dwell.
 *
 * The band never takes layout width and never takes pointer events (a click or
 * a text drag starting at the edge still reaches the transcript): everything is
 * pointer geometry, sampled at most once per animation frame.
 *
 * It ARMS only on an entry from inside this panel's own content: the pointer
 * position just before it crossed into the band must lie inside the panel rect
 * and right of the band. So sweeping in from the left neighbour's scrollbar,
 * the sidebar or the chat slot never opens it. It also stays unarmed while any
 * button is pressed (a drag), while the Pin / Ask selection pill is up, and
 * over the outline rail's box. Leaving the band cancels the dwell.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export const EDGE_BAND_PX = 8;
export const EDGE_DWELL_MS = 300;
const RAIL_SELECTOR = '[data-thread-rail], .session-toc';
const SELECTION_PILL_SELECTOR = '.quote-pin-pill';

export interface EdgePoint { x: number; y: number }
export interface EdgeRect { left: number; top: number; right: number; bottom: number }

const inside = (p: EdgePoint, r: EdgeRect) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

/**
 * Pure arm rule. `prev` is the last sampled position before the pointer reached
 * the band; `panel` the panel rect; `band` the band rect; `rail` the outline
 * rail's rect when it is laid out.
 */
export function shouldArmEdge(input: {
  prev: EdgePoint | null;
  now: EdgePoint;
  panel: EdgeRect;
  band: EdgeRect;
  rail?: EdgeRect | null;
  buttons: number;
  selectionPill: boolean;
}): boolean {
  const { prev, now, panel, band, rail } = input;
  if (!prev || input.buttons !== 0 || input.selectionPill) return false;
  if (!inside(now, band)) return false;
  if (rail && inside(now, { ...rail, left: rail.left - 1, right: rail.right + 1 })) return false;
  // Came from this panel's content: inside the panel and right of the band.
  return inside(prev, panel) && prev.x > band.right;
}

export interface DrawerEdgePeekArgs {
  panelRef: RefObject<HTMLElement | null>;
  /** The drawer is closed and the session has questions. */
  enabled: boolean;
  onPeek: () => void;
  dwellMs?: number;
}

export interface DrawerEdgePeek {
  edgeRef: (el: HTMLDivElement | null) => void;
  armed: boolean;
}

export function useDrawerEdgePeek({ panelRef, enabled, onPeek, dwellMs = EDGE_DWELL_MS }: DrawerEdgePeekArgs): DrawerEdgePeek {
  const [armed, setArmed] = useState(false);
  const edgeEl = useRef<HTMLDivElement | null>(null);
  const onPeekRef = useRef(onPeek);
  onPeekRef.current = onPeek;
  const edgeRef = useCallback((el: HTMLDivElement | null) => { edgeEl.current = el; }, []);

  useEffect(() => {
    if (!enabled) { setArmed(false); return; }
    let prev: EdgePoint | null = null;
    let latest: { p: EdgePoint; buttons: number } | null = null;
    let inBand = false;
    let isArmed = false;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (isArmed) { isArmed = false; setArmed(false); }
    };
    const sample = () => {
      frame = 0;
      const panel = panelRef.current;
      const band = edgeEl.current;
      if (!latest || !panel || !band) return;
      const { p, buttons } = latest;
      const pr = panel.getBoundingClientRect();
      const br = band.getBoundingClientRect();
      const nowIn = inside(p, br);
      if (nowIn && !inBand) {
        const railEl = panel.querySelector(RAIL_SELECTOR);
        const rail = railEl ? railEl.getBoundingClientRect() : null;
        const arm = shouldArmEdge({
          prev, now: p, panel: pr, band: br, rail: rail && rail.width > 0 ? rail : null, buttons,
          selectionPill: document.querySelector(SELECTION_PILL_SELECTOR) !== null,
        });
        if (arm) {
          isArmed = true;
          setArmed(true);
          timer = setTimeout(() => { timer = null; if (isArmed) onPeekRef.current(); }, dwellMs);
        }
      } else if (!nowIn && inBand) {
        disarm();
      } else if (nowIn && isArmed && buttons !== 0) {
        disarm();
      }
      inBand = nowIn;
      prev = p;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      latest = { p: { x: e.clientX, y: e.clientY }, buttons: e.buttons };
      if (!frame) frame = requestAnimationFrame(sample);
    };
    document.addEventListener('pointermove', onMove, { passive: true, capture: true });
    return () => {
      document.removeEventListener('pointermove', onMove, { capture: true });
      if (frame) cancelAnimationFrame(frame);
      disarm();
    };
  }, [enabled, panelRef, dwellMs]);

  return { edgeRef, armed };
}
