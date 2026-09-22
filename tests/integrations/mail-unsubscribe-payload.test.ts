/**
 * What the cache stores about leaving a mailing list, and what it answers a list page with.
 *
 * All pure: the four rules below are the ones that decide whether an unsubscribe option survives an
 * ordinary day in a mailbox, and every one of them is checkable without a database.
 *
 * - THE MENU COSTS NOTHING. `available` is derived from the stored payload, so a fifty-row page pays
 *   no request and no query to know which rung each message can be handed to.
 * - A POLL MUST NOT ERASE IT. `envelopeHashOf` deliberately ignores the field (a hash that included
 *   it would mark every cached row "updated" on the first tick after the upgrade), so the poll that
 *   rewrites a row is never ABOUT this field — and rebuilding the payload from the envelope alone
 *   threw away what a body read had taught.
 * - A BODY MAY ONLY FILL A GAP. A body read is the one moment mail cached before the field existed
 *   can learn it. It is not a second authority on mail that already answered.
 * - A RETIRED BODY TAKES ONLY WHAT IT TAUGHT. The header fields describe the message; a link scraped
 *   from the markup describes bytes about to be unlinked.
 */
import { describe, it, expect } from 'vitest';
import { envelopeHashOf } from '../../src/integrations/mail/contract.js';
import {
  fillUnsubscribeFromBody,
  payloadForRetiredBody,
  unsubscribeForUpdate,
} from '../../src/integrations/mail/service-body.js';
import {
  toDto,
  unsubscribeAvailability,
  type MessagePayload,
  type StoredListUnsubscribe,
} from '../../src/integrations/mail/service-dto.js';
import type { MessageRow } from '../../src/integrations/mail/store.js';
import type { MailBody, MailEnvelope, MailListUnsubscribe } from '../../src/integrations/mail/types.js';

const HTTPS = 'https://lists.example.invalid/u/abc';
const MAILTO = 'mailto:leave@lists.example.invalid';

const HEADERS: MailListUnsubscribe = {
  https: [HTTPS],
  mailto: [MAILTO],
  oneClick: true,
  listId: 'weekly.lists.example.invalid',
};

function row(payload: MessagePayload): MessageRow {
  return {
    rowid: 1,
    account_id: 'imap:reader@example.invalid',
    message_id: 'INBOX:9001:42',
    rfc_message_id: '<weekly-42@lists.example.invalid>',
    mailbox_id: 'INBOX',
    thread_id: '<weekly-42@lists.example.invalid>',
    from_addr: 'weekly@lists.example.invalid',
    subject: 'Marina Weekly, issue 42',
    snippet: 'This week in the marina',
    sent_at: Date.UTC(2026, 8, 21, 16, 0, 0),
    received_at: Date.UTC(2026, 8, 21, 16, 0, 1),
    flags_json: '[]',
    attachments_json: '[]',
    body_ref: null,
    body_bytes: null,
    body_error: null,
    envelope_hash: 'h',
    payload: JSON.stringify(payload),
    updated_at: 0,
  } as unknown as MessageRow;
}

function availabilityOf(payload: MessagePayload): string | undefined {
  return toDto(row(payload)).unsubscribe?.available;
}

