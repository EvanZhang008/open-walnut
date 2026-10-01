/**
 * The invite marker in the envelope hash and the DTO, as pure functions.
 *
 * The hash rule is the load-bearing one: adding a field to `envelopeHashOf` marks every cached row
 * "updated" on the next poll, so the marker is appended ONLY when present, and every row that is not
 * an invite must keep the exact hash it had before the field existed.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { envelopeHashOf } from '../../src/integrations/mail/contract.js';
import { envelopeToDto, inviteMarkerOf, toDto } from '../../src/integrations/mail/service-dto.js';
import type { MailEnvelope } from '../../src/integrations/mail/types.js';
import type { MessageRow } from '../../src/integrations/mail/store.js';

const ENVELOPE: MailEnvelope = {
  messageId: 'INBOX:1:1',
  rfcMessageId: '<one@example.invalid>',
  mailboxId: 'INBOX',
  from: { name: 'Harbour Office', address: 'office@example.invalid' },
  to: [{ address: 'reader@example.invalid' }],
  subject: 'Mooring review',
  sentAt: 1_790_000_000_000,
  flags: [],
  attachments: [],
};

/** The hash exactly as it was computed before the marker existed. */
function hashBefore(envelope: MailEnvelope): string {
  return crypto.createHash('sha1').update(JSON.stringify([
    envelope.rfcMessageId, envelope.mailboxId, envelope.from, envelope.to, envelope.subject,
    envelope.sentAt, envelope.receivedAt ?? null, [...(envelope.flags ?? [])].sort(),
    envelope.attachments ?? [], envelope.sentAtHeader ?? null,
  ])).digest('hex');
}

describe('envelopeHashOf and the invite marker', () => {
  it('leaves every non-invite row with the hash it always had', () => {
    expect(envelopeHashOf(ENVELOPE)).toBe(hashBefore(ENVELOPE));
  });

  it('moves the hash when a row becomes, stops being, or changes kind of invite', () => {
    const request = envelopeHashOf({ ...ENVELOPE, invite: { kind: 'request' } });
    const canceled = envelopeHashOf({ ...ENVELOPE, invite: { kind: 'canceled' } });
    expect(request).not.toBe(envelopeHashOf(ENVELOPE));
    expect(canceled).not.toBe(request);
    expect(envelopeHashOf({ ...ENVELOPE, invite: { kind: 'request' } })).toBe(request);
  });
});

describe('the marker on the DTO', () => {
  function row(payload: Record<string, unknown>): MessageRow {
    return {
      rowid: 1,
      account_id: 'fixture:one',
      message_id: 'INBOX:1:1',
      rfc_message_id: '<one@example.invalid>',
      mailbox_id: 'INBOX',
      thread_id: null,
      from_addr: 'office@example.invalid',
      subject: 'Mooring review',
      snippet: '',
      sent_at: 1,
      received_at: null,
      flags_json: '[]',
      attachments_json: '[]',
      payload: JSON.stringify(payload),
      body_ref: null,
      body_bytes: null,
      body_error: null,
      envelope_hash: 'h',
    } as unknown as MessageRow;
  }

  it('carries a stored marker and only a well-formed one', () => {
    expect(toDto(row({ invite: { kind: 'request' } })).invite).toEqual({ kind: 'request' });
    expect(toDto(row({ invite: { kind: 'canceled', extra: 'x' } })).invite).toEqual({ kind: 'canceled' });
    expect('invite' in toDto(row({}))).toBe(false);
    expect('invite' in toDto(row({ invite: { kind: 'maybe' } }))).toBe(false);
    expect('invite' in toDto(row({ invite: 'request' }))).toBe(false);
  });

  it('carries it on a provider search hit too', () => {
    expect(envelopeToDto('fixture:one', { ...ENVELOPE, invite: { kind: 'request' } }, false).invite).toEqual({ kind: 'request' });
    expect('invite' in envelopeToDto('fixture:one', ENVELOPE, false)).toBe(false);
  });

  it('inviteMarkerOf accepts the two kinds and nothing else', () => {
    expect([{ kind: 'request' }, { kind: 'canceled' }, { kind: 'Request' }, null, undefined, 3].map(inviteMarkerOf))
      .toEqual([{ kind: 'request' }, { kind: 'canceled' }, undefined, undefined, undefined, undefined]);
  });
});
