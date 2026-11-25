import { useSyncExternalStore } from 'react';
import { experimentalEnabled, type ExperimentalFeatureId, type ExperimentalFlags } from '@open-walnut/core';
import { fetchConfig, fetchFreshConfig } from '@/api/config';
import { wsClient } from '@/api/ws';
import { testRunLabel } from '@/api/test-run';
import { keepEqual } from '@/utils/keep-equal';

/**
 * Whether an experiment (src/core/experimental.ts) is on, for a view to read.
 * One app-wide copy of `config.experimental`: one fetch and one `config:changed`
 * subscription for the whole page (read again after a reconnect, which may have
 * missed a change), the last read kept in localStorage so a switch that is on does
 * not flash off while the config loads. A test run's tab keeps nothing: its flags
 * are its own, and the next ordinary tab must not start on them.
 *
 * The newest read always wins. A change announced while a read is out starts a read of
 * its own, past the shared answer of the last few seconds (the read out, or that answer,
 * may predate the change), and an answer that lands after a newer one is dropped. A view
 * that mounts while a read is out joins it.
 *
 * A view redraws only when what it reads changed (2026-11-25, task 9bceb9f2): an answer equal to
 * the last one tells no one, and `useExperimental` reads its one switch, so a change to another
 * experiment draws nothing. Every config change and reconnect read the flags again and handed
 * every reader a new object: each open session panel (it reads six) drew its whole body again.
 */

let cached: ExperimentalFlags | null = null;
let inflight: Promise<void> | null = null;
/** Reads started, and the newest one whose answer is on the page. */
let started = 0;
let shown = 0;
let wsBound = false;
const listeners = new Set<() => void>();
const LAST_KEY = 'walnut:experimental-flags';

function lastRead(): ExperimentalFlags {
  if (testRunLabel()) return {};
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
    return v && typeof v === 'object' ? v as ExperimentalFlags : {};
  } catch { return {}; }
}

/** The flags a view reads before the first answer: the last read kept, parsed once. */
let firstRead: ExperimentalFlags | null = null;
function current(): ExperimentalFlags {
  return cached ?? (firstRead ??= lastRead());
}

function publish(v: ExperimentalFlags) {
  const next = keepEqual(current(), v);
  const changed = next !== current();
  cached = next;
  if (!testRunLabel()) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  }
  if (changed) for (const l of [...listeners]) l();
}

/** One read of the server's flags; `fresh` skips the shared answer of the last few seconds. */
function read(fresh: boolean): Promise<void> {
  const seq = ++started;
  const done: Promise<void> = (fresh ? fetchFreshConfig() : fetchConfig())
    .then((c) => {
      if (seq < shown) return; // a newer read already answered
      shown = seq;
      publish((c as { experimental?: ExperimentalFlags }).experimental ?? {});
    })
    .catch(() => { /* keep what we have */ })
    .finally(() => { if (inflight === done) inflight = null; });
  inflight = done;
  return done;
}

function bindConfigChanges() {
  if (wsBound) return;
  wsBound = true;
  wsClient.onEvent('config:changed', (data: unknown) => {
    // Read back, never taken from the event: a test run's own flags are only in its GET.
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'experimental') return;
    void read(true);
  });
  // Only on a reconnect, never the first connect: the socket was down, so a change may have been missed.
  wsClient.onEvent('_ws:reconnected', () => { void read(true); });
}

/** The same answer outside a render, for a menu built at the click (the page's last read). */
export function experimentalOn(id: ExperimentalFeatureId): boolean {
  return experimentalEnabled(current(), id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  bindConfigChanges();
  if (cached === null && !inflight) void read(false);
  return () => { listeners.delete(listener); };
}

/** Every experiment's switch, for a view that gates on several (Settings' pane gates). */
export function useExperimentalFlags(): ExperimentalFlags {
  return useSyncExternalStore(subscribe, current, current);
}

export function useExperimental(id: ExperimentalFeatureId): boolean {
  // A primitive, so a new reader function each render is fine (React compares what it returns).
  const on = () => experimentalEnabled(current(), id);
  return useSyncExternalStore(subscribe, on, on);
}
