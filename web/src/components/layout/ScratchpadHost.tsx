/**
 * ONE Scratchpad for the window, wherever it shows (Home's column or another page's side bar).
 *
 * The scratchpad is one note with one save queue (useGlobalNotes: its buffer, its hash lock, its
 * debounce). Home's column and every page's side bar used to mount an editor each, so two buffers
 * and two savers held the same note: a line typed on Home whose save was still in flight, then a
 * line typed on Org, saved under the old hash, got a 409, and the reload kept only one of the two
 * (2026-11-07, review of the side bar). Now the editor is mounted ONCE, here, into a box of its
 * own, and that box is moved into the slot of the column that shows the scratchpad (`useScratchpadSlot`).
 * Moving a DOM subtree keeps the editor as it is: its unsaved words, its undo history, its save.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { GlobalNotesSection } from '@/components/notes/GlobalNotesSection';
import { useGlobalNotes } from '@/hooks/useGlobalNotes';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import { isPhoneLayout, usePhoneLayout } from '@/hooks/usePhoneLayout';
import { homePanelOpen } from '@/pages/home-panel-live';
import { setUnsavedWorkScratchpadOpener } from '@/utils/unsaved-work';
import { setSideBarPane, sideBarPageOf } from './page-side-bar';
import type { Task } from '@open-walnut/core';

/** What the column holding the scratchpad hands it: its close and its task links. */
export interface ScratchpadOwner {
  onClose: () => void;
  tasks: Task[];
  focusedTaskId?: string;
  onTaskClick: (taskId: string) => void;
}

let box: HTMLDivElement | null = null;
let owner: ScratchpadOwner | null = null;
const listeners = new Set<() => void>();

function theBox(): HTMLDivElement {
  if (!box) {
    box = document.createElement('div');
    // A flex column that fills its slot (home-navigation.css), so the editor's body scrolls.
    box.className = 'scratchpad-host';
  }
  return box;
}

/**
 * Where the box waits while no column has a slot for it (the phone layout unmounts them): hidden,
 * but in the document, so a save still under way is seen (utils/unsaved-work.ts scans the page
 * before a reload or a restart) and the editor's DOM is never detached.
 */
function park(): void {
  if (!box) return;
  let lot = document.querySelector<HTMLElement>('.scratchpad-parking');
  if (!lot) {
    lot = document.createElement('div');
    lot.className = 'scratchpad-parking';
    lot.style.display = 'none';
    document.body.appendChild(lot);
  }
  lot.appendChild(box);
}

function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const current = () => owner;

/**
 * A column's scratchpad slot. While `open`, the one editor sits in `slot` and serves `next`
 * (the slot claimed last wins, so the column the user opened it in holds it). Closed, the
 * editor stays where it is, hidden with its slot.
 */
export function useScratchpadSlot(slot: RefObject<HTMLElement | null>, open: boolean, next: ScratchpadOwner): void {
  const nextRef = useRef(next);
  nextRef.current = next;
  useLayoutEffect(() => {
    const el = slot.current;
    if (!open || !el) return;
    const b = theBox();
    if (b.parentElement !== el) el.appendChild(b);
    owner = { ...nextRef.current };
    for (const fn of [...listeners]) fn();
  }, [open, slot, next.onClose, next.onTaskClick, next.tasks, next.focusedTaskId]);
  // A slot that goes while it holds the box parks it, never takes it out of the document.
  useLayoutEffect(() => {
    const el = slot.current;
    return () => { if (box && el && box.parentElement === el) park(); };
  }, [slot]);
}

/** Mounted once per window (AppShell, not on a phone, where no column shows the scratchpad). */
export function ScratchpadHost() {
  // Loaded with the page, not when the pane first opens: opening it puts the caret in the editor,
  // and typing that began before a late load landed raced the load and lost the text.
  const notes = useGlobalNotes();
  const who = useSyncExternalStore(subscribe, current, () => null);
  const phone = usePhoneLayout();
  const [sheet, setSheet] = useState(false);
  // "Take me there" on a scratchpad still saving (unsaved-work.ts) opens it where the user is. A
  // phone has no column for it (neither Home's nor the side bar mounts there), so it opens in a
  // sheet of its own: before, the reveal opened a pane nobody drew and nothing showed (2026-11-07).
  useEffect(() => {
    setUnsavedWorkScratchpadOpener(() => {
      if (isPhoneLayout()) { setSheet(true); return; }
      const page = sideBarPageOf(window.location.pathname);
      if (page !== null) setSideBarPane(page, 'scratchpad', true);
      else if (homePanelOpen('scratchpad') !== true) window.dispatchEvent(new CustomEvent('sidebar:toggle-scratchpad'));
    });
    return () => setUnsavedWorkScratchpadOpener(undefined);
  }, []);
  const closeSheet = useCallback(() => setSheet(false), []);
  // A wide layout has its columns again: the sheet is done, and never comes back on its own.
  useEffect(() => { if (!phone) setSheet(false); }, [phone]);
  return (
    <>
      {/* Nothing renders until a column first shows the scratchpad (the editor is not built for nothing). */}
      {who && createPortal(
        <GlobalNotesSection {...notes} fill title="Scratchpad" onClose={who.onClose} tasks={who.tasks} focusedTaskId={who.focusedTaskId} onTaskClick={who.onTaskClick} />,
        theBox(),
      )}
      {sheet && phone && <ScratchpadSheet onClose={closeSheet} />}
    </>
  );
}

const NO_TASKS: Task[] = [];
const noTaskClick = () => {};

/** The phone's place for the one editor: a sheet over the page, holding the moved box. */
function ScratchpadSheet({ onClose }: { onClose: () => void }) {
  useModalOverlay(onClose);
  const slot = useRef<HTMLDivElement>(null);
  useScratchpadSlot(slot, true, { onClose, tasks: NO_TASKS, onTaskClick: noTaskClick });
  return createPortal(
    <div className="app-modal-overlay scratchpad-sheet-overlay" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div ref={slot} className="scratchpad-sheet" role="dialog" aria-modal="true" aria-label="Scratchpad" data-testid="scratchpad-sheet" onPointerDown={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
