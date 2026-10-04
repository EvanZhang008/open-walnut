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
