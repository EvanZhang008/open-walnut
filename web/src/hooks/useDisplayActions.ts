/**
 * The buttons a notice shows now (displayActionsOf), drawn again the moment the next one expires:
 * a toast or a row of the notification center left open past a break's end drops End break then,
 * not at its next unrelated render (2026-11-22 review: the toast computed it once). The one hook
 * both the toast and the feed card use.
 */
import { useEffect, useReducer } from 'react';
import {
  actionExpiryDelayMs, displayActionsOf, nextActionExpiry,
  type Notification, type NotificationAction,
} from '@/contexts/notifications';

export function useDisplayActions(n: Pick<Notification, 'action' | 'actions'>): NotificationAction[] {
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  const next = nextActionExpiry(n);
  useEffect(() => {
    const delay = actionExpiryDelayMs(next);
    if (delay === null) return undefined;
    const timer = window.setTimeout(redraw, delay);
    return () => window.clearTimeout(timer);
  }, [next]);
  return displayActionsOf(n);
}
