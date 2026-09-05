/**
 * The composer's autosave, the flush every send depends on, and who a server answer belongs to.
 *
 * Every property here is a way a draft can lose text or send a version nobody read:
 *
 * - THE FIRST KEYSTROKE CREATES ONE ROW. Two keystrokes 10ms apart must not be two POSTs, and a
 *   keystroke that lands DURING the create must become a PATCH rather than a second create.
 * - THE DEBOUNCE COALESCES. Typing a sentence is one save, not one per letter.
 * - LEAVING FLUSHES. Closing the pane, or opening any other message, saves what is pending. The
 *   cancel-on-open version of this lost the last 800ms of typing, and for a draft that had not been
 *   created yet it lost everything, because no POST was ever issued.
 * - AN ANSWER BELONGS TO THE COMPOSER THAT ASKED. A create cannot be recalled, so it can land while
 *   the pane shows another message on another account; binding it there makes the next PATCH write
 *   over the first draft's row.
 * - A SEND FLUSHES FIRST, AND REFUSES IF THAT FLUSH DID NOT LAND. Otherwise the human approves the
 *   version from 800ms ago, or is told "Sent" about text the server never received.
 * - AN INVALID RECIPIENT BLOCKS THE SAVE. Saving around it writes a row addressed to three of the
 *   four people who were typed, and a reopen of that row shows an enabled Send.
 * - A 409 OR 404 RE-READS AND RE-SEEDS. Somebody else moved the draft, so the copy on screen is not
 *   the truth, and telling the human "reloaded, check it" while showing their own text is a lie.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeMailComposer,
  onMailDraftEvent,
  openMailComposer,
  openMailDraft,
  openMailReplyComposer,
  setMailComposerFields,
} from '../../web/src/apps/mail/compose/compose-actions';
import { flushMailComposerSave } from '../../web/src/apps/mail/compose/compose-autosave';
import { askMailOnPhone, sendMailNow } from '../../web/src/apps/mail/compose/compose-send';
import { chipsFrom } from '../../web/src/apps/mail/compose/mail-address';
import { __resetMailStore, getMailSnapshot } from '../../web/src/apps/mail/mail-store';
import type { MailDraftDto, MailMessageDto } from '../../web/src/api/mail';

const ACCOUNT = 'fx:me@example.invalid';
const OTHER_ACCOUNT = 'fx:other@example.invalid';
const DRAFT_ID = 'dr-1';

interface Call { method: string; url: string; body?: Record<string, unknown> }

let calls: Call[] = [];
/** Revision per draft id, as a server holds it. */
let revisions: Record<string, number> = {};
let nextDraft = 0;
/** The status the next PATCHes answer with, so the 409 and 400 paths can be driven. */
let patchStatus = 200;
/** How many of the next PATCHes reject at the transport, like an offline tab. */
let patchThrows = 0;
/** When set, a create waits for the test to open it. */
let createGate: Promise<void> | null = null;
let openCreateGate: (() => void) | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function draftRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const draftId = String(over.draftId ?? DRAFT_ID);
  return {
    draftId,
    accountId: ACCOUNT,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    bodyMarkdown: '',
    revision: revisions[draftId] ?? 0,
    state: 'composing',
    origin: 'console',
    createdAt: 1,
    updatedAt: revisions[draftId] ?? 0,
    ...over,
  };
}

/** The id in `/mail/drafts/<id>…`, which is how the mock keeps two drafts apart. */
function idOf(url: string): string {
  return url.split('/mail/drafts/')[1]!.split('/')[0]!;
}

const MESSAGE: MailMessageDto = {
  messageId: 'INBOX:1:31',
  accountId: ACCOUNT,
  mailboxId: 'INBOX',
  rfcMessageId: '<keeper-31@example.invalid>',
  from: { name: 'Keeper', address: 'keeper@example.invalid' },
  to: [{ address: 'me@example.invalid' }],
  subject: 'Quarterly keeper report',
  snippet: '',
  sentAt: 1,
  flags: [],
  attachments: [],
  hasBody: true,
};

function reply(over: Partial<Parameters<typeof openMailReplyComposer>[0]> = {}) {
  return openMailReplyComposer({
    accountId: ACCOUNT,
    accountAddress: 'me@example.invalid',
    all: false,
    message: MESSAGE,
    bodyText: 'Attendance held up.',
    ...over,
  });
}

