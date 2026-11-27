/**
 * The words a meeting invite card says, as pure functions, so a spec and a unit test can hold them.
 *
 * Times come from the calendar as instants and are shown in this browser's zone, which is the zone
 * the person will attend in. A range is written with "to" rather than a dash, and the end's date is
 * only repeated when the meeting runs past midnight.
 */
import type { MailInviteDetails, MailInviteResponse } from '@/api/mail';
import { clockTime, dayDate, pointInTime } from '@/utils/time';

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `Oct 22, 3:00 PM to 4:00 PM`, `tomorrow, all day`, or '' when the calendar gave no time. */
export function inviteWhen(details: Pick<MailInviteDetails, 'start' | 'end' | 'allDay'>, now?: number): string {
  if (!details.start) return '';
  const start = new Date(details.start);
  const opts = now === undefined ? undefined : { now };
  if (details.allDay) {
    // An all-day item ends at the NEXT midnight, so a one-day meeting's end is the following day.
    const last = details.end ? new Date(details.end - 1) : start;
    const day = dayDate(start, opts);
    return sameDay(start, last) ? `${day}, all day` : `${day} to ${dayDate(last, opts)}, all day`;
  }
  const from = pointInTime(start, opts);
  if (!details.end) return from;
  const end = new Date(details.end);
  return sameDay(start, end)
    ? `${from} to ${clockTime(end)}`
    : `${from} to ${pointInTime(end, opts)}`;
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
