/**
 * A server-clock re-render while `on`: countdowns and elapsed timers on host
 * rows read serverNow(), so the skew correction applies. A settled row keeps
 * no timer alive (pass `on = false`).
 */
import { useEffect, useState } from 'react';
import { serverNow } from '@/hooks/useHostStatus';

export function useServerTick(on: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!on) return;
    setNow(serverNow());
    const t = setInterval(() => setNow(serverNow()), everyMs);
    return () => clearInterval(t);
  }, [on, everyMs]);
  return on ? now : serverNow();
}
