/**
 * The notice stack's one width (corner-stack.css says the same: `min(440px, 100vw - 32px)`).
 * Read by the stack's own placement (corner-stack.tsx) and by the browser specs that check it,
 * so a new width is one edit here and in the CSS; the spec compares the two in a real page.
 */
export const STACK_WIDTH_PX = 440;
