/**
 * The AI rung: an agent can ASK to leave a list, and that is the whole of its reach.
 *
 * The claim this file grades is a negative one, so it is graded the only way a negative can be: with
 * spies on every way out of the process. `mail_unsubscribe_request` runs against a real plugin
 * database and a real message, and afterwards
 *
 *   . the HTTP seam saw zero fetches and zero DNS lookups,
 *   . `MailApprovals.consoleSend` was never entered (a prototype spy, so it holds when S8's mailto rung
 *     lands and this file is not edited),
 *   . the provider's `send` was never called,
 *
 * and what DID happen is one letter with two buttons, plus a ledger row naming it.
 *
 * The rest is the letter's own honesty. A one-click list, a page-only list and a mailto-only list get
 * three different descriptions of what Walnut would do, because the rungs differ in how final they are,
 * and an account that supplies no unsubscribe headers at all (the Outlook shape) has to be told that
 * the link found in the message is the only way out there.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import { MailApprovals, type ApprovalLetters } from '../../src/integrations/mail/approvals.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import type { UnsubscribeRow } from '../../src/integrations/mail/store-write.js';
import {
  MailUnsubscribe,
  UNSUBSCRIBE_LETTER_ACTIONS,
  unsubscribeSendApproval,
} from '../../src/integrations/mail/unsubscribe.js';
import type { UnsubscribeHttpSeam } from '../../src/integrations/mail/unsubscribe-http.js';
import type {
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailListUnsubscribe,
  MailProviderSpec,
} from '../../src/integrations/mail/types.js';

/**
 * The deps `MailUnsubscribe` takes, read off its own constructor.
 *
 * Partial on purpose: this file grades the ASK, which needs the ledger, the cache and the letters, and
 * spelling out the rungs' own dependencies would make every test here fail the day one of them grows a
 * new one. `ConstructorParameters` rather than a hand-written type so the cast cannot go stale.
 */
type UnsubscribeDeps = ConstructorParameters<typeof MailUnsubscribe>[0];

function makeUnsubscribe(deps: Partial<UnsubscribeDeps>): MailUnsubscribe {
  return new MailUnsubscribe(deps as UnsubscribeDeps);
}

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: true, sendAsReply: false, bodies: 'both', attachments: 'none',
};

const ACCOUNT = 'listy:acct-1';
const HOST = 'lists.example.invalid';
const SENT_AT = Date.UTC(2026, 8, 21, 16, 0, 0);
const MESSAGE = 'INBOX:9001:42';

interface SentLetter {
  letterId: string;
  subject: string;
  markdown: string;
  actions: Array<{ id: string; label: string; description?: string }>;
  answered?: { actionId: string; label: string; at: number };
}

