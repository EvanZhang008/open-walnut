/**
 * The `Unsubscribe` row of the message menu, in every state it has, as DATA.
 *
 * Graded here rather than in a browser because most of these states cannot be reached by clicking: an
 * attempt in flight, a page that wants a confirmation, a list left through a DIFFERENT mail, an agent's
 * letter still waiting. Each one is a different sentence, and the sentences are the feature — a row that
 * says `Unsubscribed ✓` about a list somebody is still on is worse than no row at all.
 *
 * What is pinned, beyond the labels:
 *
 * - THE PRECEDENCE. `in-flight` beats `done` beats `needs-human` beats the `available` question, and
 *   `done` + a failed attempt is a real pair (left the list through another mail, failed on this one).
 * - "THIS LIST" AGAINST "THIS SENDER", decided by `keyedBy` and never guessed. A ledger keyed on a
 *   sender's address is coarser than one keyed on `List-Id`, and overstating it tells somebody they are
 *   off a list that is still sending.
 * - THE SMTP GATE IS NARROW: only a click that would really send a mail (a `mailto`-only message, in
 *   `ready` or `failed`). An https rung needs no SMTP, and `done` / `needs-human` never send.
 * - EVERY DISABLED STATE CARRIES A TITLE. The menu's own rule: greyed out with no reason reads as
 *   "this whole feature is broken".
 */
import { describe, it, expect } from 'vitest';
import {
  UNSUBSCRIBE_ASKED_TITLE,
  UNSUBSCRIBE_ASK_TITLE,
  UNSUBSCRIBE_LABELS,
  UNSUBSCRIBE_NONE_TITLE,
  UNSUBSCRIBE_RETRY_TITLE,
  unsubscribeDoneTitle,
  unsubscribeHandsOverToAsk,
  unsubscribeRowState,
  unsubscribeStatusLine,
} from '../../web/src/apps/mail/mail-unsubscribe-state';
import { CANNOT_SEND_TITLE } from '../../web/src/apps/mail/compose/send-status';
import type { MailMessageDto, MailUnsubscribeDto } from '../../web/src/api/mail';

/** 21 September 2026, the day every fixture below is "today". */
const NOW = Date.UTC(2026, 8, 21, 14, 10, 0);
const LAST_YEAR = Date.UTC(2025, 8, 21, 14, 10, 0);

function message(unsubscribe?: MailUnsubscribeDto): Pick<MailMessageDto, 'unsubscribe'> {
  return unsubscribe ? { unsubscribe } : {};
}

function state(unsubscribe?: MailUnsubscribeDto, canSend = true) {
  return unsubscribeRowState({ message: message(unsubscribe), canSend, now: NOW });
}

/** The short date the titles carry, computed the way the module does so the assertion is about wording. */
function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

describe('the four states the design names', () => {
  it('none: present, disabled, and says what can try instead', () => {
    expect(state()).toEqual({
      status: 'none',
      label: 'Unsubscribe',
      title: UNSUBSCRIBE_NONE_TITLE,
      disabled: true,
      action: 'none',
    });
    // The design's exact wording. It is the one place the menu points at the Ask rows above it.
    expect(UNSUBSCRIBE_NONE_TITLE).toBe('No unsubscribe link found. Ask Walnut can try.');
    // An absent field reads exactly as `available: 'none'`, which is the documented contract.
    expect(state({ available: 'none' }).status).toBe('none');
  });

  it('pending: `Unsubscribing…`, disabled, and no click to make', () => {
    const row = state({ available: 'one-click', attempt: { status: 'in-flight', at: NOW } });
    expect(row).toMatchObject({
      status: 'pending',
      label: 'Unsubscribing…',
      disabled: true,
      action: 'none',
    });
    expect(row.title).toBeTruthy();
    expect(UNSUBSCRIBE_LABELS.pending).toBe('Unsubscribing…');
  });

  it('done: `Unsubscribed ✓`, STILL CLICKABLE, titled with the method and the day', () => {
    const row = state({
      available: 'one-click',
      done: { method: 'one-click', at: NOW, scope: 'message' },
    });
    expect(row).toMatchObject({ status: 'done', label: 'Unsubscribed ✓', disabled: false, action: 'run' });
    expect(row.title).toBe(`Unsubscribed via one-click · ${day(NOW)}`);
  });

  it('needs-human: `Finish unsubscribing…`, and the click opens the drawer with the reason', () => {
    const row = state({
      available: 'link',
      attempt: { status: 'needs-human', reason: 'confirm-form', at: NOW },
    });
    expect(row).toEqual({
      status: 'needs-human',
      label: 'Finish unsubscribing…',
      title: UNSUBSCRIBE_ASK_TITLE,
      disabled: false,
      action: 'ask',
      reason: 'confirm-form',
    });
  });
});

