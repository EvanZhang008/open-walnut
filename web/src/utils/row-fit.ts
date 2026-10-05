/**
 * How crowded the task rows are, told to CSS as `data-row-fit` on the list's
 * scroller. One observer for the whole list (never one per row): the rows read it
 * through `.home-navigation-scroll[data-row-fit="tight"]` (row-pill-fit.css) and
 * fold their pills to a letter, so a narrow column keeps room for the title.
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
