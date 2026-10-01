/**
 * `PW_MAIL_INVITE=1`: meeting invites on the writer account, and a calendar behind them.
 *
 * Six invites, one per thing the reader's invite card says differently: an ordinary one to answer,
 * a recurring series (shown, not answerable here), a cancellation, one whose calendar read is slow
 * (the buttons must work before it lands), one whose answer fails (the card must say so and
 * re-read the calendar), and one whose answer outlives the route's budget (a 202 the card must follow
 * to the end). Every answer is written to `<home>/mail-fixture-invite-calls.json`, so a spec
 * can assert that one click sent exactly one RSVP.
 *
 * `PW_MAIL_INVITE_SLOW_MS` (default 2500) is how long the slow invite's calendar read takes, and
 * `PW_MAIL_INVITE_SLOW_ANSWER_MS` (default 18000, past the route's 15s budget) the slow answer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const inviteOn = process.env.PW_MAIL_INVITE === '1';

export const INVITE_OPEN = 'INBOX:9:1';
export const INVITE_SERIES = 'INBOX:9:2';
export const INVITE_CANCELED = 'INBOX:9:3';
export const INVITE_SLOW = 'INBOX:9:4';
export const INVITE_FAIL = 'INBOX:9:5';
export const INVITE_SLOW_ANSWER = 'INBOX:9:6';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CALLS = path.join(process.env.OPEN_WALNUT_HOME || os.tmpdir(), 'mail-fixture-invite-calls.json');
const SLOW_MS = Number(process.env.PW_MAIL_INVITE_SLOW_MS ?? '') || 2500;
const SLOW_ANSWER_MS = Number(process.env.PW_MAIL_INVITE_SLOW_ANSWER_MS ?? '') || 18_000;

/** Three days out at 3 PM local, so the card's time is stable to read. */
function meetingAt(daysOut, hour) {
  const day = new Date(Date.now() + daysOut * DAY);
  day.setHours(hour, 0, 0, 0);
  return day.getTime();
}

const ORGANIZER = { name: 'Harbour Office', address: 'office@harbour.example.invalid' };

/** What the calendar holds per invite. `response` changes as the spec answers. */
const calendar = new Map([
  [INVITE_OPEN, { state: 'open', subject: 'Mooring review', start: meetingAt(3, 15), end: meetingAt(3, 16), location: 'Room 5 | Meeting URL: https://meet.example.invalid/j/41', response: 'none' }],
  [INVITE_SERIES, { state: 'open', subject: 'Weekly tide sync', start: meetingAt(5, 10), end: meetingAt(5, 10) + HOUR / 2, location: 'Harbour office', response: 'none', recurring: true }],
  [INVITE_CANCELED, { state: 'canceled', subject: 'Canceled: Slipway walk', start: meetingAt(2, 9), end: meetingAt(2, 10), response: 'none' }],
  [INVITE_SLOW, { state: 'open', subject: 'Harbour board meeting', start: meetingAt(7, 13), end: meetingAt(7, 14), location: 'Boardroom', response: 'none' }],
  [INVITE_FAIL, { state: 'open', subject: 'Dock inspection', start: meetingAt(4, 11), end: meetingAt(4, 12), location: 'Dock 3', response: 'tentative' }],
  [INVITE_SLOW_ANSWER, { state: 'open', subject: 'Ferry timetable review', start: meetingAt(6, 9), end: meetingAt(6, 10), location: 'Quay office', response: 'none' }],
]);

function record(entry) {
  let held = [];
  try { held = JSON.parse(fs.readFileSync(CALLS, 'utf8')); } catch { held = []; }
  held.push({ ...entry, at: Date.now() });
  const staging = `${CALLS}.${process.pid}.tmp`;
  fs.writeFileSync(staging, JSON.stringify(held, null, 2));
  fs.renameSync(staging, CALLS);
}

function detailsOf(messageId) {
  const held = calendar.get(messageId);
  if (!held) return { state: 'not-found', canRespond: false, reason: 'Walnut could not find this meeting on your calendar.' };
  const canRespond = held.state === 'open' && !held.recurring;
  return {
    ...held,
    organizer: ORGANIZER,
    canRespond,
    ...(held.recurring ? { reason: 'This invite is for a recurring series. Answer it in Outlook.' } : {}),
  };
}

/** The invite rows, newest first. Read on arrival so the reader opens them without a body fetch error. */
export function inviteMessages(now) {
  const one = (messageId, subject, minutesAgo, kind) => ({
    messageId,
    rfcMessageId: `<${messageId.replaceAll(':', '-')}@harbour.example.invalid>`,
    mailboxId: 'INBOX',
    from: ORGANIZER,
    to: [{ address: 'ctx-writer@example.invalid' }],
    subject,
    snippet: 'You are invited.',
    sentAt: now - minutesAgo * 60 * 1000,
    attachments: [],
    body: { format: 'text', text: `${subject}\n\nPlease let us know if you can make it.` },
    unreadAtFirstSight: false,
    invite: { kind },
  });
  return [
    one(INVITE_OPEN, 'Mooring review', 5, 'request'),
    one(INVITE_SERIES, 'Weekly tide sync', 10, 'request'),
    one(INVITE_CANCELED, 'Canceled: Slipway walk', 15, 'canceled'),
    one(INVITE_SLOW, 'Harbour board meeting', 20, 'request'),
    one(INVITE_FAIL, 'Dock inspection', 25, 'request'),
    one(INVITE_SLOW_ANSWER, 'Ferry timetable review', 30, 'request'),
  ];
}

export const inviteMethods = {
  async inviteDetails(_accountId, invite) {
    record({ method: 'details', messageId: invite.messageId });
    if (invite.messageId === INVITE_SLOW) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    return detailsOf(invite.messageId);
  },
  async respondToInvite(_accountId, invite, response) {
    record({ method: 'respond', messageId: invite.messageId, response });
    // A real answer takes a moment; long enough that a second click lands while it is in flight.
    await new Promise((resolve) => setTimeout(resolve, invite.messageId === INVITE_SLOW_ANSWER ? SLOW_ANSWER_MS : 600));
    if (invite.messageId === INVITE_FAIL) {
      const error = new Error('Outlook did not answer in time.');
      error.code = 'unreachable';
      throw error;
    }
    const held = calendar.get(invite.messageId);
    const details = detailsOf(invite.messageId);
    if (!held || !details.canRespond) {
      const error = new Error(details.reason ?? 'This invite cannot be answered.');
      error.code = 'unsupported';
      error.stage = 'before-data';
      throw error;
    }
    held.response = response === 'accept' ? 'accepted' : response === 'tentative' ? 'tentative' : 'declined';
    return detailsOf(invite.messageId);
  },
};
