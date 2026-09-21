/**
 * Caller-defined rows for the composer's "+" menu.
 *
 * ChatInput stays feature-ignorant: it draws whatever action rows its owner
 * hands it (the same way `plusMenuToggles` works) and never knows what an action
 * does. The owner (SessionPanel for "Engine settings") supplies the label, the
 * tooltip and the handler, and receives the "+" button as the anchor so a popover
 * it opens can be placed against it.
 *
 * Pure module (no React runtime import) so the label rule is unit-testable
 * without a DOM; the `icon` type is a type-only import.
 */
import type { ReactNode } from 'react';

export interface PlusMenuAction {
  id: string;
  label: string;
  title?: string;
  /** Rendered as `aria-disabled` + `is-disabled`; the click is a no-op and the menu stays open. */
  disabled?: boolean;
  /** 16px stroke=currentColor SVG; ChatInput draws a default gear when absent. */
  icon?: ReactNode;
  onSelect: (ctx: PlusMenuActionContext) => void;
}

export interface PlusMenuActionContext {
  /** The "+" button: what a popover aligns to horizontally and returns focus to. */
  anchor: HTMLElement;
  /**
   * The composer box the menu belongs to (textarea + controls), when known: a
   * popover that opens upward clears the whole box instead of sitting on the
   * textarea the user may want to click next.
   */
  composer?: HTMLElement | null;
}

/**
 * The "+" button's `aria-label` and `title`. "Add attachment" was the whole
 * truth while the menu only held the image picker; once the caller adds any
 * action or toggle row the name has to promise more than an attachment.
 */
export function plusButtonLabel(hasCallerRows: boolean): string {
  return hasCallerRows ? 'Attachments and more' : 'Add attachment';
}

/**
 * What ChatInput does when an enabled action row is clicked: close the menu
 * FIRST, then hand the "+" button over as the anchor. The caller's popover then
 * opens on the frame the menu leaves, so the menu's outside-click closer never
 * sees the new surface as a click inside a menu that is already gone. Without an
 * anchor (the button unmounted mid-click) the action is not called: a popover
 * placed against nothing would park in the viewport corner.
 */
export function selectPlusMenuAction(
  action: PlusMenuAction,
  anchor: HTMLElement | null,
  closeMenu: () => void,
  composer?: HTMLElement | null,
): void {
  closeMenu();
  if (anchor) action.onSelect({ anchor, composer: composer ?? null });
}
