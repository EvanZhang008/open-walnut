/**
 * The words the meeting invite card says (mail-invite-state.ts).
 *
 * Times are graded in a pinned zone and locale: an invite card that says the wrong hour is worse than
 * one that says nothing, and the browser's own zone is the one the person attends in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  INVITE_BUTTONS,
  answeredAs,
  inviteAnswerLine,
  inviteWhen,
} from '../../web/src/apps/mail/mail-invite-state';

const zone = process.env.TZ;
beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
afterAll(() => { process.env.TZ = zone; });

const at = (iso: string) => Date.parse(iso);

describe('inviteWhen', () => {
  it('a meeting inside one day: the day once, then the two times', () => {
    expect(inviteWhen({ start: at('2026-10-22T15:00:00-07:00'), end: at('2026-10-22T16:00:00-07:00') }, 'en-US'))
      .toBe('Thu, Oct 22, 3:00 PM to 4:00 PM');
  });

  it('a meeting past midnight repeats the end day', () => {
    expect(inviteWhen({ start: at('2026-10-22T23:00:00-07:00'), end: at('2026-10-23T01:00:00-07:00') }, 'en-US'))
      .toBe('Thu, Oct 22, 11:00 PM to Fri, Oct 23, 1:00 AM');
  });

  it('all day, one day and several', () => {
    expect(inviteWhen({ start: at('2026-10-22T00:00:00-07:00'), end: at('2026-10-23T00:00:00-07:00'), allDay: true }, 'en-US'))
      .toBe('Thu, Oct 22, all day');
    expect(inviteWhen({ start: at('2026-10-22T00:00:00-07:00'), end: at('2026-10-25T00:00:00-07:00'), allDay: true }, 'en-US'))
      .toBe('Thu, Oct 22 to Sat, Oct 24, all day');
  });

  it('no end is just the start, and no start is nothing at all', () => {
    expect(inviteWhen({ start: at('2026-10-22T15:00:00-07:00') }, 'en-US')).toBe('Thu, Oct 22, 3:00 PM');
    expect(inviteWhen({}, 'en-US')).toBe('');
  });

  it('never writes a dash', () => {
    const text = inviteWhen({ start: at('2026-10-22T15:00:00-07:00'), end: at('2026-10-22T16:00:00-07:00') }, 'en-US');
    expect(text).not.toMatch(/[–—-]/);
  });
});

describe('the answer words', () => {
  it('says where things stand in the person own terms', () => {
    expect(['none', 'accepted', 'tentative', 'declined', 'organizer', undefined].map((one) => inviteAnswerLine(one as never)))
      .toEqual([
        'You have not answered yet', 'You accepted', 'You said maybe', 'You declined',
        'This is your meeting', 'You have not answered yet',
      ]);
  });

  it('three buttons, each sending the answer the calendar will report back', () => {
    expect(INVITE_BUTTONS.map((one) => one.label)).toEqual(['Accept', 'Tentative', 'Decline']);
    expect(INVITE_BUTTONS.map((one) => answeredAs(one.response))).toEqual(['accepted', 'tentative', 'declined']);
  });
});
