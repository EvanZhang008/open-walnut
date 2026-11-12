import { useEffect, useState } from 'react';
import { experimentalEnabled, type ExperimentalFeatureId, type ExperimentalFlags } from '@open-walnut/core';
import { fetchConfig } from '@/api/config';
import { wsClient } from '@/api/ws';
import { testRunLabel } from '@/api/test-run';

/**
 * Whether an experiment (src/core/experimental.ts) is on, for a view to read.
 * One app-wide copy of `config.experimental`: one fetch and one `config:changed`
 * subscription for the whole page (read again after a reconnect, which may have
 * missed a change), the last read kept in localStorage so a switch that is on does
 * not flash off while the config loads. A test run's tab keeps nothing: its flags
 * are its own, and the next ordinary tab must not start on them.
 */

let cached: ExperimentalFlags | null = null;
let inflight: Promise<void> | null = null;
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

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchConfig()
    .then((c) => publish((c as { experimental?: ExperimentalFlags }).experimental ?? {}))
    .catch(() => { /* keep what we have */ })
    .finally(() => { inflight = null; });
  return inflight;
}

function bindConfigChanges() {
  if (wsBound) return;
  wsBound = true;
  wsClient.onEvent('config:changed', (data: unknown) => {
    // Read back, never taken from the event: a test run's own flags are only in its GET.
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'experimental') return;
    void load();
  });
  let wasConnected = wsClient.state === 'connected';
  wsClient.onConnectionChange((state) => {
    if (state !== 'connected') return;
    if (wasConnected) void load();
    wasConnected = true;
  });
}

export function useExperimental(id: ExperimentalFeatureId): boolean {
  const [flags, setFlags] = useState<ExperimentalFlags>(() => cached ?? lastRead());
  useEffect(() => {
    listeners.add(setFlags);
    bindConfigChanges();
    if (cached === null) void load();
    else setFlags(cached);
    return () => { listeners.delete(setFlags); };
  }, []);
  return experimentalEnabled(flags, id);
}