interface Harness {
  store: MailStore;
  service: MailService;
  unsubscribe: MailUnsubscribe;
  letters: SentLetter[];
  replies: Array<{ letterId: string; markdown: string }>;
  withdrawn: Array<{ letterId: string; note: string }>;
  /** Everything the guarded transport was asked to do. Must stay empty for the op path. */
  fetches: string[];
  lookups: string[];
  sends: number;
  clock: { at: number };
  bodyHtml: { current: string };
  consoleSend: ReturnType<typeof vi.spyOn>;
}

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openHarness(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-unsub-agent-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const bodyHtml = { current: '<p>This week in the marina.</p>' };
  const counts = { sends: 0 };

  const spec: MailProviderSpec = {
    id: 'listy',
    label: 'A fixture list',
    capabilities: { ...CAPABILITIES },
    setup: { fields: [], submit: async () => { throw new Error('by hand'); } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (): Promise<MailBody> => ({
      format: 'both',
      text: 'This week in the marina.',
      html: bodyHtml.current,
      bytes: Buffer.byteLength(bodyHtml.current),
    }),
    // Counted, never expected: the op must not reach a transport, and neither must the letter it
    // sends until a human answers it.
    send: async () => { counts.sends += 1; return { acceptedAt: Date.now() }; },
  };
  providers.register(spec, 'the-fixture-plugin');

  const fetches: string[] = [];
  const lookups: string[] = [];
  const seam: UnsubscribeHttpSeam = {
    fetch: (url) => {
      fetches.push(url);
      throw new Error('the op path must never reach the transport');
    },
    lookup: async (hostname) => {
      lookups.push(hostname);
      throw new Error('the op path must never resolve a host');
    },
  };

  const letters: SentLetter[] = [];
  const replies: Array<{ letterId: string; markdown: string }> = [];
  const withdrawn: Array<{ letterId: string; note: string }> = [];
  let nextLetter = 0;
  const lettersApi: ApprovalLetters = {
    send: async (input) => {
      nextLetter += 1;
      letters.push({
        letterId: `lt-fixture-${nextLetter}`,
        subject: input.subject,
        markdown: input.markdown ?? '',
        actions: (input.actions ?? []).map((one) => ({ ...one })),
      });
      return { letterId: `lt-fixture-${nextLetter}` };
    },
    reply: async (letterId, input) => { replies.push({ letterId, markdown: input.markdown ?? input.text ?? '' }); },
    withdraw: async (letterId, input) => { withdrawn.push({ letterId, note: input.note }); },
    get: async (letterId) => {
      const found = letters.find((one) => one.letterId === letterId);
      if (!found) return null;
      return { letterId, ...(found.answered ? { answered: found.answered } : {}) };
    },
  };

  const clock = { at: Date.UTC(2026, 8, 22, 9, 0, 0) };
  const events = new MailEvents(() => undefined);
  const service = new MailService({ store, bodies, providers, log: { info: vi.fn(), debug: vi.fn() } });
  const unsubscribe = makeUnsubscribe({
    store,
    service,
    events,
    letters: lettersApi,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    now: () => clock.at,
    http: seam,
  });

  // A PROTOTYPE spy, deliberately. `MailUnsubscribe` does not hold an approvals reference in every
  // slice, and the property being pinned is "no console approval is ever minted on this path", which a
  // prototype spy keeps stating whichever way the mailto rung is wired.
  const consoleSend = vi.spyOn(MailApprovals.prototype, 'consoleSend');

  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'listy',
    displayName: 'Personal mail',
    address: 'reader@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });

  return {
    store, service, unsubscribe, letters, replies, withdrawn, fetches, lookups,
    clock, bodyHtml, consoleSend,
    get sends() { return counts.sends; },
  } as Harness;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

function listing(over: Partial<MailEnvelope> & { uid?: number } = {}): MailEnvelope {
  const { uid = 42, ...rest } = over;
  return {
    messageId: `INBOX:9001:${uid}`,
    rfcMessageId: `<weekly-${uid}@lists.example.invalid>`,
    mailboxId: 'INBOX',
    from: { name: 'Marina Weekly', address: 'weekly@lists.example.invalid' },
    to: [{ address: 'reader@example.invalid' }],
    subject: `Marina Weekly, issue ${uid}`,
    snippet: 'This week in the marina',
    sentAt: SENT_AT + uid,
    receivedAt: SENT_AT + uid,
    flags: [],
    attachments: [],
    ...rest,
  };
}

function headers(over: Partial<MailListUnsubscribe> = {}): MailListUnsubscribe {
  return {
    https: [`https://${HOST}/u/abc`],
    oneClick: true,
    listId: 'weekly.lists.example.invalid',
    ...over,
  };
}

async function ledgerRow(one: Harness, messageId = MESSAGE): Promise<UnsubscribeRow | undefined> {
  return one.store.write.getUnsubscribe(ACCOUNT, messageId);
}

/** Every way out of the process this op must not take. Asserted after every successful ask. */
function assertNothingLeftTheMachine(one: Harness): void {
  expect(one.fetches, 'the op must make no request').toEqual([]);
  expect(one.lookups, 'the op must not even resolve the sender host').toEqual([]);
  expect(one.sends, 'the op must send no mail').toBe(0);
  expect(one.consoleSend, 'the op must not mint a console approval').not.toHaveBeenCalled();
  expect(one.withdrawn, 'a successful ask withdraws nothing').toEqual([]);
}

describe('the op only ever asks', () => {
  it('sends one letter with two buttons and touches nothing else', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);

    const asked = await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    expect(asked).toEqual({
      letterId: 'lt-fixture-1',
      method: 'one-click',
      url: `https://${HOST}/u/abc`,
      listKey: 'weekly.lists.example.invalid',
    });
    assertNothingLeftTheMachine(one);

    expect(one.letters).toHaveLength(1);
    const letter = one.letters[0]!;
    expect(letter.actions.map((action) => action.id)).toEqual(['unsubscribe', 'not-now']);
    expect(letter.actions.map((action) => action.label)).toEqual(['Unsubscribe', 'Not now']);
    // The ids the handler switches on, taken from the exported constant rather than retyped here.
    expect(letter.actions.map((action) => action.id))
      .toEqual(UNSUBSCRIBE_LETTER_ACTIONS.map((action) => action.id));
    expect(letter.subject).toBe('Unsubscribe from weekly.lists.example.invalid?');
  });

  it('names the message, the account and the exact page in the letter', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);

    const body = one.letters[0]!.markdown;
    expect(body).toContain('weekly@lists.example.invalid');
    expect(body).toContain('Marina Weekly, issue 42');
    // The account LABEL, read off the mirror row, not the opaque account id.
    expect(body).toContain('Personal mail');
    expect(body).not.toContain(ACCOUNT);
    // Fenced, so the url is exactly what the sender published and markdown cannot restructure it.
    expect(body).toContain(`\`\`\`\nhttps://${HOST}/u/abc\n\`\`\``);
    expect(body).toContain('Walnut has done nothing yet');
  });

  it('records a needs-human row naming the letter, and announces nothing on the bus', async () => {
    const seen: string[] = [];
    const one = await openHarness();
    // A second events sink, so the assertion is about THIS module rather than about the harness.
    const events = new MailEvents((name) => { seen.push(name); });
    const watched = makeUnsubscribe({
      store: one.store,
      service: one.service,
      events,
      letters: {
        send: async () => ({ letterId: 'lt-watched-1' }),
        reply: async () => undefined,
        withdraw: async () => undefined,
        get: async () => null,
      },
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      now: () => one.clock.at,
    });
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);

    await watched.requestFromAgent(ACCOUNT, MESSAGE);
    expect(await ledgerRow(one)).toMatchObject({
      status: 'needs-human',
      method: 'one-click',
      reason: 'asked',
      ref: 'lt-watched-1',
      list_key: 'weekly.lists.example.invalid',
    });
    // Nothing happened TO the message, so there is nothing to tell the console: the letter is the
    // announcement, and a `plugin:mail:unsubscribed` here would make the row menu show an attempt.
    expect(seen).toEqual([]);
  });

  it('leaves the row claimable, so a human clicking in the console is not blocked by the ask', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);

    // The gate a console click goes through, asked directly: `needs-human` is a retryable status, so
    // the agent having asked never stands between the person and the button they just pressed.
    one.clock.at += 1_000;
    expect(await one.store.write.claimUnsubscribe({
      accountId: ACCOUNT, messageId: MESSAGE, listKey: 'weekly.lists.example.invalid',
      method: 'one-click', now: one.clock.at, reclaimBefore: one.clock.at - 60_000,
    })).toBe(1);
  });

  it('does not make the message look unsubscribed, or change what it offers', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);

    // Only the two fields this slice owns: nothing was achieved, so there is no `done`, and what the
    // message offers is a pure function of the poll and cannot move because somebody asked a question.
    const page = await one.service.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 10 });
    expect(page.messages[0]!.unsubscribe?.available).toBe('one-click');
    expect(page.messages[0]!.unsubscribe?.done).toBeUndefined();
  });
});

