import { useEffect, useState } from 'react';
import { experimentalEnabled, type ExperimentalFeatureId, type ExperimentalFlags } from '@open-walnut/core';
import { fetchConfig, fetchFreshConfig } from '@/api/config';
import { wsClient } from '@/api/ws';
import { testRunLabel } from '@/api/test-run';

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
 */

let cached: ExperimentalFlags | null = null;
let inflight: Promise<void> | null = null;
/** Reads started, and the newest one whose answer is on the page. */
let started = 0;
let shown = 0;
let wsBound = false;
const listeners = new Set<(v: ExperimentalFlags) => void>();
const LAST_KEY = 'walnut:experimental-flags';

function lastRead(): ExperimentalFlags {
  if (testRunLabel()) return {};
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}');
    return v && typeof v === 'object' ? v as ExperimentalFlags : {};
  } catch { return {}; }
}

function publish(v: ExperimentalFlags) {
  cached = v;
  if (!testRunLabel()) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* private mode */ }
  }
  for (const l of listeners) l(v);
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
  return experimentalEnabled(cached ?? lastRead(), id);
}

/** Every experiment's switch, for a view that gates on several (Settings' pane gates). */
export function useExperimentalFlags(): ExperimentalFlags {
  const [flags, setFlags] = useState<ExperimentalFlags>(() => cached ?? lastRead());
  useEffect(() => {
    listeners.add(setFlags);
    bindConfigChanges();
    if (cached !== null) setFlags(cached);
    else if (!inflight) void read(false);
    return () => { listeners.delete(setFlags); };
  }, []);
  return flags;
}

export function useExperimental(id: ExperimentalFeatureId): boolean {
  return experimentalEnabled(useExperimentalFlags(), id);
}
