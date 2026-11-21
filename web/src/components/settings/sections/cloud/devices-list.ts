/**
 * One GET /api/devices per pane mount (N27). Phones & Cloud mounts three
 * readers at once (the device list, the Cloud Companion probe and its pair
 * card), and each asked on its own. Concurrent callers now share the request
 * in flight; nothing is cached after it lands, so a refresh after a change
 * always asks the server again.
 *
 * "After a change" includes a request already in flight when the change
 * landed: pairing a phone while the pane's first read was still out joined
 * that read and answered with a list that predates the new phone, so the phone
 * never appeared. A change bumps the generation, and a read joins only a
 * request of the current one.
 */
import { apiGet } from '@/api/client';
import { wsClient } from '@/api/ws';
import { DEVICES_CHANGED_EVENT } from './device-rows-copy';

let inflight: Promise<unknown> | null = null;
let inflightGeneration = 0;
let generation = 0;

export function fetchDevicesList<T>(): Promise<T> {
  if (inflight && inflightGeneration === generation) return inflight as Promise<T>;
  const p = apiGet<T>('/api/devices').finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  inflightGeneration = generation;
  return p;
}

/** A device was paired, re-paired or removed: the next read must start after it. */
export function devicesListChanged(): void {
  generation += 1;
}

/** The server's word that a browser signed in with a link's code (src/web/routes/browser-pair.ts). */
export const BROWSER_SIGNED_IN_EVENT = 'browser:signed-in';

/** How often a shown device list is read again (a phone that signs in elsewhere shows up). */
export const DEVICES_POLL_MS = 15_000;
let watchers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Every reader reads again at once: one request (above), the same list. */
function announce(): void {
  devicesListChanged();
  window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT));
}

function poll(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  // A read still out (a slow server): no second one stacked on it.
  if (inflight) return;
  announce();
}

/**
 * While a pane shows the device list (useDevicesData): it is read again every
 * DEVICES_POLL_MS with the page in view, and at once when a browser signs in
 * with a link, once for every reader. Returns the stop for this reader; the
 * clock and the listener stop with the last one.
 */
export function watchDevicesList(): () => void {
  watchers += 1;
  if (watchers === 1) {
    pollTimer = setInterval(poll, DEVICES_POLL_MS);
    wsClient.onEvent(BROWSER_SIGNED_IN_EVENT, announce);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    watchers -= 1;
    if (watchers > 0) return;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    wsClient.offEvent(BROWSER_SIGNED_IN_EVENT, announce);
  };
}
