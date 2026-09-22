/**
 * The letter router: this plugin issues letters from two ledgers, and an answer has to reach the right one.
 *
 * Why it exists at all is a bug that was there before this slice, and the first block below PINS THAT
 * BEHAVIOUR rather than describing it: `MailApprovals.onLetterAnswered` looks the letter up as a draft's
 * `letter_id`, and when it finds nothing it replies "the draft was edited, discarded, or sent from the
 * console". For an approval letter that is exactly right. For an unsubscribe letter — a letter about a
 * message, with no draft anywhere near it — it is a confident wrong answer, and the person reading it
 * would go looking for a draft that never existed.
 *
 * So the wiring in index.ts became a router, and this file grades the three directions it can take:
 *
 *   . an answer whose letter is a row in the UNSUBSCRIBE ledger runs the ladder, under the letter's
 *     authority, and reports back in that letter's own thread;
 *   . anything else goes to the approval ledger, byte for byte as before;
 *   . a withdrawal is ignored by both, because our own `withdraw` comes back through the same event and
 *     acting on it would mean answering a question we just took back.
 *
 * The router itself is two lines of index.ts, so it is ALSO asserted there as source: a future edit that
 * drops the fallthrough would otherwise pass every behavioural test here by never reaching approvals.
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
import { MailDrafts } from '../../src/integrations/mail/drafts.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailSends } from '../../src/integrations/mail/sends.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { MailUnsubscribe } from '../../src/integrations/mail/unsubscribe.js';
import type { UnsubscribeHttpSeam } from '../../src/integrations/mail/unsubscribe-http.js';
import type {
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailListUnsubscribe,
  MailProviderSpec,
} from '../../src/integrations/mail/types.js';

type UnsubscribeDeps = ConstructorParameters<typeof MailUnsubscribe>[0];

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: true, markRead: false, flags: false,
  threads: false, send: true, sendAsReply: false, bodies: 'both', attachments: 'none',
};

const ACCOUNT = 'listy:acct-1';
const HOST = 'lists.example.invalid';
const MESSAGE = 'INBOX:9001:42';
const SENT_AT = Date.UTC(2026, 8, 21, 16, 0, 0);
const SUCCESS_PAGE = '<html><body><p>You have been unsubscribed from this list.</p></body></html>';

interface SentLetter {
  letterId: string;
  subject: string;
  markdown: string;
  answered?: { actionId: string; label: string; at: number };
}

interface Harness {
  store: MailStore;
  service: MailService;
  drafts: MailDrafts;
  approvals: MailApprovals;
  unsubscribe: MailUnsubscribe;
  letters: SentLetter[];
  replies: Array<{ letterId: string; markdown: string }>;
  /** What the guarded transport was asked for, so "the ladder really ran" is not inferred. */
  fetches: string[];
  pages: Map<string, { status: number; body: string }>;
  clock: { at: number };
  /** The router, exactly as index.ts wires it. */
  answer: (event: { letterId: string; actionId: string }) => Promise<void>;
}

const open: MailDatabase[] = [];
const roots: string[] = [];

