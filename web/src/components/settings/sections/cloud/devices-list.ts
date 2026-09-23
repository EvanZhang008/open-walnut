/**
 * One GET /api/devices per pane mount (N27). Phones & Cloud mounts three
 * readers at once (the device list, the Cloud Companion probe and its pair
 * card), and each asked on its own. Concurrent callers now share the request
 * in flight; nothing is cached after it lands, so a refresh after a change
 * always asks the server again.
 */
import { apiGet } from '@/api/client';

let inflight: Promise<unknown> | null = null;

export function fetchDevicesList<T>(): Promise<T> {
  if (inflight) return inflight as Promise<T>;
  const p = apiGet<T>('/api/devices').finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}
