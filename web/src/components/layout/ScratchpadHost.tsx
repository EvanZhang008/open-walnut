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
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { GlobalNotesSection } from '@/components/notes/GlobalNotesSection';
import { useGlobalNotes } from '@/hooks/useGlobalNotes';
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
    box.className = 'scratchpad-host';
  }
  return box;
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
}

/** Mounted once per window (AppShell, not on a phone, where no column shows the scratchpad). */
export function ScratchpadHost() {
  // Loaded with the page, not when the pane first opens: opening it puts the caret in the editor,
  // and typing that began before a late load landed raced the load and lost the text.
  const notes = useGlobalNotes();
  const who = useSyncExternalStore(subscribe, current, () => null);
  // Nothing renders until a column first shows the scratchpad (the editor is not built for nothing).
  if (!who) return null;
  return createPortal(
    <GlobalNotesSection {...notes} fill title="Scratchpad" onClose={who.onClose} tasks={who.tasks} focusedTaskId={who.focusedTaskId} onTaskClick={who.onTaskClick} />,
    theBox(),
  );
}
