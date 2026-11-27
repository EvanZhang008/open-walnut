/**
 * What a calendar view says about its own state, the same on the homepage day agenda and on
 * /calendar (each used to decide this by itself, and only the page said anything).
 *
 * An empty grid looks exactly like a free day, so a problem is said out loud: a load that failed
 * (2026-11-21: three loads lost to a server restart left the side panel blank with no word and no
 * retry), access to the calendars lost, or events served from an older helper.
 * Its × (NoticeClose) hides it until it says something else (on both views; a good load forgets it).
 */
import type { UseCalendarEvents } from '@/hooks/useCalendarEvents';
import { NoticeClose } from '@/components/common/NoticeClose';
import { useNoticeDismiss } from '@/utils/notice-dismiss';

type CalendarState = Pick<UseCalendarEvents, 'sources' | 'loading' | 'loadError'>;

export function calendarAlertOf(calendar: CalendarState): string | null {
  const denied = calendar.sources.find((s) => s.enabled && s.reason === 'permission-denied');
  if (denied) {
    return 'Calendar access lost. Re-grant Walnut under System Settings → Privacy & Security → Calendars, then retry.';
  }
  if (calendar.loadError) return 'The calendar did not load. Trying again by itself.';
  return calendar.sources.find((s) => s.degraded)?.degraded ?? null;
}

/**
 * Whether the quick-create popover offers an Event. Until the sources resolve once, optimistic
 * (the "can't select Event" race), and still so after a failed load: a load lost to a restart is
 * not a calendar the person cannot write to. Once resolved, the sources say.
 */
export function canCreateEventOf(calendar: CalendarState): boolean {
  return calendar.sources.length === 0
    ? calendar.loading || !!calendar.loadError
    : calendar.sources.some((s) => s.available && s.enabled);
}

export function CalendarAlert({ calendar, onRetry }: { calendar: CalendarState; onRetry: () => void }) {
  const alert = calendarAlertOf(calendar);
  // While a load runs with nothing to say yet, what was closed is kept (a retry is not a good load).
  const { hidden, dismiss } = useNoticeDismiss('cal-alert', alert ?? (calendar.loading ? undefined : null));
  if (!alert || hidden) return null;
  return (
    <div className="cal-alert" role="alert" data-testid="cal-alert">
      <span aria-hidden="true">⚠</span>
      <span>{alert}</span>
      <button type="button" className="btn btn-sm cal-alert-retry" onClick={onRetry}>Retry</button>
      <NoticeClose onClose={dismiss} label="Hide until the calendar says something else" testId="cal-alert-close" className="cal-alert-close" />
    </div>
  );
}
