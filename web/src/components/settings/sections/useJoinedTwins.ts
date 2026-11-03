/**
 * Rows found in ~/.ssh/config that are a machine on the host network (server:
 * core/hosts/joined-twins.ts, via GET /api/hosts/net): Remote Hosts lists that machine
 * once, in its network row, and still saves the found row as it is.
 */
import { useEffect, useState } from 'react';
import { fetchNet } from '@/api/hosts-net';
import { log } from '@/utils/log';

export function useJoinedTwins(refreshKey: unknown): Record<string, string> {
  const [twins, setTwins] = useState<Record<string, string>>({});
  useEffect(() => {
    const ctrl = new AbortController();
    fetchNet({ signal: ctrl.signal })
      .then((n) => setTwins(n.twins ?? {}))
      .catch((err: unknown) => { if (!ctrl.signal.aborted) log.warn('settings', 'host network twins did not load', { error: String(err) }); });
    return () => ctrl.abort();
  }, [refreshKey]);
  return twins;
}