describe('the states beyond those four', () => {
  it('ready: the plain row, enabled, with nothing extra to say', () => {
    expect(state({ available: 'one-click' })).toEqual({
      status: 'ready',
      label: 'Unsubscribe',
      title: '',
      disabled: false,
      action: 'run',
    });
  });

  it('failed: the same label, enabled, and the title says the click is a retry', () => {
    expect(state({ available: 'link', attempt: { status: 'failed', reason: 'http-403', at: NOW } })).toEqual({
      status: 'failed',
      label: 'Unsubscribe',
      title: UNSUBSCRIBE_RETRY_TITLE,
      disabled: false,
      action: 'run',
    });
  });

  it('asked: the agent\'s letter is waiting, so the answer goes there and not here', () => {
    // `needs-human` with `reason: 'asked'` is the agent's own ask, and it means the opposite of the other
    // `needs-human`: nothing has been opened, so there is no page to finish. The ledger WOULD let a click
    // through, which is exactly why this one is disabled rather than merely relabelled.
    expect(state({ available: 'mailto', attempt: { status: 'needs-human', reason: 'asked', at: NOW } }))
      .toEqual({
        status: 'asked',
        label: 'Waiting on your answer',
        title: UNSUBSCRIBE_ASKED_TITLE,
        disabled: true,
        action: 'none',
      });
  });
});

describe('which state wins when two are true', () => {
  it('an attempt in flight outranks a done, because it is the only one about right now', () => {
    expect(state({
      available: 'link',
      done: { method: 'link', at: LAST_YEAR, scope: 'list', keyedBy: 'list-id' },
      attempt: { status: 'in-flight', at: NOW },
    }).status).toBe('pending');
  });

  it('a done outranks a failed attempt on the same mail', () => {
    // The real pair: they left the list through another mail, and their click on THIS one failed. What
    // they need to know is that they are off the list.
    const row = state({
      available: 'link',
      done: { method: 'one-click', at: NOW, scope: 'list', keyedBy: 'list-id' },
      attempt: { status: 'failed', reason: 'http-403', at: NOW },
    });
    expect(row.status).toBe('done');
    expect(row.title).toBe(`You unsubscribed from this list on ${day(NOW)}`);
  });

  it('a done outranks the `none` availability, which is the old-row case', () => {
    // A row cached before Walnut asked for the headers: no link of its own, but the SENDER is the ledger
    // key and the human has already left. A menu that said "no unsubscribe link found" here would offer
    // to do it again two rows down the list.
    const row = state({ available: 'none', done: { method: 'link', at: NOW, scope: 'list', keyedBy: 'sender' } });
    expect(row.status).toBe('done');
    expect(row.title).toBe(`You unsubscribed from this sender on ${day(NOW)}`);
  });

  it('`needs-human` outranks the availability question too', () => {
    expect(state({ available: 'none', attempt: { status: 'needs-human', reason: 'unclear', at: NOW } }).status)
      .toBe('needs-human');
  });
});

