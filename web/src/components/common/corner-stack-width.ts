/**
 * The notice stack's one width (corner-stack.css says the same: `min(440px, 100vw - 32px)`).
 * Read by the stack's own placement (corner-stack.tsx) and by the browser specs that check it,
 * so a new width is one edit here and in the CSS; the spec compares the two in a real page.
 */
export const STACK_WIDTH_PX = 440;

/**
 * The name a CSS rule reads the notice stack's room by, always as `var(--corner-stack-room, 0px)`
 * on a box that scrolls: how much of the window's bottom the stack covers now (its height, its
 * 16px gap to the edge and 8px of air), 0 while it covers nothing (empty, hidden, or on the phone,
 * where it sits at the top). Registered as not inherited (corner-stack.css) and set only on the
 * asking boxes themselves (corner-stack-room.ts ROOM_BOXES), never on <html> or a page: changing an
 * inherited one restyles everything under it (corner-stack.css says who asks and why).
 */
export const STACK_ROOM_VAR = '--corner-stack-room';

/**
 * The same room for a spacer after a box's last row (`::after { height: var(--corner-stack-spacer,
 * 0px) }`), set on its box: an ordinary, inherited variable, because WebKit 26 gives a pseudo-element
 * nothing of a registered property that is not inherited, `inherit` included (measured 2026-11-17).
 * It restyles what is inside the box, so only a few boxes use it (corner-stack-room.ts SPACER_BOXES).
 */
export const STACK_SPACER_VAR = '--corner-stack-spacer';