describe('what the letter promises depends on the rung, because the rungs differ', () => {
  async function ask(over: MailListUnsubscribe, body?: string): Promise<SentLetter> {
    const one = await openHarness();
    if (body !== undefined) one.bodyHtml.current = body;
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: over })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    assertNothingLeftTheMachine(one);
    return one.letters[0]!;
  }

  it('a one-click list is promised one request and no page to read', async () => {
    const letter = await ask(headers());
    expect(letter.markdown).toContain('one-click unsubscribe');
    expect(letter.markdown).toContain('one request and nothing else');
  });

  it('a page-only list is promised a reading of the page, and told it may not be final', async () => {
    const letter = await ask(headers({ oneClick: false }));
    expect(letter.markdown).toContain('unsubscribe page and read what came back');
    expect(letter.markdown).toContain('wants a button pressed is not');
  });

  it('a mailto-only list is told a mail leaving the account is theirs to authorise', async () => {
    const letter = await ask({ mailto: ['mailto:leave@lists.example.invalid'], oneClick: false });
    expect(letter.markdown).toContain('only takes an unsubscribe by mail');
    expect(letter.markdown).toContain('mailto:leave@lists.example.invalid');
    expect(letter.markdown).toContain('only you can authorise');
    // No page, so no fenced url to show.
    expect(letter.markdown).not.toContain('```');
  });

  it('says "sender" rather than "list" when there was no List-Id to key on', async () => {
    const letter = await ask({ https: [`https://${HOST}/u/abc`], oneClick: false });
    expect(letter.subject).toBe('Unsubscribe from weekly@lists.example.invalid?');
    expect(letter.markdown).toContain('**Sender**: weekly@lists.example.invalid');
    expect(letter.markdown).toContain("this sender's unsubscribe page");
  });
});

