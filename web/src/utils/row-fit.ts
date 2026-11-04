/**
 * How wide the task column is, told to CSS as `data-row-fit` on the list's
 * scroller. One observer for the whole list (never one per row): in a tight column
 * every row's pills read as one letter (row-pill-fit.css), so the titles keep room.
 */
export const ROW_FIT_TIGHT_BELOW_PX = 420;

export type RowFit = 'tight' | 'roomy';

export function rowFitFor(widthPx: number): RowFit {
  return widthPx < ROW_FIT_TIGHT_BELOW_PX ? 'tight' : 'roomy';
}

/** Narrower still (`data-row-narrow`): a pull request pill drops its number in every row at
 *  once, so the column never mixes pills with and without one (pr-pill.css). */
export const ROW_FIT_NARROW_BELOW_PX = 260;

export function rowIsNarrow(widthPx: number): boolean {
  return widthPx > 0 && widthPx < ROW_FIT_NARROW_BELOW_PX;
}

/** Keeps `data-row-fit` on `el` current; returns the stop function. */
export function observeRowFit(el: HTMLElement): () => void {
  const apply = () => {
    el.dataset.rowFit = rowFitFor(el.clientWidth);
    if (rowIsNarrow(el.clientWidth)) el.dataset.rowNarrow = 'true';
    else delete el.dataset.rowNarrow;
  };
  apply();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(apply);
  observer.observe(el);
  return () => observer.disconnect();
}