beforeEach(() => {
  calls = [];
  revisions = {};
  nextDraft = 0;
  patchStatus = 200;
  patchThrows = 0;
  createGate = null;
  openCreateGate = null;
  __resetMailStore();
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ method, url, ...(body ? { body } : {}) });

    if (method === 'POST' && url.endsWith('/mail/drafts')) {
      if (createGate) await createGate;
      const draftId = `dr-${++nextDraft}`;
      revisions[draftId] = 1;
      return json({
        draft: draftRow({
          draftId,
          accountId: body?.accountId,
          subject: body?.subject,
          bodyMarkdown: body?.bodyMarkdown,
          to: body?.to,
        }),
      }, 201);
    }
    if (method === 'PATCH') {
      if (patchThrows > 0) { patchThrows -= 1; throw new Error('the network is gone'); }
      if (patchStatus !== 200) {
        return json({
          error: patchStatus === 409 ? 'stale' : 'invalid',
          message: patchStatus === 409
            ? 'Draft dr-1 changed while it was being edited.'
            : 'A draft may hold at most 100 recipients.',
        }, patchStatus);
      }
      const draftId = idOf(url);
      revisions[draftId] = (revisions[draftId] ?? 0) + 1;
      return json({
        draft: draftRow({ draftId, subject: body?.subject, bodyMarkdown: body?.bodyMarkdown, to: body?.to }),
      });
    }
    if (method === 'DELETE' && url.includes('/mail/drafts/')) {
      return json({ ok: true, draft: draftRow({ draftId: idOf(url), state: 'discarded' }) });
    }
    if (method === 'POST' && url.includes('/request-send')) {
      const draftId = idOf(url);
      return json({
        draft: draftRow({ draftId, state: 'pending_approval', letterId: 'lt-1' }),
        letterId: 'lt-1',
      });
    }
    if (method === 'POST' && url.includes('/send')) {
      const draftId = idOf(url);
      return json({
        send: {
          sendId: 'sn-1',
          draftId,
          accountId: ACCOUNT,
          revision: revisions[draftId] ?? 1,
          idempotencyKey: `${draftId}:${revisions[draftId] ?? 1}`,
          approvalKind: 'console',
          approvalRef: 'console',
          state: 'sent',
          settledAt: 5,
          attemptedAt: 4,
        },
        draft: draftRow({ draftId, state: 'sent' }),
      });
    }
    if (method === 'GET' && url.includes('/mail/drafts/')) {
      return json({ draft: draftRow({ draftId: idOf(url), subject: 'from the server' }), sends: [] });
    }
    if (method === 'GET' && url.includes('/mail/drafts')) {
      return json({ drafts: [draftRow()] });
    }
    return json({ error: 'not-found', message: url }, 404);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetMailStore();
});

function countOf(method: string, fragment: string): number {
  return calls.filter((call) => call.method === method && call.url.includes(fragment)).length;
}

function composer() {
  const open = getMailSnapshot().composer;
  if (!open) throw new Error('no composer is open');
  return open;
}

function draftsOf(accountId: string): MailDraftDto[] {
  return getMailSnapshot().drafts[accountId] ?? [];
}