describe('the list-level memory, and the word it is allowed to use', () => {
  it('says "this list" only when the key came from a List-Id', () => {
    expect(unsubscribeDoneTitle({ method: 'one-click', at: NOW, scope: 'list', keyedBy: 'list-id' }, NOW))
      .toBe(`You unsubscribed from this list on ${day(NOW)}`);
  });

  it('says "this sender" when the key came from the address, which is coarser', () => {
    expect(unsubscribeDoneTitle({ method: 'one-click', at: NOW, scope: 'list', keyedBy: 'sender' }, NOW))
      .toBe(`You unsubscribed from this sender on ${day(NOW)}`);
  });

  it('understates rather than overstates when the server did not say', () => {
    // Absent `keyedBy` reads as `sender`: "this sender" is true whenever "this list" is, so the safe
    // direction is the narrower claim.
    expect(unsubscribeDoneTitle({ method: 'link', at: NOW, scope: 'list' }, NOW))
      .toContain('this sender');
  });

  it('names the rung on a message-scope row, and never a list noun', () => {
    for (const [method, phrase] of [
      ['one-click', 'one-click'],
      ['mailto', 'a mail to the list'],
      ['link', 'the unsubscribe page'],
    ] as const) {
      expect(unsubscribeDoneTitle({ method, at: NOW, scope: 'message' }, NOW))
        .toBe(`Unsubscribed via ${phrase} · ${day(NOW)}`);
    }
  });

  it('carries the year when it is not this year, and no year when it is', () => {
    expect(unsubscribeDoneTitle({ method: 'link', at: NOW, scope: 'message' }, NOW)).not.toMatch(/2026/);
    expect(unsubscribeDoneTitle({ method: 'link', at: LAST_YEAR, scope: 'message' }, NOW)).toMatch(/2025/);
  });

  it('drops the date entirely rather than printing an epoch', () => {
    expect(unsubscribeDoneTitle({ method: 'one-click', at: 0, scope: 'message' }, NOW))
      .toBe('Unsubscribed via one-click');
    expect(unsubscribeDoneTitle({ method: 'one-click', at: 0, scope: 'list', keyedBy: 'list-id' }, NOW))
      .toBe('You unsubscribed from this list');
  });
});

describe('the SMTP gate, which is only about the rung that sends a mail', () => {
  it('disables a mailto-only message on an account that cannot send, with the reason', () => {
    expect(state({ available: 'mailto' }, false)).toEqual({
      status: 'ready',
      label: 'Unsubscribe',
      title: CANNOT_SEND_TITLE,
      disabled: true,
      action: 'none',
    });
  });

  it('leaves every other availability enabled without SMTP: an https rung needs none', () => {
    for (const available of ['one-click', 'link'] as const) {
      expect(state({ available }, false)).toMatchObject({ disabled: false, action: 'run' });
    }
  });

  it('disables a mailto-only RETRY too, because that click would send as well', () => {
    expect(state({ available: 'mailto', attempt: { status: 'failed', reason: 'send-failed', at: NOW } }, false))
      .toMatchObject({ status: 'failed', disabled: true, action: 'none', title: CANNOT_SEND_TITLE });
  });

  it('leaves `done` clickable without SMTP, because that click cannot reach a send', () => {
    // The ledger refuses to re-claim a `done` row, so the request answers `409 already` and nothing is
    // sent. Gating it on SMTP would grey out a row whose click is harmless and whose title is the fact.
    expect(state({
      available: 'mailto',
      done: { method: 'mailto', at: NOW, scope: 'message' },
    }, false)).toMatchObject({ status: 'done', disabled: false, action: 'run' });
  });

  it('leaves `needs-human` clickable without SMTP: it opens a drawer, it does not send', () => {
    expect(state({
      available: 'mailto',
      attempt: { status: 'needs-human', reason: 'confirm-form', at: NOW },
    }, false)).toMatchObject({ status: 'needs-human', disabled: false, action: 'ask' });
  });
});