/*
 * The Outlook shape, without the Outlook plugin: an account whose provider supplies no unsubscribe
 * headers at all. The header rungs cannot exist there, so the only way out is the link Walnut extracts
 * from the markup it already stored, and the letter has to say that rather than implying a choice.
 */
describe('an account that gives Walnut no unsubscribe headers', () => {
  it('offers the link rung alone and says it is the only way out', async () => {
    const one = await openHarness();
    one.bodyHtml.current =
      `<p>Issue 42.</p><p><a href="https://${HOST}/footer/u?t=zz">Unsubscribe</a></p>`;
    await one.service.ingestPage(ACCOUNT, [listing()]);

    // Before a body is fetched the message honestly offers nothing, and the op refuses exactly as the
    // console's click does.
    await expect(one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE)).rejects.toMatchObject({
      code: 'unsupported',
      status: 409,
      message: expect.stringContaining('no unsubscribe link'),
    });
    expect(one.letters).toEqual([]);

    await one.service.readMessage(ACCOUNT, MESSAGE);
    const asked = await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    expect(asked).toMatchObject({ method: 'link', url: `https://${HOST}/footer/u?t=zz` });
    assertNothingLeftTheMachine(one);

    const body = one.letters[0]!.markdown;
    expect(body).toContain('came out of the message itself');
    expect(body).toContain('gives Walnut no unsubscribe headers');
    expect(body).toContain('It is the only way out this message offers');
    expect(body).toContain('no one-click request to make and no address to write to');
    expect(body).toContain(`\`\`\`\nhttps://${HOST}/footer/u?t=zz\n\`\`\``);
    // With no `List-Id` the key is the sender, and the wording follows it.
    expect(one.letters[0]!.subject).toBe('Unsubscribe from weekly@lists.example.invalid?');
  });

  it('describes a header link as the sender saying how to leave', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers({ oneClick: false }) })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    expect(one.letters[0]!.markdown).not.toContain('came out of the message itself');
  });
});

