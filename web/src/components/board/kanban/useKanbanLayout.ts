/**
 * The kanban's layout state (spec 3.0 to 3.2, 7.4): the pane's own width
 * (ResizeObserver, not the window) picks wide or narrow with a 24px
 * hysteresis (narrow below 600, wide again from 624); the narrow sections'
 * folds (localStorage per owner, narrow only; a filter unfolds the sections
 * with matches and folds the rest without storing it); the wide done rails
 * that were opened and the done lanes showing all their cards (sessionStorage
 * per owner, this visit only).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardLaneKind } from '../../../../../src/core/boards/board-lanes';
import { KANBAN_NARROW_BELOW, KANBAN_WIDE_FROM, type KanbanMode } from './kanban-contract';

export const FOLDS_PREFIX = 'walnut:board-lanes-folded.v1:';
export const RAILS_PREFIX = 'walnut:board-done-rail.v1:';
export const SHOW_ALL_PREFIX = 'walnut:board-lane-show-all.v1:';

/** The mode for a width, given the mode it was in (hysteresis). */
export function modeFor(width: number, prev: KanbanMode | null): KanbanMode {
  if (width <= 0) return prev ?? 'wide';
  if (prev === 'narrow') return width >= KANBAN_WIDE_FROM ? 'wide' : 'narrow';
  if (prev === 'wide') return width < KANBAN_NARROW_BELOW ? 'narrow' : 'wide';
  return width < KANBAN_NARROW_BELOW ? 'narrow' : 'wide';
}

function storage(kind: 'local' | 'session'): Storage | null {
  try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch { return null; }
}

function readJson<T>(kind: 'local' | 'session', key: string, fallback: T): T {
  try {
    const raw = storage(kind)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}

function writeJson(kind: 'local' | 'session', key: string, value: unknown): void {
  try { storage(kind)?.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

export interface KanbanLayoutApi {
  /** Put on the element whose width decides the mode (`kanban-root`). */
  rootRef: (el: HTMLDivElement | null) => void;
  width: number;
  mode: KanbanMode;
  /** Narrow: is this section folded (a filter's auto fold included)? Wide: never. */
  isFolded(laneId: string, kind: BoardLaneKind): boolean;
  toggleFold(laneId: string, kind: BoardLaneKind): void;
  unfold(laneId: string): void;
  /** Wide: is this done lane open (else the 56px rail)? */
  isRailOpen(laneId: string): boolean;
  setRailOpen(laneId: string, open: boolean): void;
  isShowAll(laneId: string): boolean;
  setShowAll(laneId: string, all: boolean): void;
}

export interface KanbanLayoutOpts {
  /** A chip or search is on: sections unfold by matches. */
  filterActive: boolean;
  /** Cards of the lane that the filter shows. */
  matchesIn: (laneId: string) => number;
}

export function useKanbanLayout(ownerId: string, opts: KanbanLayoutOpts): KanbanLayoutApi {
  const [width, setWidth] = useState(0);
  const [mode, setMode] = useState<KanbanMode>('wide');
  const modeRef = useRef<KanbanMode | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    const measure = (w: number) => {
      const next = modeFor(w, modeRef.current);
      modeRef.current = next;
      setWidth(Math.round(w));
      setMode(next);
    };
    measure(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { for (const e of entries) measure(e.contentRect.width); });
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const [folds, setFolds] = useState<Record<string, boolean>>(() => readJson('local', FOLDS_PREFIX + ownerId, {}));
  const [rails, setRails] = useState<string[]>(() => readJson('session', RAILS_PREFIX + ownerId, []));
  const [showAll, setShowAllState] = useState<string[]>(() => readJson('session', SHOW_ALL_PREFIX + ownerId, []));
  useEffect(() => {
    setFolds(readJson('local', FOLDS_PREFIX + ownerId, {}));
    setRails(readJson('session', RAILS_PREFIX + ownerId, []));
    setShowAllState(readJson('session', SHOW_ALL_PREFIX + ownerId, []));
  }, [ownerId]);

  const o = useRef(opts);
  o.current = opts;
  const isFolded = useCallback((laneId: string, kind: BoardLaneKind) => {
    if (mode !== 'narrow') return false;
    if (o.current.filterActive) return o.current.matchesIn(laneId) === 0;
    return folds[laneId] ?? kind === 'done';
  }, [mode, folds]);
  const toggleFold = useCallback((laneId: string, kind: BoardLaneKind) => {
    setFolds((cur) => {
      const next = { ...cur, [laneId]: !(cur[laneId] ?? kind === 'done') };
      writeJson('local', FOLDS_PREFIX + ownerId, next);
      return next;
    });
  }, [ownerId]);
  const unfold = useCallback((laneId: string) => {
    setFolds((cur) => {
      if (cur[laneId] === false) return cur;
      const next = { ...cur, [laneId]: false };
      writeJson('local', FOLDS_PREFIX + ownerId, next);
      return next;
    });
  }, [ownerId]);
  const isRailOpen = useCallback((laneId: string) => rails.includes(laneId)
    || (o.current.filterActive && o.current.matchesIn(laneId) > 0), [rails]);
  const setRailOpen = useCallback((laneId: string, open: boolean) => {
    setRails((cur) => {
      const next = open ? [...new Set([...cur, laneId])] : cur.filter((x) => x !== laneId);
      writeJson('session', RAILS_PREFIX + ownerId, next);
      return next;
    });
  }, [ownerId]);
  const isShowAll = useCallback((laneId: string) => showAll.includes(laneId), [showAll]);
  const setShowAll = useCallback((laneId: string, all: boolean) => {
    setShowAllState((cur) => {
      const next = all ? [...new Set([...cur, laneId])] : cur.filter((x) => x !== laneId);
      writeJson('session', SHOW_ALL_PREFIX + ownerId, next);
      return next;
    });
  }, [ownerId]);

  return { rootRef, width, mode, isFolded, toggleFold, unfold, isRailOpen, setRailOpen, isShowAll, setShowAll };
}
