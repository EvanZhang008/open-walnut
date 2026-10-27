/**
 * WebKit selects the word under a right-press before it dispatches `contextmenu`
 * (its select-on-contextual-menu-click, the same default `selectionForGesture` in
 * utils/context-menu.ts is about). So a right-click on a link the plugin menu takes
 * lit the link text up behind the menu and woke the selection bar (Pin / Quote /
 * Copy) as if the user had selected it, while Chromium selects nothing.
 *
 * The keeper records the selection as the press found it (capture-phase
 * pointerdown) and, when the link menu takes the gesture, puts that selection back
 * if the press replaced it: a word the press selected goes, a selection the user
 * made before stays. No fresh press (the keyboard's menu key) leaves it alone.
 */
import { selectionForGesture, type PressSelection } from '@/utils/context-menu'

interface PressSnapshot extends PressSelection {
  ranges: Range[]
}

export interface PressSelectionKeeper {
  /** Capture-phase pointerdown (or mousedown) on the document. */
  press(e: Pick<MouseEvent, 'button' | 'ctrlKey'>): void
  /** The link menu took the gesture: undo the selection the press made. True when it did. */
  settle(): boolean
}

export function createPressSelectionKeeper(
  getSelection: () => Selection | null,
  now: () => number = Date.now,
): PressSelectionKeeper {
  let pressed: PressSnapshot | null = null
  return {
    press(e) {
      // Only a press that can open a menu: the secondary button, or Ctrl with the primary (a Mac).
      if (e.button !== 2 && !(e.button === 0 && e.ctrlKey)) { pressed = null; return }
      const selection = getSelection()
      const ranges: Range[] = []
      if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange())
      pressed = { text: selection && !selection.isCollapsed ? selection.toString() : '', at: now(), ranges }
    },
    settle() {
      const snapshot = pressed
      pressed = null
      if (!snapshot) return false
      const selection = getSelection()
      const live = selection && !selection.isCollapsed ? selection.toString() : ''
      if (!selection || !live) return false
      // The user's own selection (unchanged by the press) is theirs to keep.
      if (selectionForGesture(live, snapshot, now())) return false
      selection.removeAllRanges()
      for (const range of snapshot.ranges) selection.addRange(range)
      return true
    },
  }
}
