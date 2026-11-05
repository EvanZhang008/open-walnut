/**
 * What a notes picture's load already told this page, shared by every picture
 * view (markdown images in resolved-image.ts, `![[embeds]]` in WikiEmbedView).
 *
 *  - A picture that just failed is not asked again for a few seconds, so one
 *    note painting twice asks once; after that a repaint asks again, so a file
 *    put back (or a connection back) shows without reopening the note.
 *  - One request per URL at a time: two views of one picture (a note rebuilt
 *    while its pictures load) wait for the first answer instead of each asking.
 *  - A failure is told apart: the file is missing, or it is there and this
 *    browser cannot draw it (HEIC or TIFF outside Safari), which offers a download.
 *  - Which file a markdown image drew, so a copy pasted into another note names
 *    that same file (resolved-image.ts).
 */

/** How long a failed picture is not asked again. */
export const MISSING_FOR_MS = 10_000;

const missingAt = new Map<string, number>();

export function noteMissing(url: string): void {
  missingAt.set(url, Date.now());
  if (missingAt.size > 200) missingAt.delete(missingAt.keys().next().value as string);
}

export function recentlyMissing(url: string): boolean {
  const at = missingAt.get(url);
  if (at == null) return false;
  if (Date.now() - at < MISSING_FOR_MS) return true;
  missingAt.delete(url);
  return false;
}

/** Whether a failure seen at `failedAt` is old enough to ask again. */
export function retryDue(failedAt: number, now = Date.now()): boolean {
  return now - failedAt >= MISSING_FOR_MS;
}

export type LoadOutcome = 'ok' | 'failed' | 'retry';

/** Waiters on a URL another view is loading. */
const inflight = new Map<string, Set<(outcome: LoadOutcome) => void>>();
/** A waiter whose loader never answers (its request cancelled) loads itself. */
const WAIT_MAX_MS = 15_000;

/**
 * Ask to load `url`. Returns true when the caller loads it (and must call
 * `settleLoad` when its <img> answers); false when another view already is,
 * and `onSettled` is called with its outcome.
 */
export function claimLoad(url: string, onSettled: (outcome: LoadOutcome) => void): boolean {
  const waiters = inflight.get(url);
  if (!waiters) {
    inflight.set(url, new Set());
    return true;
  }
  let done = false;
  const once = (outcome: LoadOutcome) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    waiters.delete(once);
    onSettled(outcome);
  };
  const timer = setTimeout(() => once('retry'), WAIT_MAX_MS);
  waiters.add(once);
  return false;
}

/** The loader's answer for `url`, passed to every view waiting on it. */
export function settleLoad(url: string, outcome: LoadOutcome): void {
  const waiters = inflight.get(url);
  if (!waiters) return;
  inflight.delete(url);
  for (const notify of [...waiters]) notify(outcome);
}

/** Types some engines cannot draw (Chromium and Firefox: HEIC, TIFF). */
const MAYBE_UNDRAWABLE = new Set(['heic', 'heif', 'tif', 'tiff']);
const undrawable = new Set<string>();

/** The extension of the file a picture URL or path names. */
function extOfUrl(url: string): string {
  let path = url;
  try {
    const parsed = new URL(url, 'http://x');
    path = parsed.searchParams.get('path') ?? parsed.pathname;
  } catch { /* a plain path */ }
  const base = path.split('|')[0].split(/[?#]/)[0].split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Already known: the file is there, this browser cannot draw it. */
export function knownUndrawable(url: string): boolean {
  return undrawable.has(url);
}

/**
 * Why `url` failed to draw. Only a type some engine cannot draw is asked again
 * (a HEAD request): every other failure is a missing file.
 */
export async function failureOf(url: string): Promise<'missing' | 'undrawable'> {
  if (undrawable.has(url)) return 'undrawable';
  if (!MAYBE_UNDRAWABLE.has(extOfUrl(url))) return 'missing';
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (!res.ok) return 'missing';
    undrawable.add(url);
    return 'undrawable';
  } catch {
    return 'missing';
  }
}

/** URL each markdown image drew from, by `note \n src`. */
const drawnFrom = new Map<string, string>();
const drawnKey = (note: string, src: string) => `${note}\n${src}`;

export function noteDrawn(note: string, src: string, url: string): void {
  drawnFrom.set(drawnKey(note, src), url);
  if (drawnFrom.size > 2000) drawnFrom.delete(drawnFrom.keys().next().value as string);
}

/** The URL the image `src` of note `note` drew from on this page, if it drew. */
export function drawnUrl(note: string, src: string): string | undefined {
  return drawnFrom.get(drawnKey(note, src));
}

/**
 * Views showing a missing card, asked again when the user comes back to the
 * page: a file put back is usually put back from another app (Finder, a sync),
 * and coming back is when the user looks again.
 */
const onReturn = new Set<() => void>();
let returnWired = false;
function wireReturn(): void {
  if (returnWired || typeof window === 'undefined') return;
  returnWired = true;
  const fire = () => { for (const cb of [...onReturn]) cb(); };
  window.addEventListener('focus', fire);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fire(); });
}

/** Call `cb` each time the user comes back to the page; returns the unsubscribe. */
export function onPageReturn(cb: () => void): () => void {
  wireReturn();
  onReturn.add(cb);
  return () => { onReturn.delete(cb); };
}