async function openHarness(): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-unsub-router-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const bodies = new MailBodyStore(root);
  const providers = new MailProviderRegistry(() => undefined);
  const sent: Array<{ subject: string }> = [];

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
      format: 'both', text: 'This week in the marina.', html: '<p>This week in the marina.</p>', bytes: 40,
    }),
    send: async (_accountId, message) => {
      sent.push({ subject: message.subject });
      return { acceptedAt: Date.now(), providerMessageId: `pm-${sent.length}` };
    },
  };
  providers.register(spec, 'the-fixture-plugin');

  const fetches: string[] = [];
  const pages = new Map<string, { status: number; body: string }>();
  const seam: UnsubscribeHttpSeam = {
    fetch: async (url) => {
      fetches.push(url);
      const page = pages.get(url) ?? { status: 404, body: 'no such page' };
      return new Response(page.body, {
        status: page.status,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
    // A public address for the fixture host, so the guard's blocklist passes and the seam answers.
    lookup: async (hostname) => {
      if (hostname === HOST) return [{ address: '203.0.113.10', family: 4 }];
      throw new Error(`ENOTFOUND ${hostname}`);
    },
  };

  const letters: SentLetter[] = [];
  const replies: Array<{ letterId: string; markdown: string }> = [];
  let nextLetter = 0;
  const lettersApi: ApprovalLetters = {
    send: async (input) => {
      nextLetter += 1;
      const letterId = `lt-fixture-${nextLetter}`;
      letters.push({ letterId, subject: input.subject, markdown: input.markdown ?? '' });
      return { letterId };
    },
    reply: async (letterId, input) => {
      replies.push({ letterId, markdown: input.markdown ?? input.text ?? '' });
    },
    withdraw: async (letterId, input) => {
      const found = letters.find((one) => one.letterId === letterId);
      if (found) found.answered = { actionId: 'withdrawn', label: input.note, at: Date.now() };
    },
    get: async (letterId) => {
      const found = letters.find((one) => one.letterId === letterId);
      if (!found) return null;
      return { letterId, ...(found.answered ? { answered: found.answered } : {}) };
    },
  };

  const clock = { at: Date.UTC(2026, 8, 22, 9, 0, 0) };
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const events = new MailEvents(() => undefined);
  const service = new MailService({ store, bodies, providers, log: { info: vi.fn(), debug: vi.fn() } });
  const drafts = new MailDrafts({ store, events });
  const sends = new MailSends({ store, service, drafts, letters: lettersApi, events, log });
  const approvals = new MailApprovals({
    store, service, drafts, sends, letters: lettersApi, events, log,
  });
  const unsubscribe = new MailUnsubscribe({
    store, service, events, letters: lettersApi, drafts, approvals, log,
    now: () => clock.at, http: seam,
  } as UnsubscribeDeps);

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
    store, service, drafts, approvals, unsubscribe, letters, replies, fetches, pages, clock,
    // The router, copied from index.ts in shape and nothing else: the unsubscribe ledger is asked
    // whether the letter is its own, and everything it disowns goes to approvals.
    answer: async (event) => {
      if (await unsubscribe.onLetterAnswered(event)) return;
      await approvals.onLetterAnswered(event);
    },
  };
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
  return { https: [`https://${HOST}/u/abc`], oneClick: false, listId: 'weekly.lists.example.invalid', ...over };
}

/** The agent asks, and the letter that came out of it is handed back. */
async function askedLetter(one: Harness): Promise<string> {
  await one.service.ingestPage(ACCOUNT, [listing({ listUnsubscribe: headers() })]);
  const asked = await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
  return asked.letterId;
}

/*
 * First, the thing that made the router necessary. Not described in a comment: executed, so the day
 * somebody "fixes" the approval path to stay quiet, this test fails and the router's reason is re-read.
 */
describe('what the approval ledger does with a letter it does not own', () => {
  it('replies SUPERSEDED, which is why an unsubscribe letter must never reach it', async () => {
    const one = await openHarness();
    await one.approvals.onLetterAnswered({ letterId: 'lt-not-a-draft', actionId: 'send' });
    expect(one.replies).toHaveLength(1);
    expect(one.replies[0]!.markdown).toContain('no longer the one Walnut is waiting on');
    expect(one.replies[0]!.markdown).toContain('edited, discarded, or sent');
  });
});

describe('an unsubscribe letter goes to the ladder', () => {
  it('runs the ladder under the letter as the authority, and records it as the ref', async () => {
    const one = await openHarness();
    one.pages.set(`https://${HOST}/u/abc`, { status: 200, body: SUCCESS_PAGE });
    const letterId = await askedLetter(one);

    one.clock.at += 30_000;
    await one.answer({ letterId, actionId: 'unsubscribe' });

    // The ladder really ran: one request through the guarded transport, to the sender's own page.
    expect(one.fetches).toEqual([`https://${HOST}/u/abc`]);
    const row = await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE);
    expect(row).toMatchObject({
      status: 'done',
      method: 'link',
      // The letter the human answered IS the authorisation, and the row names it.
      ref: letterId,
      at: one.clock.at,
    });

    // And the outcome goes back where the question was asked, not into a log nobody reads.
    expect(one.replies).toHaveLength(1);
    expect(one.replies[0]!.letterId).toBe(letterId);
    expect(one.replies[0]!.markdown).toContain('Unsubscribed');
    // Never handed to approvals, so no SUPERSEDED line anywhere.
    expect(one.replies.map((reply) => reply.markdown).join(' '))
      .not.toContain('no longer the one Walnut is waiting on');
  });

  it('reports an unfinished page with the url, so the human can finish it', async () => {
    const one = await openHarness();
    one.pages.set(`https://${HOST}/u/abc`, {
      status: 200,
      body: '<p>Confirm you want to leave.</p><form action="/unsubscribe"><button>Yes</button></form>',
    });
    const letterId = await askedLetter(one);
    await one.answer({ letterId, actionId: 'unsubscribe' });

    expect(one.replies[0]!.markdown).toContain('wants a confirmation');
    expect(one.replies[0]!.markdown).toContain(`https://${HOST}/u/abc`);
    expect(await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE))
      .toMatchObject({ status: 'needs-human', reason: 'confirm-form', ref: letterId });
  });

  it('reports a refusal as a refusal, and changes nothing', async () => {
    const one = await openHarness();
    one.pages.set(`https://${HOST}/u/abc`, { status: 403, body: 'nope' });
    const letterId = await askedLetter(one);
    await one.answer({ letterId, actionId: 'unsubscribe' });

    expect(one.replies[0]!.markdown).toContain('refused');
    expect(one.replies[0]!.markdown).toContain('Nothing was changed');
    expect(await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE))
      .toMatchObject({ status: 'failed', reason: 'http-403' });
  });

  it('does nothing at all on Not now, and says so in the thread', async () => {
    const one = await openHarness();
    const letterId = await askedLetter(one);
    await one.answer({ letterId, actionId: 'not-now' });

    expect(one.fetches).toEqual([]);
    expect(one.replies[0]!.markdown).toContain('Nothing was done');
    expect(one.replies[0]!.markdown).toContain('still on this list');
    // The row is left where the ask put it, which is a status a later click may replace outright.
    expect(await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE))
      .toMatchObject({ status: 'needs-human', reason: 'asked' });
  });

  it('answers the person rather than throwing when the message is no longer in the cache', async () => {
    const one = await openHarness();
    // A ledger row for a message the cache does not hold, which is what retention leaves behind when it
    // evicts an old newsletter while its letter is still unanswered.
    const gone = 'INBOX:9001:777';
    await one.store.write.claimUnsubscribe({
      accountId: ACCOUNT, messageId: gone, listKey: 'weekly.lists.example.invalid',
      method: 'link', now: one.clock.at, reclaimBefore: one.clock.at - 60_000,
    });
    await one.store.write.settleUnsubscribe({
      accountId: ACCOUNT, messageId: gone, claimedAt: one.clock.at,
      status: 'needs-human', method: 'link', reason: 'asked', ref: 'lt-orphan-1', now: one.clock.at,
    });

    // It never throws: it runs on a bus subscription, so the only places it could report are the log
    // and the letter's own thread, and the person gets a sentence rather than silence.
    await expect(one.answer({ letterId: 'lt-orphan-1', actionId: 'unsubscribe' })).resolves.toBeUndefined();
    expect(one.fetches).toEqual([]);
    expect(one.replies).toHaveLength(1);
    expect(one.replies[0]!.letterId).toBe('lt-orphan-1');
    expect(one.replies[0]!.markdown).toContain('Nothing was changed');
    // And NOT the approval ledger's guess: the row proved the letter was ours.
    expect(one.replies[0]!.markdown).not.toContain('no longer the one Walnut is waiting on');
  });
});

