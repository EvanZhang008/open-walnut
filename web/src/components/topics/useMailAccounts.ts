/**
 * The mail accounts a topic may email from (GET /api/topics/mail-accounts), read once per page and
 * again when a view asks while the last read is over a minute old. Only send-capable ones are
 * offered; `address` names a chosen account in the confirm words.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { listTopicMailAccounts, type TopicMailAccount } from '@/api/topics';
import { log } from '@/utils/log';

interface State { accounts: TopicMailAccount[] | null; available: boolean; at: number }

let state: State = { accounts: null, available: true, at: 0 };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const STALE_MS = 60_000;

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = listTopicMailAccounts()
    .then((r) => { state = { accounts: r.accounts, available: r.available, at: Date.now() }; })
    .catch((err) => {
      log.warn('topics', 'mail accounts read failed', { error: err instanceof Error ? err.message : String(err) });
      state = { accounts: state.accounts ?? [], available: false, at: Date.now() };
    })
    .finally(() => { inflight = null; for (const l of listeners) l(); });
  return inflight;
}

/** The send-capable accounts (null until the first read) and whether Mail answered. */
export function useMailAccounts(enabled: boolean): { accounts: TopicMailAccount[] | null; available: boolean } {
  const s = useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => state);
  useEffect(() => {
    if (enabled && Date.now() - state.at > STALE_MS) void load();
  }, [enabled]);
  return { accounts: s.accounts?.filter((a) => a.canSend) ?? null, available: s.available };
}

/** The address of account `id` among `accounts`, else the id itself; null for no account. */
export function mailboxWords(accounts: readonly TopicMailAccount[] | null, id: string | null | undefined): string | null {
  if (!id) return null;
  return accounts?.find((a) => a.accountId === id)?.address ?? id;
}

/** For tests: forget the read. */
export function resetMailAccounts(): void {
  state = { accounts: null, available: true, at: 0 };
}
