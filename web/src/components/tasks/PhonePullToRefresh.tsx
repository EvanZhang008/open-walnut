/**
 * Pull to refresh for the phone's home list and notification center (spec 4.5,
 * C90). The document never scrolls on a phone (html/body overscroll none), so
 * these boxes read the gesture themselves: a touch that starts with the box at
 * its top and travels down 64 px or more runs the same resync as coming back
 * to the foreground (`runPhoneResync('pull')`: ping, reconnect if needed,
 * refetch tasks, statuses and the notification feed). No reload, no
 * navigation; `Updated` shows for a second after.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { runPhoneResync } from '@/hooks/usePhoneResync';
import { log } from '@/utils/log';

export const PULL_TRIGGER_PX = 64;
export const UPDATED_SHOW_MS = 1000;

/** How far a pull has travelled: only downward, only from the very top. */
export function pullDistance(startY: number | null, y: number, startedAtTop: boolean): number {
  if (startY === null || !startedAtTop) return 0;
  return Math.max(0, y - startY);
}

type PullState = 'idle' | 'pulling' | 'ready' | 'refreshing' | 'updated';

const LABELS: Record<Exclude<PullState, 'idle'>, string> = {
  pulling: 'Pull to refresh',
  ready: 'Release to refresh',
  refreshing: 'Updating...',
  updated: 'Updated',
};

export interface PhonePullToRefreshProps {
  enabled: boolean;
  /** The scroll box the gesture belongs to (looked up at each touch start). */
  getScroller: () => HTMLElement | null;
  testId?: string;
}

export function PhonePullToRefresh({ enabled, getScroller, testId = 'phone-pull' }: PhonePullToRefreshProps) {
  const [state, setState] = useState<PullState>('idle');
  const [top, setTop] = useState(0);
  const getRef = useRef(getScroller);
  getRef.current = getScroller;

  useEffect(() => {
    if (!enabled) return undefined;
    let startY: number | null = null;
    let atTop = false;
    let distance = 0;
    let busy = false;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;
    const onStart = (e: TouchEvent) => {
      const box = getRef.current();
      // A synthetic touch event can arrive with no touch list at all.
      const t = e.touches?.[0];
      if (busy || !box || !t || e.touches.length !== 1 || !(e.target instanceof Node) || !box.contains(e.target)) {
        startY = null;
        return;
      }
      startY = t.clientY;
      atTop = box.scrollTop <= 0;
      distance = 0;
      setTop(box.getBoundingClientRect().top);
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const t = e.touches?.[0];
      if (!t) return;
      distance = pullDistance(startY, t.clientY, atTop);
      setState(distance <= 0 ? 'idle' : distance >= PULL_TRIGGER_PX ? 'ready' : 'pulling');
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      if (distance < PULL_TRIGGER_PX) { setState('idle'); return; }
      busy = true;
      setState('refreshing');
      log.info('phone-pull', 'pull to refresh', { distance: Math.round(distance) });
      void runPhoneResync('pull').catch(() => undefined).finally(() => {
        busy = false;
        setState('updated');
        doneTimer = setTimeout(() => setState('idle'), UPDATED_SHOW_MS);
      });
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
      if (doneTimer) clearTimeout(doneTimer);
    };
  }, [enabled]);

  if (!enabled || state === 'idle') return null;
  return createPortal(
    <div className={`phone-pull is-${state}`} style={{ top: top + 8 }} role="status" aria-live="polite" data-testid={testId}>
      {LABELS[state]}
    </div>,
    document.body,
  );
}