describe('an approval letter still goes to approvals, unchanged', () => {
  async function openDraftLetter(one: Harness): Promise<{ letterId: string; draftId: string }> {
    const draft = await one.drafts.create({
      accountId: ACCOUNT,
      to: ['bo@example.invalid'],
      subject: 'Thursday works',
      bodyMarkdown: 'See you then.',
      origin: 'console',
    });
    const asked = await one.approvals.requestSend(draft.draftId, draft.revision);
    return { letterId: asked.letterId, draftId: draft.draftId };
  }

  it('sends the mail on Send, with the unsubscribe ledger having disowned the letter', async () => {
    const one = await openHarness();
    // An unsubscribe row exists too, so the router has something to look past rather than an empty table.
    await askedLetter(one);
    const { letterId, draftId } = await openDraftLetter(one);

    await one.answer({ letterId, actionId: 'send' });

    const sends = await one.store.write.listSends({ draftId, limit: 5 });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ approval_kind: 'letter', approval_ref: letterId, state: 'sent' });
    // The thread gets the send ledger's own confirmation and nothing else: no SUPERSEDED line, and the
    // unsubscribe ledger never opened a socket over it.
    expect(one.replies.map((reply) => reply.letterId)).toEqual([letterId]);
    expect(one.replies[0]!.markdown).toMatch(/^Sent /);
    expect(one.replies[0]!.markdown).not.toContain('no longer the one Walnut is waiting on');
    expect(one.fetches).toEqual([]);
  });

  it('discards on Discard, and the reply is the approval ledger\'s own', async () => {
    const one = await openHarness();
    await askedLetter(one);
    const { letterId, draftId } = await openDraftLetter(one);

    await one.answer({ letterId, actionId: 'discard' });
    expect(one.replies).toEqual([{ letterId, markdown: 'Discarded, nothing was sent.' }]);
    expect((await one.drafts.require(draftId)).state).toBe('discarded');
  });

  it('still says SUPERSEDED for a letter neither ledger owns', async () => {
    const one = await openHarness();
    await askedLetter(one);
    await one.answer({ letterId: 'lt-from-nowhere', actionId: 'send' });
    expect(one.replies[0]!.markdown).toContain('no longer the one Walnut is waiting on');
  });
});

