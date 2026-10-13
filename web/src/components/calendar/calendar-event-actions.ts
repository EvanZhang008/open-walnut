import { calendarEventNeedsApproval, type CalendarEvent } from '@/api/calendar';
import { useConfirm, useAlert } from '@/hooks/useConfirm';
import { currentCalendarEvent } from '@/stores/calendar-events-store';

export function useCalendarWriteConfirmation() {
  const confirm = useConfirm();
  const alert = useAlert();
  return async (event: CalendarEvent, action: 'update' | 'delete'): Promise<boolean> => {
    const needsApproval = calendarEventNeedsApproval(event);
    const series = event.recurring ? 'This is a recurring series. The whole series may be affected. ' : '';
    const organizer = event.organizerName ? `Organizer: ${event.organizerName}. ` : '';
    const accepted = !needsApproval || await confirm({
      title: `${action === 'delete' ? 'Delete' : 'Update'} "${event.title}"?`,
      message: `${series}${organizer}The organizer may be notified. To skip this meeting without changing the source calendar, use Hide event instead. Continue to the Mac confirmation dialog?`,
      confirmLabel: 'Continue',
      danger: action === 'delete',
    });
    if (!accepted) return false;
    const latest = currentCalendarEvent(event.id);
    if (!latest || latest.start !== event.start || latest.end !== event.end || latest.title !== event.title || latest.readonly) {
      await alert({ title: 'Event changed', message: 'This event changed while confirmation was open. Nothing was saved. Check its current times and try again.' });
      return false;
    }
    return true;
  };
}
