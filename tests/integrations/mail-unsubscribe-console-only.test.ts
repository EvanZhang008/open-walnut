/**
 * `consoleSend` is reachable from a HUMAN'S CLICK and from nowhere else.
 *
 * This is the safety argument for the mailto rung, stated as a test rather than as a comment, because it
 * is the one property in this feature whose failure puts mail on the wire under somebody's name without
 * them asking. It is pinned two ways, and both are needed:
 *
 * - BEHAVIOURALLY, by spying on `consoleSend` and running the agent's own entry point
 *   (`requestFromAgent`, behind the `mail_unsubscribe_request` op) against a message whose ONLY way out
 *   is a mail. If that path ever gains a send, the spy sees it.
 * - STRUCTURALLY, by counting the files that name `consoleSend` at all. A behavioural test can only
 *   cover the paths it knows about, and the failure mode here is a NEW path: an op, a cron, a routine or
 *   a sync tick calling it. The list below is short on purpose, so adding to it is a review step rather
 *   than an accident.
 *
 * Nothing here opens a socket or touches a mailbox.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js';
import type { WalnutServerPluginApi } from '../../src/core/plugins/server-api.js';
import type { ApprovalLetters } from '../../src/integrations/mail/approvals.js';
import { MailBodyStore } from '../../src/integrations/mail/bodies.js';
import { MailDatabase } from '../../src/integrations/mail/db.js';
import { MailEvents } from '../../src/integrations/mail/events.js';
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js';
import { MailService } from '../../src/integrations/mail/service.js';
import { MailStore } from '../../src/integrations/mail/store.js';
import { MailUnsubscribe } from '../../src/integrations/mail/unsubscribe.js';
import type {
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailProviderSpec,
} from '../../src/integrations/mail/types.js';

const ACCOUNT = 'listy:acct-1';
const HOST = 'lists.example.invalid';
const MESSAGE = 'INBOX:9001:42';

/**
 * Every file in `src/` allowed to name `consoleSend`.
 *
 * - `approvals.ts` declares it.
 * - `routes-write.ts` is the console's own Send route: a human clicked Send in a composer they opened.
 * - `unsubscribe.ts` is the mailto rung: a human clicked Unsubscribe on a row they were looking at.
 *
 * A fourth entry needs an answer to one question — WHICH human act is this, and where did they make it?
 * "A model decided to" is not one of the answers.
 */
const MAY_NAME_CONSOLE_SEND = [
  'src/integrations/mail/approvals.ts',
  'src/integrations/mail/routes-write.ts',
  'src/integrations/mail/unsubscribe.ts',
];

const CAPABILITIES: MailCapabilities = {
  search: false, watch: false, drafts: false, markRead: false, flags: false,
  threads: false, send: true, sendAsReply: false, bodies: 'both', attachments: 'none',
};

const open: MailDatabase[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) await db.dispose().catch(() => undefined);
  for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

async function harness() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-unsub-console-only-'));
  roots.push(root);
  const client = new PluginDatabaseClient(path.join(root, 'plugin.sqlite'));
  const walnut = { storage: { get database() { return client; } } } as unknown as WalnutServerPluginApi;
  const db = new MailDatabase(walnut);
  open.push(db);
  const store = new MailStore(db);
  const providers = new MailProviderRegistry(() => undefined);
  const sent: unknown[] = [];
  const spec: MailProviderSpec = {
    id: 'listy',
    label: 'A fixture list',
    capabilities: { ...CAPABILITIES },
    setup: { fields: [], submit: async () => { throw new Error('by hand') } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async (): Promise<MailBody> => ({ format: 'text', text: 'Issue 42.', bytes: 9 }),
    send: async (_accountId, mail) => { sent.push(mail); return { acceptedAt: Date.now() } },
  };
  providers.register(spec, 'the-fixture-plugin');

  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const service = new MailService({ store, bodies: new MailBodyStore(root), providers, log });
  const events = new MailEvents(() => undefined);
  const letters = {
    send: vi.fn(async () => ({ letterId: 'lt-asked' })),
    reply: vi.fn(async () => undefined),
    withdraw: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ letterId: 'lt-asked' })),
  };
  // A SPY, not a stub: the assertion is that nothing on the agent's path calls it. It throws if it is
  // ever reached, so a call cannot be swallowed by a `catch` somewhere up the stack either.
  const consoleSend = vi.fn(async () => {
    throw new Error('consoleSend must not be reachable from an agent entry point');
  });
  const drafts = {
    create: vi.fn(async () => { throw new Error('the agent path must not draft anything') }),
  };
  const unsubscribe = new MailUnsubscribe({
    store,
    service,
    events,
    drafts: drafts as never,
    approvals: { consoleSend } as never,
    letters: letters as unknown as ApprovalLetters,
    log,
  });

  await store.upsertAccount({
    accountId: ACCOUNT,
    providerId: 'listy',
    displayName: 'A mailbox',
    address: 'reader@example.invalid',
    state: 'active',
    healthJson: null,
    payload: '{}',
  });

  const envelope: MailEnvelope = {
    messageId: MESSAGE,
    rfcMessageId: `<weekly-42@${HOST}>`,
    mailboxId: 'INBOX',
    from: { name: 'Marina Weekly', address: `weekly@${HOST}` },
    to: [{ address: 'reader@example.invalid' }],
    subject: 'Marina Weekly, issue 42',
    snippet: 'This week in the marina',
    sentAt: Date.UTC(2026, 8, 21, 16, 0, 0),
    flags: [],
    attachments: [],
    // Mailto ONLY, which is the shape that makes this test mean something: the rung the agent's ask would
    // name is the one that sends mail, so a path that leaked through would leak into a real send.
    listUnsubscribe: { mailto: [`mailto:leave@${HOST}`], oneClick: false, listId: `weekly.${HOST}` },
  };
  await service.ingestPage(ACCOUNT, [envelope]);

  return { store, unsubscribe, letters, consoleSend, drafts, sent };
}