describe('every disabled state says why', () => {
  it('has a non-empty title wherever it is disabled', () => {
    const cases: Array<MailUnsubscribeDto | undefined> = [
      undefined,
      { available: 'none' },
      { available: 'one-click', attempt: { status: 'in-flight', at: NOW } },
      { available: 'mailto', attempt: { status: 'needs-human', reason: 'asked', at: NOW } },
    ];
    for (const one of cases) {
      const row = state(one);
      expect(row.disabled, JSON.stringify(one)).toBe(true);
      expect(row.title.length, JSON.stringify(one)).toBeGreaterThan(0);
    }
    expect(state({ available: 'mailto' }, false).title).toBe(CANNOT_SEND_TITLE);
  });

  it('never offers a click on a row it disabled', () => {
    const disabled = [
      state(),
      state({ available: 'one-click', attempt: { status: 'in-flight', at: NOW } }),
      state({ available: 'mailto' }, false),
    ];
    for (const row of disabled) expect(row.action).toBe('none');
  });
});

describe('which verdict hands the rest to Ask Walnut', () => {
  it('hands over every needs-human except the agent\'s own ask', () => {
    expect(unsubscribeHandsOverToAsk({ status: 'needs-human', reason: 'confirm-form' })).toBe(true);
    expect(unsubscribeHandsOverToAsk({ status: 'needs-human', reason: 'unclear' })).toBe(true);
    // No reason at all is still a page that stopped, so it still hands over.
    expect(unsubscribeHandsOverToAsk({ status: 'needs-human' })).toBe(true);
    // The one exception: the agent already put the question in the human's inbox, so there is nothing
    // open to finish and a drawer here would be Walnut answering its own letter.
    expect(unsubscribeHandsOverToAsk({ status: 'needs-human', reason: 'asked' })).toBe(false);
  });

  it('hands over on nothing else, including the two that look like progress', () => {
    for (const status of ['done', 'in-flight', 'failed', 'already', 'unsupported']) {
      expect(unsubscribeHandsOverToAsk({ status }), status).toBe(false);
    }
    // A coalesced second click answers with nothing at all, which is not a verdict.
    expect(unsubscribeHandsOverToAsk(null)).toBe(false);
    expect(unsubscribeHandsOverToAsk(undefined)).toBe(false);
  });
});

describe('the reader\'s status line', () => {
  it('says nothing in the two states the button already speaks for', () => {
    expect(unsubscribeStatusLine(message(), NOW)).toBeNull();
    expect(unsubscribeStatusLine(message({ available: 'one-click' }), NOW)).toBeNull();
  });

  it('repeats the menu\'s own done sentence, so the two can never disagree', () => {
    const held: MailUnsubscribeDto = {
      available: 'one-click',
      done: { method: 'one-click', at: NOW, scope: 'message' },
    };
    expect(unsubscribeStatusLine(message(held), NOW)).toEqual({
      status: 'done',
      text: `Unsubscribed via one-click · ${day(NOW)}`,
    });
  });

  it('has a short line for each state somebody has to act on', () => {
    const lines = [
      [{ available: 'link', attempt: { status: 'in-flight', at: NOW } }, 'pending'],
      [{ available: 'link', attempt: { status: 'needs-human', reason: 'confirm-form', at: NOW } }, 'needs-human'],
      [{ available: 'mailto', attempt: { status: 'needs-human', reason: 'asked', at: NOW } }, 'asked'],
      [{ available: 'link', attempt: { status: 'failed', reason: 'timeout', at: NOW } }, 'failed'],
    ] as const;
    for (const [held, status] of lines) {
      const line = unsubscribeStatusLine(message(held as MailUnsubscribeDto), NOW);
      expect(line?.status, status).toBe(status);
      expect(line?.text.length, status).toBeGreaterThan(0);
    }
  });
});
