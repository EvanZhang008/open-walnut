/**
 * Inline title editing for every task row (2026-11-03, the user, on a row under Watching:
 * "whhy the preivosu avaiible text edit cna't be done here?"). The list row, the Recent card, the
 * Focus / Satellite card and the status section card each kept their own copy of this, and the
 * section card never got one. One hook now; tests/web/task-row-title-edit.test.ts fails on a row
 * that draws a task title without it.
 *
 * The title is a contentEditable span (it keeps the row's wrapping and ellipsis). A double-click
 * (or the caller's own gesture) starts it with the caret where the pointer was; Enter or a click
 * outside saves a changed, non-empty title; Escape puts the old one back.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

type CaretPositionDoc = { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };

function placeCaret(el: HTMLElement, at: { x: number; y: number } | null) {
  const sel = window.getSelection();
  if (at) {
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(at.x, at.y);
      if (range) { sel?.removeAllRanges(); sel?.addRange(range); return; }
    } else {
      const pos = (document as unknown as CaretPositionDoc).caretPositionFromPoint?.(at.x, at.y);
      if (pos) {
        const range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
        sel?.removeAllRanges(); sel?.addRange(range);
        return;
      }
    }
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges(); sel?.addRange(range);
}

export interface InlineTitleEditOptions {
  /** False where a double-click means something else (select mode), or never renames (a phone
   *  list row: a title tap opens the row, phone-row-behavior.ts). Default true. */
  doubleClick?: boolean;
}

export function useInlineTitleEdit(
  task: { id: string; title: string },
  onUpdateTitle?: (id: string, title: string) => void,
  { doubleClick = true }: InlineTitleEditOptions = {},
) {
  const [isEditing, setIsEditing] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  const isCommittingRef = useRef(false); // one-shot guard against double-fire (pointerdown + blur)

  // A title changed elsewhere (a WS push) shows while not editing.
  useEffect(() => {
    if (!isEditing && titleRef.current) {
      if (titleRef.current.textContent !== task.title) titleRef.current.textContent = task.title;
      // Editing auto-scrolls the overflow:hidden span to keep the caret visible;
      // a leftover scrollLeft on a nowrap+ellipsis span paints as a BLANK title.
      titleRef.current.scrollLeft = 0;
    }
  }, [task.title, isEditing]);

  useEffect(() => {
    if (!isEditing || !titleRef.current) return;
    titleRef.current.focus();
    const at = clickPosRef.current;
    clickPosRef.current = null;
    placeCaret(titleRef.current, at);
  }, [isEditing]);

  const commitEdit = useCallback(() => {
    if (!isEditing || isCommittingRef.current) return;
    isCommittingRef.current = true;
    setIsEditing(false);
    const trimmed = (titleRef.current?.textContent ?? '').trim();
    if (trimmed && trimmed !== task.title && onUpdateTitle) onUpdateTitle(task.id, trimmed);
    else if (titleRef.current) titleRef.current.textContent = task.title;
    isCommittingRef.current = false;
  }, [isEditing, task.title, task.id, onUpdateTitle]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    if (titleRef.current) titleRef.current.textContent = task.title;
  }, [task.title]);

  // A click outside saves too, for when blur does not fire (a click on a non-focusable element).
  useEffect(() => {
    if (!isEditing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (titleRef.current && !titleRef.current.contains(e.target as Node)) commitEdit();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [isEditing, commitEdit]);

  /** Start editing with the caret at the pointer. Does nothing for a row that cannot rename. */
  const startEdit = useCallback((e?: { clientX: number; clientY: number }) => {
    if (!onUpdateTitle) return;
    clickPosRef.current = e ? { x: e.clientX, y: e.clientY } : null;
    setIsEditing(true);
  }, [onUpdateTitle]);

  // Rename is DOUBLE-click (2026-08-31): a single click opens the task, and click-to-edit popped
  // the outlined editor over the title on every open, which read as a glitch.
  const onDoubleClick = useCallback((e: MouseEvent) => {
    // A modifier double-click is a selection gesture, never a rename.
    if (!onUpdateTitle || !doubleClick || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.stopPropagation();
    startEdit(e);
  }, [onUpdateTitle, doubleClick, startEdit]);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  }, [commitEdit, cancelEdit]);

  /** Spread on the title span; `editing` is the class to add while it edits. */
  const titleProps = {
    ref: titleRef,
    'data-no-draft': 'rename',
    contentEditable: isEditing,
    suppressContentEditableWarning: true,
    onBlur: isEditing ? commitEdit : undefined,
    onKeyDown: isEditing ? onKeyDown : undefined,
    onDoubleClick: isEditing ? undefined : onDoubleClick,
  } as const;

  return { isEditing, titleRef, startEdit, commitEdit, cancelEdit, titleProps, canRename: !!onUpdateTitle };
}
