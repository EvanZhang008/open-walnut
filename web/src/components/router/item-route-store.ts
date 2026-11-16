/**
 * Where the router sent items shown outside Mail (a plugin's Slack message), for `RouteLine`: one
 * request per account for every line that asks in the same tick, and a live update when the router
 * decides one (`router:item-changed`), so a line never shows an older decision than Mail would.
 */
import { apiGet } from '@/api/client';
import { wsClient } from '@/api/ws';
import type { MailRouteDto } from '@/api/mail';

export interface ItemRouteState {
  route?: MailRouteDto;
  area?: { id: string; name: string };
  /** The record could not be read. */
  unavailable?: boolean;
  /** When an unreadable answer came: it is asked again after RETRY_MS. */
  failedAt?: number;
}

/** An unreadable record is asked again this long after, on the next line that shows it. */
const RETRY_MS = 60_000;

interface ItemRouteAnswer { routes: Record<string, { route?: MailRouteDto & { key?: string }; area?: { id: string; name: string } }> }

const BATCH_MAX = 200;
const keyOf = (kind: string, account: string, message: string) => JSON.stringify([kind, account, message]);
const known = new Map<string, ItemRouteState>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Map<string, { kind: string; account: string; messages: Set<string> }>();
let flushQueued = false;
let liveStarted = false;

function notify(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function set(key: string, state: ItemRouteState): void {
  known.set(key, state);
  notify(key);
}

function startLive(): void {
  if (liveStarted) return;
  liveStarted = true;
  wsClient.subscribeAll((name, data) => {
    if (name !== 'router:item-changed') return;
    const event = data as { source?: { kind?: string; account?: string; message?: string }; route?: MailRouteDto } | null;
    const source = event?.source;
    if (!source?.kind || !source.account || !source.message || !event?.route) return;
    const key = keyOf(source.kind, source.account, source.message);
    const was = known.get(key);
    if (!listeners.has(key) && !was) return;
    if (was?.route && was.route.at > event.route.at) return;
    set(key, { ...was, route: event.route, unavailable: false });
  });
}

async function flush(): Promise<void> {
  flushQueued = false;
  const batches = [...pending.values()];
  pending.clear();
  await Promise.all(batches.map(async ({ kind, account, messages }) => {
    const all = [...messages];
    for (let i = 0; i < all.length; i += BATCH_MAX) {
      const part = all.slice(i, i + BATCH_MAX);
      try {
        const answer = await apiGet<ItemRouteAnswer>('/api/v1/router/routes', { kind, account, messages: JSON.stringify(part) }, { priority: 'low' });
        for (const message of part) {
          const one = answer.routes?.[message];
          set(keyOf(kind, account, message), { ...(one?.route ? { route: one.route } : {}), ...(one?.area ? { area: one.area } : {}) });
        }
      } catch (error) {
        // A server with no router ledger (a replica answers 501, an older one 404) has nothing to show.
        const status = (error as { status?: number } | null)?.status;
        const none = status === 501 || status === 404;
        for (const message of part) set(keyOf(kind, account, message), none ? {} : { unavailable: true, failedAt: Date.now() });
      }
    }
  }));
}

/** The item's route as known now (undefined until read), and a subscription to its changes. */
export function readItemRoute(kind: string, account: string, message: string): ItemRouteState | undefined {
  return known.get(keyOf(kind, account, message));
}

export function watchItemRoute(kind: string, account: string, message: string, onChange: () => void): () => void {
  startLive();
  const key = keyOf(kind, account, message);
  const mine = listeners.get(key) ?? new Set();
  mine.add(onChange);
  listeners.set(key, mine);
  const was = known.get(key);
  if (!was || (was.unavailable && Date.now() - (was.failedAt ?? 0) > RETRY_MS)) {
    const batchKey = JSON.stringify([kind, account]);
    const batch = pending.get(batchKey) ?? { kind, account, messages: new Set<string>() };
    batch.messages.add(message);
    pending.set(batchKey, batch);
    if (!flushQueued) { flushQueued = true; queueMicrotask(() => { void flush(); }); }
  }
  return () => {
    mine.delete(onChange);
    if (mine.size === 0) {
      listeners.delete(key);
      // Nobody shows it now: the next line that does reads it fresh.
      known.delete(key);
    }
  };
}
