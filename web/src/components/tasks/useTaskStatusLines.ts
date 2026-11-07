import { isBoolean, usePageView } from '@/utils/view-memory';

/**
 * The browser extension's first page shows every row's status line (design C draws "Decide: …",
 * "Review: …" on each; review round 5: rows there gave project, title and time only). It keeps its
 * own choice, on by default, apart from Home's (off by default). Set once, before anything renders.
 */
let extensionPage = false;
export function markStatusLinesOn(): void { extensionPage = true; }

export function useTaskStatusLines(): [boolean, (show: boolean) => void] {
  const home = usePageView('tasks', 'statusLines', false, isBoolean);
  const ext = usePageView('ext-panel', 'statusLines', true, isBoolean);
  return extensionPage ? ext : home;
}