describe('a withdrawal is ignored by both ledgers', () => {
  it('does not run the ladder, does not reply, and leaves the row alone', async () => {
    const one = await openHarness();
    one.pages.set(`https://${HOST}/u/abc`, { status: 200, body: SUCCESS_PAGE });
    const letterId = await askedLetter(one);
    const before = await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE);

    await one.answer({ letterId, actionId: 'withdrawn' });

    expect(one.fetches).toEqual([]);
    expect(one.replies).toEqual([]);
    expect(await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE)).toEqual(before);
  });

  it('does not reply to a withdrawn approval letter either', async () => {
    const one = await openHarness();
    await one.answer({ letterId: 'lt-withdrawn-draft', actionId: 'withdrawn' });
    expect(one.replies).toEqual([]);
  });
});

/*
 * The router is two lines, and the failure mode of getting them wrong is silent: an edit that returns
 * early would pass every test above by simply never reaching approvals, and the approval flow would
 * quietly stop working. So the shape is asserted as source, the way the replica flag next door is.
 */
describe('the wiring itself', () => {
  it('asks the unsubscribe ledger first and falls through to approvals', async () => {
    const source = await fsp.readFile(path.resolve('src/integrations/mail/index.ts'), 'utf-8');
    expect(source).toContain('if (await unsubscribe.onLetterAnswered(event)) return');
    expect(source).toContain('await approvals.onLetterAnswered(event)');
    // ONE subscription. Two would each get every answer, and the approval path would reply
    // SUPERSEDED to every unsubscribe letter alongside the outcome.
    expect(source.match(/walnut\.letters\.onAnswered\(/g)).toHaveLength(1);
  });
});