describe('the first keystroke', () => {
  it('creates exactly one draft for two keystrokes inside the debounce', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    setMailComposerFields({ subject: 'He' });
    expect(composer().save).toBe('saving');
    expect(countOf('POST', '/mail/drafts')).toBe(0);

    await vi.advanceTimersByTimeAsync(800);

    expect(countOf('POST', '/mail/drafts')).toBe(1);
    expect(countOf('PATCH', '/mail/drafts/')).toBe(0);
    // The row carries the LAST value, not the first: the debounce is what makes that true.
    expect(calls.find((one) => one.method === 'POST')?.body?.subject).toBe('He');
    expect(composer().draftId).toBe(DRAFT_ID);
    expect(composer().save).toBe('saved');
  });

  it('waits for the debounce before creating anything at all', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(700);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(countOf('POST', '/mail/drafts')).toBe(1);
  });

  it('turns a keystroke that lands during the create into one PATCH, not a second create', async () => {
    createGate = new Promise<void>((resolve) => { openCreateGate = resolve; });
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);
    expect(countOf('POST', '/mail/drafts')).toBe(1);

    setMailComposerFields({ body: 'hello' });
    openCreateGate!();
    await flushMailComposerSave();

    expect(countOf('POST', '/mail/drafts')).toBe(1);
    expect(countOf('PATCH', '/mail/drafts/')).toBe(1);
    expect(calls.find((one) => one.method === 'PATCH')?.body?.bodyMarkdown).toBe('hello');
  });

  it('creates the row at open for a reply, which has content nobody typed', async () => {
    void reply();
    await vi.advanceTimersByTimeAsync(10);

    const created = calls.find((one) => one.method === 'POST');
    expect(created?.body?.subject).toBe('Re: Quarterly keeper report');
    expect(created?.body?.inReplyTo).toEqual({ accountId: ACCOUNT, messageId: 'INBOX:1:31' });
    // The quote rides the BODY, because the body is what gets sent.
    expect(String(created?.body?.bodyMarkdown)).toContain('> Attendance held up.');
    expect(composer().quote).toContain('Keeper <keeper@example.invalid> wrote:');
  });

  /**
   * Reply all had nowhere to get Cc from until the DTO carried it: the arithmetic in
   * `replyPrefill` was already right (see mail-compose-address.test.ts) and was being handed a
   * message with the field stripped, so replying to all of a thread quietly dropped everyone who
   * was only in Cc. This grades the whole path: DTO to prefill to chips to the row on the server.
   */
  it('reply all seeds Cc from the message, minus this account, and saves it', async () => {
    void reply({
      all: true,
      message: {
        ...MESSAGE,
        to: [{ address: 'me@example.invalid' }, { address: 'team@example.invalid' }],
        cc: [{ address: 'WATCHER@example.invalid' }, { address: 'me@example.invalid' }],
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(composer().fields.to.map((one) => one.address)).toEqual(['keeper@example.invalid']);
    expect(composer().fields.cc.map((one) => one.address))
      .toEqual(['team@example.invalid', 'WATCHER@example.invalid']);
    // The Cc row is REVEALED, or the human sends to four people while looking at one.
    expect(composer().showCc).toBe(true);
    const created = calls.find((one) => one.method === 'POST');
    expect(created?.body?.cc).toEqual([
      { address: 'team@example.invalid' }, { address: 'WATCHER@example.invalid' },
    ]);
  });
});

describe('the debounce', () => {
  it('turns a burst of typing into one PATCH', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);

    setMailComposerFields({ body: 'a' });
    await vi.advanceTimersByTimeAsync(100);
    setMailComposerFields({ body: 'ab' });
    await vi.advanceTimersByTimeAsync(100);
    setMailComposerFields({ body: 'abc' });
    await vi.advanceTimersByTimeAsync(800);

    expect(countOf('PATCH', '/mail/drafts/')).toBe(1);
    expect(calls.at(-1)?.body?.bodyMarkdown).toBe('abc');
  });

  it('flushes the pending edit when the pane is closed, rather than dropping it', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);

    setMailComposerFields({ subject: 'Hello' });
    await closeMailComposer();

    expect(countOf('PATCH', '/mail/drafts/')).toBe(1);
    expect(calls.find((one) => one.method === 'PATCH')?.body?.subject).toBe('Hello');
    expect(getMailSnapshot().composer).toBeNull();
  });
});

