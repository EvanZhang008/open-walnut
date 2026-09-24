/**
 * Warm the Notes page's data while the user is somewhere else, so the first
 * click on a note paints a full sidebar and has its autocomplete corpora ready.
 *
 * Runs once per page load, after the app has settled (an idle callback with a
 * generous timeout; a plain delay where the API is missing, as in WebKit). Every
 * request goes out at low priority, so it only takes a connection nobody else
 * wants; the Home page's own loads always win. Skipped on the Notes page itself
 * (it fetches for real) and in pop-out windows.
 */
import { prefetchNotesTree } from '@/hooks/useNotesTree';
import { prefetchNotesCorpora } from '@/stores/notes-corpus-store';

/** Leave the startup burst alone; a few seconds of quiet is plenty. */
const SETTLE_DELAY_MS = 4000;
/** Upper bound for the idle callback: warm anyway once this much time has passed. */
const IDLE_TIMEOUT_MS = 10_000;

let scheduled = false;

export function scheduleNotesPrefetch(opts: { pathname: string }): void {
  if (scheduled) return;
  if (opts.pathname.startsWith('/notes') || opts.pathname.startsWith('/popout')) return;
  scheduled = true;
  const run = () => {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as Window & { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback(() => { prefetchAll(); }, { timeout: IDLE_TIMEOUT_MS });
    } else {
      prefetchAll();
    }
  };
  setTimeout(run, SETTLE_DELAY_MS);
}

function prefetchAll(): void {
  void prefetchNotesTree();
  prefetchNotesCorpora();
}

/** Test hook. */
export function resetNotesPrefetchForTests(): void {
  scheduled = false;
}