describe('what the op refuses rather than asking about', () => {
  it('refuses a message with no way out at all, in words the model can repeat', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing()]);
    await expect(one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE)).rejects.toMatchObject({
      code: 'unsupported',
      status: 409,
    });
    expect(one.letters).toEqual([]);
    expect(await ledgerRow(one)).toBeUndefined();
    assertNothingLeftTheMachine(one);
  });

  it('refuses a second ask while the first letter is still unanswered, and names it', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);

    await expect(one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE)).rejects.toMatchObject({
      code: 'stale',
      status: 409,
      message: expect.stringContaining('lt-fixture-1'),
    });
    // Still ONE letter: a second question about the same mail badges the bell and pushes the phone
    // for nothing.
    expect(one.letters).toHaveLength(1);
  });

  it('asks again once that letter has been answered', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    one.letters[0]!.answered = { actionId: 'not-now', label: 'Not now', at: one.clock.at };

    one.clock.at += 60_000;
    const again = await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    expect(again.letterId).toBe('lt-fixture-2');
    expect(await ledgerRow(one)).toMatchObject({ ref: 'lt-fixture-2' });
  });

  it('refuses to ask about a list the human already left, and says when', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    await one.store.write.claimUnsubscribe({
      accountId: ACCOUNT, messageId: MESSAGE, listKey: 'weekly.lists.example.invalid',
      method: 'one-click', now: one.clock.at, reclaimBefore: one.clock.at - 60_000,
    });
    await one.store.write.settleUnsubscribe({
      accountId: ACCOUNT, messageId: MESSAGE, claimedAt: one.clock.at,
      status: 'done', method: 'one-click', now: one.clock.at,
    });

    await expect(one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE)).rejects.toMatchObject({
      code: 'stale',
      message: expect.stringContaining('already unsubscribed'),
    });
    expect(one.letters).toEqual([]);
  });

  it('gives the claim back when the letter itself could not be sent', async () => {
    const one = await openHarness();
    await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
    const broken = makeUnsubscribe({
      store: one.store,
      service: one.service,
      events: new MailEvents(() => undefined),
      letters: {
        send: async () => { throw new Error('the human inbox is full'); },
        reply: async () => undefined,
        withdraw: async () => undefined,
        get: async () => null,
      },
      log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
      now: () => one.clock.at,
    });

    await expect(broken.requestFromAgent(ACCOUNT, MESSAGE)).rejects.toThrow('the human inbox is full');
    // NOT left `in-flight`: the console would show "Unsubscribing…" for a minute over a question
    // nobody was ever asked.
    expect(await ledgerRow(one)).toMatchObject({ status: 'failed', reason: 'ask-failed' });
  });

  it('404s a message the cache has never heard of', async () => {
    const one = await openHarness();
    await expect(one.unsubscribe.requestFromAgent(ACCOUNT, 'INBOX:9001:999'))
      .rejects.toMatchObject({ code: 'unknown_message', status: 404 });
    expect(one.letters).toEqual([]);
  });
});

/*
 * The one function that decides what a send made on this path records. A table rather than prose,
 * because the wrong answer here is a real mail going out attributed to a click nobody made.
 */
describe('who authorised a send, decided in one place', () => {
  it('a console click records the click, keyed on the message the human clicked', () => {
    expect(unsubscribeSendApproval({ approvalKind: 'console' }, MESSAGE))
      .toEqual({ kind: 'console', ref: `unsubscribe:${MESSAGE}` });
  });

  it('a letter answer records the letter, never the console', () => {
    expect(unsubscribeSendApproval({ approvalKind: 'letter', ref: 'lt-fixture-1' }, MESSAGE))
      .toEqual({ kind: 'letter', ref: 'lt-fixture-1' });
  });
});