describe('leaving one composer for another', () => {
  it('flushes the pending edit instead of cancelling it', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);

    // Inside the debounce, the human clicks New message again.
    setMailComposerFields({ subject: 'Hello' });
    await openMailComposer(ACCOUNT);

    expect(countOf('PATCH', `/mail/drafts/${DRAFT_ID}`)).toBe(1);
    expect(calls.find((one) => one.method === 'PATCH')?.body?.subject).toBe('Hello');
    expect(composer().draftId).toBeNull();
  });

  it('still creates a draft that was typed but never saved', async () => {
    void openMailComposer(ACCOUNT);
    // Not one full debounce has passed: without a flush here, no POST is ever issued and the
    // whole message is gone.
    setMailComposerFields({ to: chipsFrom('alice@example.invalid'), subject: 'Half typed' });
    await openMailDraft(draftRow({ draftId: 'dr-9' }) as unknown as MailDraftDto);

    expect(countOf('POST', '/mail/drafts')).toBe(1);
    expect(calls.find((one) => one.method === 'POST')?.body?.subject).toBe('Half typed');
    expect(draftsOf(ACCOUNT).map((one) => one.draftId)).toContain(DRAFT_ID);
    expect(composer().draftId).toBe('dr-9');
  });

  it('does not bind a create that lands after the switch to whatever is on screen', async () => {
    createGate = new Promise<void>((resolve) => { openCreateGate = resolve; });
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'For the first account' });
    await vi.advanceTimersByTimeAsync(800);
    expect(countOf('POST', '/mail/drafts')).toBe(1);

    // The create is in flight and cannot be recalled. The human opens a new message on ANOTHER
    // account, which does not wait for a request it has no handle on.
    const switched = openMailComposer(OTHER_ACCOUNT);
    openCreateGate!();
    await switched;
    await vi.advanceTimersByTimeAsync(10);

    // The blank composer is still blank: it did not adopt the other account's row.
    expect(composer().accountId).toBe(OTHER_ACCOUNT);
    expect(composer().draftId).toBeNull();
    // And the row that was created still exists, under the account that owns it.
    expect(draftsOf(ACCOUNT).map((one) => one.draftId)).toEqual([DRAFT_ID]);

    // Typing here creates a SECOND row rather than PATCHing the first account's draft.
    setMailComposerFields({ subject: 'For the second account' });
    await vi.advanceTimersByTimeAsync(800);
    expect(countOf('PATCH', `/mail/drafts/${DRAFT_ID}`)).toBe(0);
    expect(countOf('POST', '/mail/drafts')).toBe(2);
    expect(composer().draftId).toBe('dr-2');
  });

  it('deletes a reply that never got a word of its own', async () => {
    void reply();
    await vi.advanceTimersByTimeAsync(10);
    const draftId = composer().draftId!;
    expect(draftId).toBe(DRAFT_ID);

    await closeMailComposer();

    // A quote nobody added to is not a draft, so it does not survive in Drafts as one.
    expect(countOf('DELETE', `/mail/drafts/${draftId}`)).toBe(1);
    expect(draftsOf(ACCOUNT)).toEqual([]);
  });

  it('keeps a reply that was actually written', async () => {
    void reply();
    await vi.advanceTimersByTimeAsync(10);
    setMailComposerFields({ body: 'Noted, thank you.' });
    await closeMailComposer();

    expect(countOf('DELETE', '/mail/drafts/')).toBe(0);
    expect(calls.at(-1)?.method).not.toBe('DELETE');
  });
});

describe('a recipient the server would refuse', () => {
  it('blocks the save entirely, and saves everything once it is fixed', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ to: chipsFrom('a@x.invalid, nope, b@y.invalid'), subject: 'Lunch' });
    await vi.advanceTimersByTimeAsync(800);

    // Nothing at all: a row addressed to two of the three typed recipients is worse than no row.
    expect(calls).toHaveLength(0);
    expect(composer().save).toBe('blocked');
    expect(composer().notice).toContain('"nope"');

    setMailComposerFields({ to: chipsFrom('a@x.invalid, c@z.invalid, b@y.invalid') });
    await vi.advanceTimersByTimeAsync(800);

    expect(countOf('POST', '/mail/drafts')).toBe(1);
    expect(calls[0]?.body?.to).toEqual([
      { address: 'a@x.invalid' }, { address: 'c@z.invalid' }, { address: 'b@y.invalid' },
    ]);
    expect(composer().save).toBe('saved');
  });
});