describe('the availability ladder', () => {
  it('reads the rung straight off the payload, cheapest work for the human first', () => {
    expect(unsubscribeAvailability(undefined)).toBe('none');
    expect(unsubscribeAvailability({ https: [HTTPS], mailto: [MAILTO], oneClick: true })).toBe('one-click');
    // The grant is specific: no `https` target means there is nothing to POST to, whatever the
    // companion header said.
    expect(unsubscribeAvailability({ mailto: [MAILTO], oneClick: true })).toBe('mailto');
    expect(unsubscribeAvailability({ https: [HTTPS], mailto: [MAILTO], oneClick: false })).toBe('mailto');
    expect(unsubscribeAvailability({ https: [HTTPS], oneClick: false })).toBe('link');
    expect(unsubscribeAvailability({ oneClick: false, bodyLink: HTTPS })).toBe('link');
    // A list key alone names the list and offers no way out of it.
    expect(unsubscribeAvailability({ oneClick: false, listId: 'news.example.invalid' })).toBe('none');
    expect(unsubscribeAvailability({ oneClick: false })).toBe('none');
  });

  it('rides the DTO of a cached row, and is absent when nothing was ever captured', () => {
    expect(availabilityOf({ listUnsubscribe: HEADERS })).toBe('one-click');
    expect(availabilityOf({ listUnsubscribe: { oneClick: false, mailto: [MAILTO] } })).toBe('mailto');
    // A row cached before the field existed carries NO key: absent and `'none'` are the same answer
    // to a console, and writing `{available:'none'}` onto every row of every page is bytes for
    // nothing. The client's own rule is `message.unsubscribe?.available ?? 'none'`.
    expect(toDto(row({})).unsubscribe).toBeUndefined();
    expect(JSON.stringify(toDto(row({})))).not.toContain('unsubscribe');
  });

  it('is stated honestly as none when a capture holds only a list key', () => {
    expect(availabilityOf({ listUnsubscribe: { oneClick: false, listId: 'news.example.invalid' } })).toBe('none');
  });
});

describe('the envelope hash', () => {
  function envelope(over: Partial<MailEnvelope> = {}): MailEnvelope {
    return {
      messageId: 'INBOX:9001:42',
      rfcMessageId: '<weekly-42@lists.example.invalid>',
      mailboxId: 'INBOX',
      from: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
      to: [{ address: 'reader@example.invalid' }],
      subject: 'Marina Weekly, issue 42',
      sentAt: Date.UTC(2026, 8, 21, 16, 0, 0),
      flags: [],
      attachments: [],
      ...over,
    };
  }

  it('ignores listUnsubscribe, so an upgrade rewrites nothing', () => {
    // The whole cost model of this slice rests on this line. If the field ever joins the hash, the
    // first tick after the upgrade rewrites every row a provider now reports headers for, re-indexes
    // each one for FTS, and puts a sync event on the bus per container — for news nobody asked for.
    expect(envelopeHashOf(envelope({ listUnsubscribe: HEADERS }))).toBe(envelopeHashOf(envelope()));
    expect(envelopeHashOf(envelope({ listUnsubscribe: { oneClick: false, https: [HTTPS] } })))
      .toBe(envelopeHashOf(envelope()));
    // A field that really is news still moves it, so this is not a hash that ignores everything.
    expect(envelopeHashOf(envelope({ subject: 'Issue 43' }))).not.toBe(envelopeHashOf(envelope()));
  });
});

describe('carry-forward through a poll that rewrites the row', () => {
  it('keeps what a body taught when the envelope says nothing', () => {
    const stored: MessagePayload = { listUnsubscribe: { ...HEADERS, bodyLink: HTTPS, bodyCandidates: 2 } };
    expect(unsubscribeForUpdate(undefined, stored)).toEqual(stored.listUnsubscribe);
  });

  it('lets the envelope win on the headers and keeps the body-found link', () => {
    // A list that moved its endpoint says so in the header the poll just re-read; the link the base
    // scraped out of the stored html is something no envelope knows about.
    const stored: MessagePayload = {
      listUnsubscribe: { https: ['https://old.example.invalid/u/1'], oneClick: false, bodyLink: HTTPS, bodyCandidates: 2 },
    };
    expect(unsubscribeForUpdate({ https: ['https://new.example.invalid/u/9'], oneClick: true }, stored)).toEqual({
      https: ['https://new.example.invalid/u/9'],
      oneClick: true,
      bodyLink: HTTPS,
      bodyCandidates: 2,
    });
  });

  it('answers undefined when neither side has anything, so no key is written', () => {
    expect(unsubscribeForUpdate(undefined, {})).toBeUndefined();
  });
});

