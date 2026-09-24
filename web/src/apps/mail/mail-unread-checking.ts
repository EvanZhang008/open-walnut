/**
 * The console's half of "Checking…" for a folder's unread check (server: `unread-checks.ts`).
 *
 * A first page may come back naming checks that are still running (`checking`): the server waited a
 * moment and answered from the cache. Each of them ends with one `unread-reconciled` event. Two ways
 * this could show "Checking…" for ever, and what stops each:
 *
 * - The event can arrive BEFORE the page it belongs to: they travel on different channels (the socket
 *   and the HTTP answer). So every end is remembered with its time, and a page sent before that end
 *   does not bring the mark back.
 * - The event can be lost (a socket that reconnects in the gap). So every mark retires by itself after
 *   `UNREAD_CHECK_SAFETY_MS`, which is well past the provider's own deadline.
 */
import { log } from '@/utils/log';
import { onMailStoreReset, pairKey, patch, store } from './mail-store';

/** Past the server's 8 second provider deadline, with room for a slow socket. */
export const UNREAD_CHECK_SAFETY_MS = 20_000;

/** When each folder's check was last heard to end, so a late page cannot revive its mark. */
const settledAt = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** A page sent at `askedAt` named these checks as still running. */
export function noteUnreadChecking(
  pairs: ReadonlyArray<{ accountId: string; mailboxId: string }> | undefined,
  askedAt: number,
): void {
  if (!pairs || pairs.length === 0) return;
  const held = { ...store.state.unreadChecking };
  let changed = false;
  for (const pair of pairs) {
    const key = pairKey(pair.accountId, pair.mailboxId);
    // The end already arrived, after this page was asked for: the page is the older news.
    if ((settledAt.get(key) ?? -1) >= askedAt) continue;
    held[key] = Date.now();
    changed = true;
    const previous = timers.get(key);
    if (previous) clearTimeout(previous);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      if (!store.state.unreadChecking[key]) return;
      log.info('mail', 'unread check mark retired without an end event', {
        accountId: pair.accountId, mailboxId: pair.mailboxId,
      });
      drop(key);
    }, UNREAD_CHECK_SAFETY_MS));
  }
  if (changed) patch({ unreadChecking: held });
}

/** A folder's check ended (`unread-reconciled`), whatever it found. */
export function settleUnreadCheck(accountId: string | undefined, mailboxId: string | undefined): void {
  if (!accountId || !mailboxId) return;
  const key = pairKey(accountId, mailboxId);
  settledAt.set(key, Date.now());
  const timer = timers.get(key);
  if (timer) { clearTimeout(timer); timers.delete(key); }
  drop(key);
}

function drop(key: string): void {
  if (!(key in store.state.unreadChecking)) return;
  const held = { ...store.state.unreadChecking };
  delete held[key];
  patch({ unreadChecking: held });
}

onMailStoreReset(() => {
  settledAt.clear();
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
});
