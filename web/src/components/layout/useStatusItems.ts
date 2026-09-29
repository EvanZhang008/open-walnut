/**
 * Plugin status items, React side: load once, follow `plugin:status-items` (the whole
 * list each time), and load again after the WebSocket reconnects, because a change made
 * while it was down never arrives as an event. `useTicker` moves the rings between events.
 */
import { useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { wsClient, type ConnectionState } from '@/api/ws';
import { log } from '@/utils/log';
import { statusItemsOf, type StatusItem } from './status-item-model';

export function useStatusItems(): StatusItem[] {
  const [items, setItems] = useState<StatusItem[]>([]);
  // Bumped by every event: a GET answered after a newer event must not roll it back.
  const eventSeq = useRef(0);
  const [loadSeq, setLoadSeq] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    const seqAtStart = eventSeq.current;
    fetch('/api/plugin-status-items', { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data) => { if (eventSeq.current === seqAtStart) setItems(statusItemsOf(data)); })
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        log.warn('status-items', 'status items load failed', { error: String(err) });
      });
    return () => ac.abort();
  }, [loadSeq]);

  useEffect(() => {
    let last: ConnectionState = wsClient.state;
    const onChange = (state: ConnectionState) => {
      if (state === 'connected' && last !== 'connected') setLoadSeq((n) => n + 1);
      last = state;
    };
    wsClient.onConnectionChange(onChange);
    return () => wsClient.offConnectionChange(onChange);
  }, []);

  useEvent('plugin:status-items', (data) => {
    eventSeq.current += 1;
    setItems(statusItemsOf(data));
  });

  return items;
}

/**
 * Re-renders every `intervalMs` while `active` and the page is visible, so the rings
 * move. The caller reads `Date.now()` in render rather than a value kept here: an item
 * that arrives between ticks must never draw with a clock from minutes ago.
 */
export function useTicker(active: boolean, intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer || document.visibilityState === 'hidden') return;
      setTick((n) => n + 1);
      timer = setInterval(() => setTick((n) => n + 1), intervalMs);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.visibilityState === 'hidden') stop(); else start(); };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [active, intervalMs]);
}
