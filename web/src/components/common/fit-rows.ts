/**
 * The one way an input box's text grows with what is typed (styles/input-box.css): up to
 * `maxRows` lines of 20 px, then it scrolls. The padding is read from the box itself, since a
 * phone's one-line box pads its line more than a desktop's (2026-11-21: a fixed 12 px cut the
 * last line in half there).
 */
export const INPUT_LINE_PX = 20;

/** The most a text area of `maxRows` lines may grow to, as CSS (for its max-height). */
export function maxRowsHeight(maxRows: number): string {
  return `calc(${maxRows * INPUT_LINE_PX}px + 2 * var(--input-pad, 6px))`;
}

/** Fit the text area's height to its text, at most `maxRows` lines. */
export function fitRows(el: HTMLTextAreaElement, maxRows: number): void {
  el.style.height = 'auto';
  const cs = getComputedStyle(el);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  el.style.height = `${Math.min(el.scrollHeight, maxRows * INPUT_LINE_PX + padY)}px`;
}
