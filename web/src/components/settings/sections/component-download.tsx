import { useCallback, useEffect, useState } from 'react';
import { fetchComponentStatus, installComponent, type ComponentStatus } from '@/api/components';
import { SettingsButton } from '../inputs/SettingsButton';
import { visibleInterval } from '@/utils/page-visibility';
import { log } from '@/utils/log';

/**
 * A feature whose part is downloaded on first use (src/core/components/): the
 * one sentence its settings row shows, and the button that turns it on.
 */

function mb(bytes: number): string {
  const v = bytes / 1e6;
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

/** The row's help line for a component that is not ready (empty when it is). Pure, unit tested. */
export function componentHelp(s: ComponentStatus | null): string {
  if (!s || s.state === 'ready') return '';
  if (s.state === 'unsupported') return 'Not available on this system.';
  if (s.state === 'missing') return s.size ? `Needs a ${mb(s.size)} MB download.` : 'Needs a download.';
  if (s.state === 'installing') return 'Installing...';
  if (s.state === 'waiting') return 'Another Walnut process is downloading it.';
  if (s.state === 'downloading') {
    const total = s.progress?.total ?? s.size;
    const done = s.progress?.done ?? 0;
    return total ? `Downloading, ${mb(done)} of ${mb(total)} MB.` : 'Downloading...';
  }
  return `The download failed: ${s.error ?? 'unknown error'}`;
}

/** Downloading, installing, or waiting for another process that is: the row polls and the button is busy. */
export function componentBusy(s: ComponentStatus | null): boolean {
  return s?.state === 'waiting' || s?.state === 'downloading' || s?.state === 'installing';
}

/**
 * How often the row asks again: every second while a download runs, every few
 * seconds while it is missing or failed (the server starts a download itself
 * when a feature needs it, and retries a failure after a backoff), never once
 * it is ready or unsupported. Pure, unit tested.
 */
export function componentPollMs(s: ComponentStatus | null): number | null {
  if (componentBusy(s)) return 1000;
  if (s?.state === 'missing' || s?.state === 'failed') return 5000;
  return null;
}

/** Status of one component, polled while it can change; install() answers the click before the server does. */
export function useComponentStatus(name: ComponentStatus['name'], enabled = true) {
  const [status, setStatus] = useState<ComponentStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await fetchComponentStatus(name));
    } catch (err) {
      log.warn('settings', 'component status fetch failed', { name, error: err instanceof Error ? err.message : String(err) });
    }
  }, [name]);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  const pollMs = enabled ? componentPollMs(status) : null;
  useEffect(() => (pollMs ? visibleInterval(() => { void refresh(); }, pollMs) : undefined), [pollMs, refresh]);
  const install = useCallback(async () => {
    setStatus((s) => (s ? { ...s, state: 'downloading', progress: { done: 0, total: s.size ?? null }, error: undefined } : s));
    try {
      setStatus(await installComponent(name));
      log.info('settings', 'component download started', { name });
    } catch (err) {
      log.warn('settings', 'component download did not start', { name, error: err instanceof Error ? err.message : String(err) });
      void refresh();
    }
  }, [name, refresh]);
  return { status, install, refresh };
}

/** "Download" while missing, busy while it runs, "Try again" after a failure; nothing once ready. */
export function ComponentDownloadButton({ status, onInstall, testId }: { status: ComponentStatus | null; onInstall: () => void; testId?: string }) {
  if (!status || status.state === 'ready' || status.state === 'unsupported') return null;
  const busy = componentBusy(status);
  return (
    <SettingsButton
      busy={busy}
      busyLabel="Downloading..."
      reserve={['Download', 'Try again']}
      onClick={onInstall}
      data-testid={testId}
    >
      {status.state === 'failed' ? 'Try again' : 'Download'}
    </SettingsButton>
  );
}