describe('the agent\'s entry point only ever asks', () => {
  it('sends a letter, drafts nothing, and never reaches consoleSend', async () => {
    const one = await harness();

    const asked = await one.unsubscribe.requestFromAgent(ACCOUNT, MESSAGE);
    expect(asked.letterId).toBe('lt-asked');
    expect(asked.method).toBe('mailto');

    expect(one.letters.send).toHaveBeenCalledTimes(1);
    expect(one.consoleSend).not.toHaveBeenCalled();
    expect(one.drafts.create).not.toHaveBeenCalled();
    expect(one.sent).toEqual([]);
    expect(await one.store.write.listSends({ limit: 10 })).toEqual([]);
    expect(await one.store.write.listDrafts({ limit: 10 })).toEqual([]);

    // The ledger records the ASK, not an attempt: `needs-human` keyed on the letter, which is what the
    // console renders as "waiting on your answer" rather than as a page to go and finish.
    const row = await one.store.write.getUnsubscribe(ACCOUNT, MESSAGE);
    expect(row).toMatchObject({ status: 'needs-human', ref: 'lt-asked' });
  });

  it('refuses to send even when the run itself is authorised by the answered letter', async () => {
    const one = await harness();
    // The other half of the same rule. A human answering the letter IS an authorisation, but a
    // LETTER-kinded mailto send needs its own mint (its outcome has a thread to report into), and that
    // mint is not `consoleSend`. Reaching `consoleSend` here would file their answer as a console click.
    const outcome = await one.unsubscribe.run(
      ACCOUNT, MESSAGE, {}, { approvalKind: 'letter', ref: 'lt-asked' },
    );
    expect(outcome).toMatchObject({ status: 'needs-human', reason: 'mailto-console-only' });
    expect(one.consoleSend).not.toHaveBeenCalled();
    expect(one.drafts.create).not.toHaveBeenCalled();
    expect(one.sent).toEqual([]);
  });
});

describe('the files allowed to name consoleSend', () => {
  it('is exactly the three human-click paths', async () => {
    const roots = ['src/integrations/mail'];
    const found: string[] = [];
    for (const dir of roots) {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const file = `${dir}/${entry.name}`;
        const text = await fsp.readFile(file, 'utf8');
        // Any mention at all, comments included: a comment naming it is where the next caller starts.
        if (/\bconsoleSend\b/.test(text)) found.push(file);
      }
    }
    expect(found.sort()).toEqual([...MAY_NAME_CONSOLE_SEND].sort());
  });

  it('is not named by the agent surface, the ops catalogue or the tool list', async () => {
    // The three files an agent's call actually goes through. Named explicitly rather than left to the
    // sweep above, because these are the ones a future slice is most likely to reach for.
    for (const file of [
      'src/integrations/mail/agent-surface.ts',
      'src/integrations/mail/ops.ts',
      'src/integrations/mail/tools.ts',
    ]) {
      expect(await fsp.readFile(file, 'utf8'), file).not.toMatch(/\bconsoleSend\b/);
    }
  });
});
