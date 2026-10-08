import { calendarEventNeedsApproval, type CalendarEvent } from '@/api/calendar';

export function confirmCalendarWrite(event: CalendarEvent, action: 'update' | 'delete'): boolean {
  if (!calendarEventNeedsApproval(event)) return true;
  const series = event.recurring ? 'This is a recurring series. The whole series may be affected. ' : '';
  const organizer = event.organizerName ? `Organizer: ${event.organizerName}. ` : '';
  return window.confirm(`${action === 'delete' ? 'Delete' : 'Update'} \"${event.title}\"?\n\n${series}${organizer}The organizer may be notified. To skip this meeting without changing the source calendar, use Hide event instead.\n\nContinue to the Mac confirmation dialog?`);
}
