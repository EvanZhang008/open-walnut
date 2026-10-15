/**
 * Work the first phone screen does not show waits until that screen is up (N19).
 *
 * A phone reaches Walnut over a slow link with a handful of connections, so every early fetch the
 * home rows do not need (the mail badge, git sync, audio, the slash command list) delays the ones
 * they do. `afterFirstScreen(fn)` queues `fn` on a phone until the first task list has painted
 * (`markFirstScreen`, from the task list's first answer), or a few seconds at most, so a list that
 * never answers holds nothing back for ever. Off a phone, and after the first screen, `fn` runs at
 * once, so the desktop starts exactly as before.
 */
import { isPhoneLayout } from '@/hooks/usePhoneLayout';
import { log } from '@/utils/log';

/** The longest anything waits for the first screen. */
export const FIRST_SCREEN_FALLBACK_MS = 4000;

let ready = false;
let marked = false;
let queue: Array<() => void> = [];
let fallback: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  if (ready) return;
  ready = true;
  if (fallback !== undefined) clearTimeout(fallback);
  fallback = undefined;
  const run = queue;
  queue = [];
  for (const fn of run) {
    try {
      fn();
    } catch (error) {
      log.warn('boot', 'deferred start failed', { error: String(error) });
    }
  }
}

/**
 * The sign-in page is up (UnpairedNotice): no console to feed, and every fetch
 * would only be refused (N2-35, spec D1). The fallback waits for it to go.
 */
function signInShowing(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[data-testid="unpaired-notice"]');
}

function onFallback(): void {
  fallback = undefined;
  if (signInShowing()) { fallback = setTimeout(onFallback, FIRST_SCREEN_FALLBACK_MS); return; }
  flush();
}

const nextFrame = (cb: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
};

/** The first task list has landed: run the queue once its rows are painted (two frames). */
export function markFirstScreen(): void {
  if (marked || ready) return;
  marked = true;
  nextFrame(() => nextFrame(flush));
}

/** Run `fn` now, or on a phone once the first screen is up. */
export function afterFirstScreen(fn: () => void): void {
  if (ready || !isPhoneLayout()) {
    fn();
    return;
  }
  queue.push(fn);
  if (fallback === undefined) fallback = setTimeout(onFallback, FIRST_SCREEN_FALLBACK_MS);
}

/** Whether queued work is still waiting (for tests and logs). */
export function firstScreenPending(): number {
  return ready ? 0 : queue.length;
}

/** Test seam: back to a page that has not drawn its first screen. */
export function resetFirstScreenForTests(): void {
  if (fallback !== undefined) clearTimeout(fallback);
  fallback = undefined;
  ready = false;
  marked = false;
  queue = [];
}
