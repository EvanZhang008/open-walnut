/**
 * Which engines a host can run (GET /api/engines/availability?host=), for the
 * engine picker: what the task's host cannot run is greyed out
 * (utils/engines.ts hostEngineLockReason). One small store per host, shared by
 * every picker, pulled when a picker for that host mounts and at most once a
 * minute. This machine needs none: the engine catalog carries its availability.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { apiGet } from '@/api/client';
import { isRemoteHost, type HostEngineAvailability } from '@/utils/engines';
import { log } from '@/utils/log';
import { refreshEngineCatalog } from './useEngineCatalog';

const TTL_MS = 60_000;
const answers = new Map<string, { at: number; engines: HostEngineAvailability }>();
const pulling = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void { for (const l of listeners) l(); }

function pull(host: string): void {
  const hit = answers.get(host);
  if (pulling.has(host) || (hit && Date.now() - hit.at < TTL_MS)) return;
  pulling.add(host);
  apiGet<{ engines?: HostEngineAvailability }>('/api/engines/availability', { host }, { quietStatuses: [404] })
    .then((r) => {
      answers.set(host, { at: Date.now(), engines: r?.engines ?? {} });
      notify();
    })
    .catch((err: unknown) => {
      log.warn('engines', 'host engine availability failed', { host, error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => { pulling.delete(host); });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/**
 * The host's answer now, without a hook (a launch reads it as it goes): null for this
 * machine and while none has come; a stale one asks again in the background.
 */
export function getHostEngineAvailability(host: string | null | undefined): HostEngineAvailability | null {
  if (!isRemoteHost(host)) return null;
  pull(host!);
  return answers.get(host!)?.engines ?? null;
}

/**
 * An engine was just installed (or removed) on `host`: every picker reads it again now, not
 * after the minute's cache (2026-11-25: after "Install Antigravity" the picker still read it
 * "Not installed here" until the cache ran out). This machine's answer is the engine catalog's.
 */
export function engineSetupChanged(host: string | null | undefined): void {
  if (!isRemoteHost(host)) { refreshEngineCatalog(); return; }
  answers.delete(host!);
  if (listeners.size > 0) pull(host!);
}

/** The host's answer, or null for this machine and while none has come. */
export function useHostEngineAvailability(host: string | null | undefined): HostEngineAvailability | null {
  const remote = isRemoteHost(host) ? host! : null;
  useEffect(() => { if (remote) pull(remote); }, [remote]);
  return useSyncExternalStore(subscribe, () => (remote ? answers.get(remote)?.engines ?? null : null));
}