describe('a save that could not land', () => {
  it('re-reads AND re-seeds the draft on a 409, so the form is the protected version', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);

    patchStatus = 409;
    setMailComposerFields({ subject: 'Hello' });
    await vi.advanceTimersByTimeAsync(800);
    await vi.advanceTimersByTimeAsync(10);

    expect(composer().save).toBe('failed');
    expect(composer().notice).toContain('changed somewhere else');
    expect(countOf('GET', `/mail/drafts/${DRAFT_ID}`)).toBe(1);
    // The FIELD is what the human reads and what the next keystroke would PATCH back, so the
    // re-read has to reach it, not just the record behind it.
    expect(composer().fields.subject).toBe('from the server');
    expect(composer().draft?.subject).toBe('from the server');
  });

  it('retries a transport failure and lands on saved', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);

    patchThrows = 1;
    setMailComposerFields({ subject: 'Hello' });
    await vi.advanceTimersByTimeAsync(800);
    expect(composer().save).toBe('retrying');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(composer().save).toBe('saved');
    expect(countOf('PATCH', '/mail/drafts/')).toBe(2);
  });

  it('gives up at once on a 400, which the server will answer the same way five times', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ subject: 'H' });
    await vi.advanceTimersByTimeAsync(800);

    patchStatus = 400;
    setMailComposerFields({ subject: 'Hello' });
    await vi.advanceTimersByTimeAsync(800);

    expect(composer().save).toBe('failed');
    expect(composer().notice).toContain('at most 100 recipients');
    // ONE attempt, and the reason immediately: not five of them over ten seconds of "retrying".
    expect(countOf('PATCH', '/mail/drafts/')).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countOf('PATCH', '/mail/drafts/')).toBe(1);
  });
});

describe('a send flushes first', () => {
  it('asks the phone about the revision that is really on disk', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ to: chipsFrom('alice@example.invalid'), subject: 'Lunch' });
    await vi.advanceTimersByTimeAsync(800);
    // One more keystroke, and then a send BEFORE the debounce would have fired.
    setMailComposerFields({ body: 'one?' });

    await askMailOnPhone();

    const order = calls.filter((one) => one.method !== 'GET').map((one) => `${one.method} ${one.url.split('/mail')[1]}`);
    expect(order).toEqual([
      'POST /drafts',
      `PATCH /drafts/${DRAFT_ID}`,
      `POST /drafts/${DRAFT_ID}/request-send`,
    ]);
    const asked = calls.find((one) => one.url.includes('/request-send'));
    expect(asked?.body?.revision).toBe(2);
    expect(composer().mode).toBe('status');
    expect(composer().status.phase).toBe('waiting');
    expect(composer().status.letterId).toBe('lt-1');
  });

  it('refuses to send while an address is still wrong', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ to: chipsFrom('alice@example.invalid, nope'), subject: 'Lunch' });
    await vi.advanceTimersByTimeAsync(800);

    await sendMailNow();

    expect(calls.some((one) => one.url.includes('/send'))).toBe(false);
    expect(composer().notice).toContain('addresses in red');
    expect(composer().mode).toBe('edit');
  });

  it('refuses to send when the flush could not land, rather than sending the older revision', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ to: chipsFrom('alice@example.invalid'), subject: 'Lunch' });
    await vi.advanceTimersByTimeAsync(800);

    // The newest edit cannot reach the server, and the flush's own retry cannot either. The row is at
    // revision 1; the human is looking at revision 2.
    patchThrows = 9;
    setMailComposerFields({ body: 'the sentence that matters' });
    await vi.advanceTimersByTimeAsync(800);
    expect(composer().save).toBe('retrying');

    await askMailOnPhone();

    expect(calls.some((one) => one.url.includes('/request-send'))).toBe(false);
    expect(composer().notice).toContain('could not save your latest edit');
    expect(composer().mode).toBe('edit');
  });

  it('shows the card as sent when the console send settles inside the request', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ to: chipsFrom('alice@example.invalid'), subject: 'Lunch', body: 'one?' });
    await vi.advanceTimersByTimeAsync(800);

    await sendMailNow();

    expect(composer().mode).toBe('status');
    expect(composer().status.phase).toBe('sent');
    expect(composer().status.sendId).toBe('sn-1');
  });
});

describe('the phone answering Edit', () => {
  it('takes the card down instead of leaving an empty one', async () => {
    void openMailComposer(ACCOUNT);
    setMailComposerFields({ to: chipsFrom('alice@example.invalid'), subject: 'Lunch', body: 'one?' });
    await vi.advanceTimersByTimeAsync(800);
    await askMailOnPhone();
    expect(composer().mode).toBe('status');

    // The letter is answered with `edit`: the server unfreezes the draft at the same revision, so
    // the card has nothing left to describe.
    onMailDraftEvent('draft-changed', {
      draftId: DRAFT_ID, state: 'composing', revision: composer().status.revision,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(composer().mode).toBe('edit');
    expect(composer().notice).toContain('Nothing was sent');
    expect(composer().status.letterId).toBeUndefined();
  });
});
