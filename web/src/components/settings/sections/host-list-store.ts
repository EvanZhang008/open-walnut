/**
 * Settings > Remote Hosts: what every row of the list says about its machine (RowReport), kept
 * in one small store the rows write and the summary line, the header's "need a look" count and
 * the network map read. A row's live status push re-renders that row and these readers, never the
 * section, which holds the auto-saving editor.
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { RowReport } from './host-row-model';

export interface RowStore {
  put: (r: RowReport) => void;
  drop: (key: string) => void;
  /** The rows' keys in the order the list shows them. */
  setOrder: (keys: string[]) => void;
  subscribe: (fn: () => void) => () => void;
  snapshot: () => RowReport[];
}

export function createRowStore(): RowStore {
  const rows = new Map<string, RowReport>();
  let order: string[] = [];
  let snap: RowReport[] = [];
  const listeners = new Set<() => void>();
  const rebuild = () => {
    const at = new Map(order.map((k, i) => [k, i]));
    snap = [...rows.values()].sort((a, b) => (at.get(a.key) ?? 1e9) - (at.get(b.key) ?? 1e9));
    for (const fn of listeners) fn();
  };
  return {
    put: (r) => {
      const cur = rows.get(r.key);
      if (cur && JSON.stringify(cur) === JSON.stringify(r)) return;
      rows.set(r.key, r);
      rebuild();
    },
    drop: (key) => { if (rows.delete(key)) rebuild(); },
    setOrder: (keys) => {
      if (keys.join('\n') === order.join('\n')) return;
      order = keys;
      rebuild();
    },
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    snapshot: () => snap,
  };
}

const RowStoreContext = createContext<RowStore | null>(null);
export const RowStoreProvider = RowStoreContext.Provider;

/** Every row's report, in list order. */
export function useRowReports(): RowReport[] {
  const store = useContext(RowStoreContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.snapshot ?? empty, store?.snapshot ?? empty);
}

/** A row says what it shows (and takes it back when it goes). */
export function useRowReport(report: RowReport | null): void {
  const store = useContext(RowStoreContext);
  const json = report ? JSON.stringify(report) : '';
  useEffect(() => {
    if (store && report) store.put(report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, json]);
  const key = report?.key;
  useEffect(() => () => { if (store && key) store.drop(key); }, [store, key]);
}

const NONE: RowReport[] = [];
const empty = () => NONE;
const noSubscribe = () => () => {};
