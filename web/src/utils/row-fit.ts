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

/** Keeps `data-row-fit` on `el` current; returns the stop function. */
export function observeRowFit(el: HTMLElement): () => void {
  const apply = () => { el.dataset.rowFit = rowFitFor(el.clientWidth); };
  apply();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(apply);
  observer.observe(el);
  return () => observer.disconnect();
}