describe('a body read may only fill a gap', () => {
  function body(over: Partial<MailBody> = {}): MailBody {
    return { format: 'text', text: 'Nothing much.', bytes: 13, ...over };
  }

  it('teaches a row that holds nothing', () => {
    const fill = fillUnsubscribeFromBody({}, body({ listUnsubscribe: HEADERS }));
    expect(fill.filled).toEqual(HEADERS);
    expect(fill.payload.listUnsubscribe).toEqual(HEADERS);
  });

  it('never erases what the envelope supplied, when the body reports none', () => {
    const stored: MessagePayload = { listUnsubscribe: HEADERS };
    const fill = fillUnsubscribeFromBody(stored, body());
    expect(fill.filled).toBeUndefined();
    expect(fill.payload).toBe(stored);
    expect(fill.payload.listUnsubscribe).toEqual(HEADERS);
  });

  it('never overwrites the envelope\'s answer with a DIFFERENT one', () => {
    // Same bytes read twice can genuinely disagree: a list rotates its opaque token per send, and
    // the stored one is the one the console has been showing and the ledger keyed its attempt on.
    const stored: MessagePayload = { listUnsubscribe: HEADERS };
    const fill = fillUnsubscribeFromBody(stored, body({
      listUnsubscribe: { https: ['https://lists.example.invalid/u/rotated'], oneClick: false },
    }));
    expect(fill.filled).toBeUndefined();
    expect(fill.payload.listUnsubscribe).toEqual(HEADERS);
  });

  it('fills the headers around a link the base had already scraped', () => {
    const stored: MessagePayload = { listUnsubscribe: { oneClick: false, bodyLink: HTTPS, bodyCandidates: 2 } };
    const fill = fillUnsubscribeFromBody(stored, body({ listUnsubscribe: HEADERS }));
    expect(fill.payload.listUnsubscribe).toEqual({ ...HEADERS, bodyLink: HTTPS, bodyCandidates: 2 });
    expect(fill.filled?.listId).toBe('weekly.lists.example.invalid');
  });

  it('leaves every other payload field exactly as it was', () => {
    const stored: MessagePayload = {
      from: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
      bodyFormat: 'both',
      bodyBytesHint: 42_749,
    };
    const fill = fillUnsubscribeFromBody(stored, body({ listUnsubscribe: HEADERS }));
    expect(fill.payload).toEqual({ ...stored, listUnsubscribe: HEADERS });
  });
});

describe('a retired body', () => {
  it('takes the scraped link with it and leaves the header fields standing', () => {
    const kept = payloadForRetiredBody({
      to: [{ address: 'reader@example.invalid' }],
      bodyFormat: 'both',
      bodyTruncated: true,
      from: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
      listUnsubscribe: { ...HEADERS, bodyLink: HTTPS, bodyCandidates: 3 },
    });
    expect(kept).toEqual({
      to: [{ address: 'reader@example.invalid' }],
      listUnsubscribe: HEADERS,
    });
  });

  it('drops the whole field when the capture was nothing but a scraped link', () => {
    // Nothing would be left but `oneClick: false`, which is not an answer worth storing.
    expect(payloadForRetiredBody({ listUnsubscribe: { oneClick: false, bodyLink: HTTPS, bodyCandidates: 1 } }))
      .toEqual({});
  });

  it('changes nothing for a row that never had the field', () => {
    expect(payloadForRetiredBody({ to: [{ address: 'reader@example.invalid' }], bodyFormat: 'text' }))
      .toEqual({ to: [{ address: 'reader@example.invalid' }] });
  });
});

describe('the stored shape', () => {
  it('is the provider contract plus the two fields only the base may set', () => {
    // A compile-time statement as much as a runtime one: a provider hands over `MailListUnsubscribe`,
    // and `bodyLink`/`bodyCandidates` are the base's own reading of the html it stored.
    const stored: StoredListUnsubscribe = { ...HEADERS, bodyLink: HTTPS, bodyCandidates: 2 };
    const fromProvider: MailListUnsubscribe = HEADERS;
    expect(Object.keys(stored).sort()).toEqual([
      'bodyCandidates', 'bodyLink', 'https', 'listId', 'mailto', 'oneClick',
    ]);
    expect(Object.keys(fromProvider)).not.toContain('bodyLink');
  });
});
