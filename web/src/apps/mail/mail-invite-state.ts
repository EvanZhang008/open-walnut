/**
 * The words a meeting invite card says, as pure functions, so a spec and a unit test can hold them.
 *
 * Times come from the calendar as instants and are shown in this browser's zone, which is the zone
 * the person will attend in. A range is written with "to" rather than a dash, and the end's date is
 * only repeated when the meeting runs past midnight.
 */
import type { MailInviteDetails, MailInviteResponse } from '@/api/mail';

const DAY: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `Thu, Oct 22, 3:00 PM to 4:00 PM`, `Thu, Oct 22, all day`, or '' when the calendar gave no time. */
export function inviteWhen(details: Pick<MailInviteDetails, 'start' | 'end' | 'allDay'>, locale?: string): string {
  if (!details.start) return '';
  const start = new Date(details.start);
  const day = start.toLocaleDateString(locale, DAY);
  if (details.allDay) {
    // An all-day item ends at the NEXT midnight, so a one-day meeting's end is the following day.
    const last = details.end ? new Date(details.end - 1) : start;
    return sameDay(start, last) ? `${day}, all day` : `${day} to ${last.toLocaleDateString(locale, DAY)}, all day`;
  }
  const from = start.toLocaleTimeString(locale, TIME);
  if (!details.end) return `${day}, ${from}`;
  const end = new Date(details.end);
  const to = end.toLocaleTimeString(locale, TIME);
  return sameDay(start, end)
    ? `${day}, ${from} to ${to}`
    : `${day}, ${from} to ${end.toLocaleDateString(locale, DAY)}, ${to}`;
}

/** Where things stand, in the person's own terms. */
export function inviteAnswerLine(response: MailInviteDetails['response']): string {
  switch (response) {
    case 'accepted': return 'You accepted';
    case 'tentative': return 'You said maybe';
    case 'declined': return 'You declined';
    case 'organizer': return 'This is your meeting';
    default: return 'You have not answered yet';
  }
}

export const INVITE_BUTTONS: ReadonlyArray<{ response: MailInviteResponse; label: string; busy: string }> = [
  { response: 'accept', label: 'Accept', busy: 'Accepting…' },
  { response: 'tentative', label: 'Tentative', busy: 'Sending…' },
  { response: 'decline', label: 'Decline', busy: 'Declining…' },
];

/** The answer a button sends, as the calendar will report it afterwards. */
export function answeredAs(response: MailInviteResponse): NonNullable<MailInviteDetails['response']> {
  return response === 'accept' ? 'accepted' : response === 'tentative' ? 'tentative' : 'declined';
}
