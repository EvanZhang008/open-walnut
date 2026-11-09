import { describe, expect, it } from 'vitest';
import type { RouterAreasFile } from '../../src/core/router/areas.js';
import { sourceReaderFor, type SourceCaller, type SourceReaderDeps } from '../../src/core/router/source-reader.js';
import type { MailAgentDeps } from '../../src/integrations/mail/agent-surface.js';
import { MailServiceError, type DraftDto, type MailMessageDto } from '../../src/integrations/mail/contract.js';
import { createMailOps } from '../../src/integrations/mail/ops.js';
import { guardMailOps, guardMailTools, keepUnassignedMail, mailCallerOf, type LedgerLookup } from '../../src/integrations/mail/router-read-guard.js';
import { mailDeliveryVersion, mailRouterKey } from '../../src/integrations/mail/router-source.js';
import { createMailTools } from '../../src/integrations/mail/tools.js';

const ACCOUNT = 'desk@example.invalid';
const OTHER_ACCOUNT = 'home@example.invalid';
const SENT_AT = 1_700_000_000_000;
// A row's delivery through the real helper, as toDto derives it from the row's times and RFC id
// (these metadata-only fixtures hold no body ref).
const deliveryOf = (rfc: string, receivedAt: number | null = null) => mailDeliveryVersion(SENT_AT, receivedAt, null, rfc);
// A later delivery on the same handle: the provider received another message under it.
const LATER = 1_700_000_100_000;

// One account, one thread. INBOX:7 and Archive:7 share a UID in two folders (two exact items);
// All:9 is an RFC copy of m-beta under a new cache id that the registry does not list; Home:9 carries
// the same RFC id in another account, and Spam:7 is INBOX:7's RFC copy (INBOX:7 was confirmed with no canonical key).
const ROWS: Array<[id: string, rfc: string, account?: string]> = [
  ['m-plain', '<plain@example.invalid>'],
  ['INBOX:7', '<seven@example.invalid>'],
  ['Archive:7', '<archived@example.invalid>'],
  ['m-beta', '<beta@example.invalid>'],
  ['All:9', '<beta@example.invalid>'],
  ['Home:9', '<beta@example.invalid>', OTHER_ACCOUNT],
  ['Spam:7', '<seven@example.invalid>'],
];

const dto = ([id, rfc, account = ACCOUNT]: [string, string, string?]): MailMessageDto => ({
  accountId: account, messageId: id, rfcMessageId: rfc, threadId: 'thread-1', mailboxId: 'inbox',
  from: { address: 'sender@example.invalid' }, to: [], subject: `Subject ${id}`, snippet: `Preview ${id}`,
  sentAt: SENT_AT, deliveryVersion: deliveryOf(rfc), flags: [], attachments: [], hasBody: true,
} as unknown as MailMessageDto);

/** The confirmed delivery of a fixture row. */
const versionOf = (id: string): string => dto(ROWS.find(([one]) => one === id)!).deliveryVersion!;

/** The same handle carrying a later delivery, as toDto would build it. */
const redelivered = (row: MailMessageDto, receivedAt = LATER): MailMessageDto =>
  ({ ...row, receivedAt, deliveryVersion: mailDeliveryVersion(row.sentAt, receivedAt, null, row.rfcMessageId) } as MailMessageDto);

const REGISTRY: RouterAreasFile = {
  version: 1,
  areas: ['alpha', 'beta'].map((id) => ({ id, name: id, host: '__local__', taskIds: [`t-${id}`], sources: [{ kind: 'mail' as const, account: ACCOUNT }] })),
  routers: [],
  items: [
    { source: { kind: 'mail', account: ACCOUNT, message: 'INBOX:7', version: versionOf('INBOX:7') }, areaId: 'alpha' },
    // Confirmed through /router/assign: the exact delivery grants; its canonical key is the adapter's
    // scope key (RFC id, no delivery version), so a copy or a later reply with that RFC id is restricted.
    { source: { kind: 'mail', account: ACCOUNT, message: 'm-beta', version: versionOf('m-beta') }, areaId: 'beta', canonicalKey: mailRouterKey(ACCOUNT, 'm-beta', '<beta@example.invalid>') },
  ],
};

const DRAFTS: Record<string, Partial<DraftDto>> = {
  'd-beta': { inReplyTo: '<beta@example.invalid>' },
  'd-gone': { inReplyTo: '<gone@example.invalid>' },
  'd-new': {},
};

interface WorldOptions {
  registryError?: boolean;
  items?: RouterAreasFile['items'];
  /** Cached rows with no stored body. */
  noBody?: string[];
  /** The cache takes a later delivery of this handle while its body is being read. */
  redeliverDuringBody?: string[];
  /** The provider's read answers a later delivery than the cached envelope. */
  bodyFromLaterDelivery?: string[];
  /** The cache already holds a later delivery of this handle than the one confirmed (same RFC id: a new reply). */
  laterInCache?: string[];
  /** The handle now carries a truly new message: a later delivery under a new RFC id. */
  newMessageInCache?: string[];
  /** The reply target answers a later delivery than the cached envelope. */
  replyTargetFromLaterDelivery?: string[];
  /** The cache takes a later delivery of this handle while its reply target is read. */
  redeliverDuringReplyTarget?: string[];
  missingVersion?: string[];
  classifyDuringList?: string[];
  classifyDuringBody?: string[];
  /** Another folder's copy of a row (same RFC id, time and subject), listed ahead of it as an inbox copy is. */
  copyOf?: Array<{ id: string; of: string }>;
}

function world(options: WorldOptions = {}) {
  const calls: string[] = [];
  const lateItems: RouterAreasFile['items'] = [];
  const classify = (ids: string[] = []) => ids.forEach((message) => lateItems.push({
    source: { kind: 'mail', account: ACCOUNT, message, version: versionOf(message) }, areaId: 'beta',
  }));
  const reads: Array<{ cacheOnly?: boolean } | undefined> = [];
  const searches: Array<{ cacheOnly?: boolean }> = [];
  const threads: Array<{ allCopies?: boolean } | undefined> = [];
  const copies = (options.copyOf ?? []).map(({ id, of }) => {
    const source = dto(ROWS.find(([one]) => one === of)!);
    return { ...source, messageId: id, mailboxId: 'INBOX' } as MailMessageDto;
  });
  const all = [...copies, ...ROWS.map(dto)]
    .map((m) => options.laterInCache?.includes(m.messageId) ? redelivered(m) : m)
    .map((m) => options.newMessageInCache?.includes(m.messageId)
      ? redelivered({ ...m, rfcMessageId: `<new-${m.messageId}@example.invalid>` } as MailMessageDto) : m)
    .map((m) => options.noBody?.includes(m.messageId) ? { ...m, hasBody: false } as MailMessageDto : m)
    .map((m) => options.missingVersion?.includes(m.messageId) ? { ...m, deliveryVersion: undefined } : m);
  const find = (id: string) => {
    const one = all.find((m) => m.messageId === id) ?? all.find((m) => m.rfcMessageId === id);
    if (!one) throw new MailServiceError('unknown_message', `No cached message "${id}".`, 404);
    return one;
  };
  const draft = (draftId: string): DraftDto => ({ draftId, accountId: ACCOUNT, revision: 1, state: 'draft', ...DRAFTS[draftId] } as DraftDto);
  const deps = {
    replica: () => false,
    service: {
      async listAccounts() { return [{ accountId: ACCOUNT, address: ACCOUNT }]; },
      async listMailboxes() { return [{ mailboxId: 'inbox', role: 'inbox' }]; },
      async capabilitiesFor() { return { send: true }; },
      async listMessages() { calls.push('list'); classify(options.classifyDuringList); return { messages: all }; },
      async search(query: { cacheOnly?: boolean }) { searches.push(query); calls.push('search'); return { source: 'cache', messages: all }; },
      async readEnvelope(_a: string, id: string) { calls.push(`envelope:${id}`); return find(id); },
      async readMessage(_a: string, id: string, readOptions?: { cacheOnly?: boolean }) {
        reads.push(readOptions);
        calls.push(`body:${id}`);
        const row = find(id);
        classify(options.classifyDuringBody);
        if (options.redeliverDuringBody?.includes(id)) all[all.indexOf(row)] = redelivered(row);
        return { message: options.bodyFromLaterDelivery?.includes(id) ? redelivered(row) : row, body: { text: `Body words of ${id}` } };
      },
      async threadMessages(_a: string, _t: string, _l: number, threadOptions?: { allCopies?: boolean }) { threads.push(threadOptions); calls.push('thread'); return all; },
      async replyTarget(_a: string, id: string) {
        calls.push(`replyTarget:${id}`);
        const row = find(id);
        if (options.redeliverDuringReplyTarget?.includes(id)) all[all.indexOf(row)] = redelivered(row);
        const m = options.replyTargetFromLaterDelivery?.includes(id) ? redelivered(row) : row;
        // The service's reply target names the delivery it read, as the real one does.
        return { rfcMessageId: m.rfcMessageId, references: [], subject: m.subject, from: m.from, deliveryVersion: m.deliveryVersion };
      },
      async markRead(_a: string, id: string) { calls.push(`markRead:${id}`); return find(id); },
      async markReadMany(_a: string, ids: string[]) { calls.push(`markReadMany:${ids.join(',')}`); return ids.map((messageId) => ({ messageId, ok: true })); },
    },
    drafts: {
      async create() { calls.push('draft.create'); return draft('d-made'); },
      async get(id: string) { calls.push(`draft.get:${id}`); return draft(id); },
      async patch(id: string) { calls.push(`draft.patch:${id}`); return { draft: draft(id), wasPendingApproval: false }; },
    },
    approvals: {
      async requestSend(id: string) { calls.push(`requestSend:${id}`); return { letterId: 'letter-1', draft: draft(id) }; },
      async withdrawFor() { calls.push('withdraw'); },
    },
    unsubscribe: {
      async requestFromAgent(_a: string, id: string) { calls.push(`unsubscribe:${id}`); return { letterId: 'letter-2', method: 'one-click' }; },
    },
  } as unknown as MailAgentDeps;
  const readerDeps: SourceReaderDeps = {
    async readAreas() {
      if (options.registryError) throw new Error('Unexpected token');
      const file = structuredClone(REGISTRY);
      file.items.push(...structuredClone(options.items ?? []), ...structuredClone(lateItems));
      return file;
    },
    async session(sid) {
      const area = /^sid-(alpha|beta)$/.exec(sid)?.[1];
      return area ? { taskId: `t-${area}`, profile: { areaId: area } } as never : null;
    },
    async task(id) { return { id, router_area_id: id.slice(2) }; },
    async sessionsForTask() { return []; },
  };
  const ledgerKeys = new Map<string, Set<string>>();
  let ledgerError = false;
  const ledger: LedgerLookup = async (areaId, keys) => {
    calls.push(`ledger:${areaId}`);
    if (ledgerError) throw new Error('database is locked');
    return new Set(keys.filter((key) => ledgerKeys.get(areaId)?.has(key)));
  };
  const options2 = { readerFor: (caller: SourceCaller) => sourceReaderFor(caller, readerDeps), ledger };
  const ops = guardMailOps(createMailOps(deps), deps, createMailOps, options2);
  const tools = guardMailTools(createMailTools(deps), deps, createMailTools, options2);
  const op = (name: string, args: Record<string, unknown>, ctx: unknown) => ops.find((one) => one.name === name)!.handler(args, ctx);
  const tool = (name: string, input: Record<string, unknown>, meta?: unknown) => tools.find((one) => one.name === name)!.execute(input, meta);
  return { calls, reads, searches, threads, op, tool, ledgerKeys, failLedger: () => { ledgerError = true; } };
}

const call = async () => undefined;
const as = (sid: string) => ({ call, callerKind: 'agent', callerSid: sid });
const VP = as('sid-vp');
const PERSON = { call, callerKind: 'person' };
const ANONYMOUS = { call, callerKind: 'agent' };
/** Every call that writes, sends a letter or reads a body. */
const writesIn = (calls: string[]) => calls.filter((c) => c === 'draft.create' || c === 'withdraw'
  || ['markRead:', 'markReadMany:', 'unsubscribe:', 'draft.patch:', 'requestSend:', 'body:'].some((p) => c.startsWith(p)));

describe('mailCallerOf', () => {
  it('reads the context only: a sid, an explicit kind, else the default the surface names', () => {
    expect(mailCallerOf({ callerSid: ' sid-vp ' }, 'person')).toEqual({ kind: 'session', sid: 'sid-vp' });
    expect(mailCallerOf({ callerSid: 'plugin:mail' }, 'person')).toEqual({ kind: 'session', sid: 'plugin:mail' });
    expect(mailCallerOf({ callerKind: 'agent' }, 'person')).toEqual({ kind: 'agent' });
    expect(mailCallerOf({ callerKind: 'person' }, 'agent')).toEqual({ kind: 'person' });
    expect(mailCallerOf(undefined, 'agent')).toEqual({ kind: 'agent' });
    expect(mailCallerOf({ call }, 'agent')).toEqual({ kind: 'agent' });
  });

  it('never takes the caller from the environment', async () => {
    const before = process.env.WALNUT_SESSION_ID;
    process.env.WALNUT_SESSION_ID = 'sid-beta';
    try {
      const w = world();
      // sid-beta would read m-beta; the environment must not lend it to an anonymous caller.
      expect(await w.tool('mail_read', { message: 'm-beta' })).toContain('area_forbidden');
      expect(await w.op('read', { message: 'm-beta' }, ANONYMOUS)).toContain('area_forbidden');
      expect(await w.op('read', { message: 'm-beta' }, VP)).toContain('area_forbidden');
    } finally {
      if (before === undefined) delete process.env.WALNUT_SESSION_ID; else process.env.WALNUT_SESSION_ID = before;
    }
  });
});

describe('guardMailOps: reads', () => {
  it('only an explicit person reads everything, as before', async () => {
    const w = world();
    expect(await w.op('read', { message: 'm-beta' }, PERSON)).toContain('Body words of m-beta');
  });

  it('an op with no sid is an outside agent, never a person: unassigned only', async () => {
    for (const ctx of [ANONYMOUS, { call }, undefined]) {
      const w = world();
      expect(await w.op('read', { message: 'm-beta' }, ctx)).toContain('area_forbidden');
      expect(await w.op('read', { message: 'INBOX:7' }, ctx)).toContain('area_forbidden');
      expect(writesIn(w.calls)).toEqual([]);
      expect(await w.op('read', { message: 'm-plain' }, ctx)).toContain('Body words of m-plain');
      w.ledgerKeys.set('beta', new Set([mailRouterKey(ACCOUNT, 'm-beta', '<beta@example.invalid>')]));
      expect(await w.op('read', { message: 'All:9' }, ctx)).toContain('area_forbidden');
    }
  });

  it('an outside agent still fails closed on an unreadable registry', async () => {
    const w = world({ registryError: true });
    expect(await w.op('read', { message: 'm-plain' }, ANONYMOUS)).toContain('area_unverifiable');
    expect(writesIn(w.calls)).toEqual([]);
  });

  it('an ordinary session reads unassigned mail; an assigned body is refused before any body read', async () => {
    const w = world();
    expect(await w.op('read', { message: 'm-plain' }, VP)).toContain('Body words of m-plain');
    w.calls.length = 0;
    const out = await w.op('read', { message: 'm-beta' }, VP);
    expect(out).toContain('area_forbidden');
    expect(out).not.toContain('Body words');
    expect(writesIn(w.calls)).toEqual([]);
    // Named by its RFC id: resolved to the cached row first, then judged on that row.
    expect(await w.op('read', { message: '<seven@example.invalid>' }, VP)).toContain('area_forbidden');
  });

  it('a plugin caller id is an agent with no area: unassigned only', async () => {
    const w = world();
    expect(await w.op('read', { message: 'm-plain' }, as('plugin:mail'))).toContain('Body words of m-plain');
    expect(await w.op('read', { message: 'INBOX:7' }, as('plugin:mail'))).toContain('area_forbidden');
  });

  it('list and search drop rows of areas the caller may not read', async () => {
    const w = world();
    for (const out of [await w.op('list', {}, VP), await w.op('search', { q: 'Subject' }, VP)]) {
      expect(out).toContain('Subject m-plain');
      expect(out).toContain('Subject Archive:7');
      expect(out).not.toContain('Subject INBOX:7');
      expect(out).not.toContain('Subject m-beta');
    }
  });

  it('an area search returns only exact cached confirmations', async () => {
    const w = world();
    const out = await w.op('search', { q: 'Subject' }, as('sid-beta'));
    expect(out).toContain('Subject m-beta');
    expect(out).not.toContain('Subject m-plain');
    expect(out).not.toContain('Subject INBOX:7');
    expect(w.calls).toContain('search');
    expect(w.searches).toEqual([expect.objectContaining({ cacheOnly: true })]);
  });

  it('an area thread carries only its own confirmed items; an unassigned anchor is refused to an area caller', async () => {
    const w = world();
    const out = await w.op('thread', { message: 'INBOX:7' }, as('sid-alpha'));
    expect(out).toContain('Subject INBOX:7');
    expect(out).not.toContain('Subject m-plain');
    expect(out).not.toContain('Subject m-beta');
    expect(await w.op('thread', { message: 'm-plain' }, as('sid-alpha'))).toContain('area_forbidden');
    expect(await w.op('thread', { message: 'm-beta' }, as('sid-alpha'))).toContain('area_forbidden');
    // An ordinary session's thread still carries unassigned mail.
    expect(await w.op('thread', { message: 'm-plain' }, VP)).toContain('Subject m-plain');
  });

  it('one mail in two folders: an area reads its confirmed copy once, and a thread keeps the copy it was opened on', async () => {
    const count = (text: string) => text.split('Subject m-beta').length - 1;
    const plain = world();
    const w = world({ copyOf: [{ id: 'INBOX:beta', of: 'm-beta' }] });
    const beta = as('sid-beta');
    // The guard asks for every folder's copy and judges each, so the inbox copy listed first (which
    // the store would keep) never hides the confirmed one from its area.
    for (const name of ['search', 'thread'] as const) {
      const args = name === 'search' ? { q: 'Subject' } : { message: 'm-beta' };
      const out = await w.op(name, args, beta);
      expect(count(out), name).toBe(count(await plain.op(name, args, beta)));
      expect(count(out), name).toBeGreaterThan(0);
      expect(out).not.toContain('INBOX:beta');
    }
    expect(w.searches).toEqual([expect.objectContaining({ cacheOnly: true, allCopies: true })]);
    expect(w.threads).toEqual([{ allCopies: true }]);
    // A person opening the inbox copy's thread sees that mail once, as the copy opened.
    const opened = await w.op('thread', { message: 'INBOX:beta' }, PERSON);
    expect(opened).toContain('INBOX:beta');
    expect(count(opened)).toBe(count(await plain.op('thread', { message: 'm-beta' }, PERSON)));
  });

  it('an area caller reads no unassigned mail; an ordinary session does; each area reads its own exact item', async () => {
    const w = world();
    for (const sid of ['sid-alpha', 'sid-beta']) {
      for (const message of ['m-plain', 'Archive:7', 'Home:9']) {
        expect(await w.op('read', { message }, as(sid))).toContain('area_forbidden');
      }
    }
    expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
    expect(await w.op('read', { message: 'm-plain' }, VP)).toContain('Body words of m-plain');
    expect(await w.op('read', { message: 'INBOX:7' }, as('sid-alpha'))).toContain('Body words of INBOX:7');
    expect(await w.op('read', { message: 'm-beta' }, as('sid-beta'))).toContain('Body words of m-beta');
    const listed = await w.op('list', {}, as('sid-alpha'));
    expect(listed).toContain('Subject INBOX:7');
    for (const subject of ['m-plain', 'Archive:7', 'Home:9', 'm-beta', 'All:9']) expect(listed).not.toContain(`Subject ${subject}`);
  });

  it('canary, one account and the same UID in two folders: two exact items, judged apart', async () => {
    const w = world();
    expect(await w.op('read', { message: 'Archive:7' }, VP)).toContain('Body words of Archive:7');
    expect(await w.op('read', { message: 'INBOX:7' }, VP)).toContain('area_forbidden');
    expect(await w.op('read', { message: 'INBOX:7' }, as('sid-alpha'))).toContain('Body words of INBOX:7');
    expect(await w.op('read', { message: 'INBOX:7' }, as('sid-beta'))).toContain('area_forbidden');
  });

  it('canary, an RFC copy of a confirmed item, not yet claimed in any ledger, is refused to every area, its own included', async () => {
    const w = world();
    expect(await w.op('read', { message: 'All:9' }, VP)).toContain('area_forbidden');
    expect(await w.op('read', { message: 'All:9' }, as('sid-alpha'))).toContain('area_forbidden');
    // A sender may reuse an RFC id: the copy's body is a new item nobody confirmed for beta.
    expect(await w.op('read', { message: 'All:9' }, as('sid-beta'))).toContain('area_forbidden');
    const listed = await w.op('list', {}, VP);
    expect(listed).not.toContain('Subject All:9');
    expect(w.calls.filter((c) => c === 'body:All:9')).toEqual([]);
  });

  it('same RFC id, different body: the unconfirmed copy is refused to its own area in read, list, search and thread', async () => {
    const w = world();
    const beta = as('sid-beta');
    const out = await w.op('read', { message: 'All:9' }, beta);
    expect(out).toContain('area_forbidden');
    expect(out).not.toContain('Body words of All:9');
    for (const listed of [await w.op('list', {}, beta), await w.op('search', { q: 'Subject' }, beta), await w.op('thread', { message: 'm-beta' }, beta)]) {
      expect(listed).toContain('Subject m-beta');
      expect(listed).not.toContain('Subject All:9');
    }
    expect(await w.tool('mail_read', { message: 'All:9' }, { callerSid: 'sid-beta' })).toContain('area_forbidden');
    expect(w.calls.filter((c) => c.startsWith('body:All:9'))).toEqual([]);
  });

  it('once the copy itself is confirmed exactly for beta, beta reads it and others still do not', async () => {
    const w = world({ items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'All:9', version: versionOf('All:9') }, areaId: 'beta',
      canonicalKey: mailRouterKey(ACCOUNT, 'All:9', '<beta@example.invalid>') }] });
    expect(await w.op('read', { message: 'All:9' }, as('sid-beta'))).toContain('Body words of All:9');
    expect(await w.op('list', {}, as('sid-beta'))).toContain('Subject All:9');
    expect(await w.op('read', { message: 'All:9' }, as('sid-alpha'))).toContain('area_forbidden');
    expect(await w.op('read', { message: 'All:9' }, VP)).toContain('area_forbidden');
  });

  it('canary, the same RFC id in another account and a different RFC id stay unassigned', async () => {
    const w = world();
    expect(await w.op('read', { message: 'Home:9' }, VP)).toContain('Body words of Home:9');
    expect(await w.op('read', { message: 'Archive:7' }, VP)).toContain('Body words of Archive:7');
    expect(await w.op('read', { message: 'm-plain' }, VP)).toContain('Body words of m-plain');
  });

  it('canary, an RFC copy of an item with no saved key is caught only by the area ledger', async () => {
    const w = world();
    expect(await w.op('read', { message: 'Spam:7' }, VP)).toContain('Body words of Spam:7');
    w.ledgerKeys.set('alpha', new Set([mailRouterKey(ACCOUNT, 'INBOX:7', '<seven@example.invalid>')]));
    expect(await w.op('read', { message: 'Spam:7' }, VP)).toContain('area_forbidden');
    // The ledger restricts the copy; it never grants alpha a body alpha did not confirm.
    expect(await w.op('read', { message: 'Spam:7' }, as('sid-alpha'))).toContain('area_forbidden');
  });

  it('canary, a ledger row under the exact key, versioned or legacy, restricts that message and grants nothing', async () => {
    // The adapter's exact key carries the delivery; a ledger written before versions has none.
    for (const key of [mailRouterKey(ACCOUNT, 'm-plain', '', versionOf('m-plain')), mailRouterKey(ACCOUNT, 'm-plain')]) {
      const w = world();
      w.ledgerKeys.set('beta', new Set([key]));
      for (const ctx of [VP, as('sid-beta'), as('sid-alpha')]) expect(await w.op('read', { message: 'm-plain' }, ctx)).toContain('area_forbidden');
      expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
    }
  });

  it('canary, an RFC copy is caught by the area ledger key built from the cached row', async () => {
    const w = world();
    w.ledgerKeys.set('beta', new Set([mailRouterKey(ACCOUNT, 'm-beta', '<beta@example.invalid>')]));
    expect(await w.op('read', { message: 'All:9' }, VP)).toContain('area_forbidden');
    expect(await w.op('read', { message: 'All:9' }, as('sid-alpha'))).toContain('area_forbidden');
    expect(await w.op('read', { message: 'All:9' }, as('sid-beta'))).toContain('area_forbidden');
    const listed = await w.op('list', {}, VP);
    expect(listed).not.toContain('Subject All:9');
    expect(listed).toContain('Subject Archive:7');
  });

  it('an unreadable registry or ledger refuses every read and reads nothing', async () => {
    for (const w of [world({ registryError: true }), (() => { const x = world(); x.failLedger(); return x; })()]) {
      for (const [name, args] of [['list', {}], ['search', { q: 'x' }], ['read', { message: 'm-plain' }], ['thread', { message: 'm-plain' }]] as const) {
        expect(await w.op(name, args, VP)).toContain('area_unverifiable');
      }
      expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
    }
  });
});

describe('guardMailOps: delivery versions', () => {
  /** One judge of one row: the ledger is asked once per registry area, in order. */
  const JUDGE = ['ledger:alpha', 'ledger:beta'];

  it('a confirmed read judges the envelope before and after the body, then the answer itself', async () => {
    const w = world();
    expect(await w.op('read', { message: 'm-beta' }, as('sid-beta'))).toContain('Body words of m-beta');
    expect(w.calls).toEqual(['envelope:m-beta', ...JUDGE, 'body:m-beta', 'envelope:m-beta', ...JUDGE, ...JUDGE]);
    expect(w.reads).toEqual([expect.objectContaining({ cacheOnly: true })]);
  });

  it('rechecks a classification made while a list or body read is pending', async () => {
    const listed = world({ classifyDuringList: ['m-plain'] });
    expect(await listed.op('list', {}, VP)).not.toContain('Subject m-plain');
    const read = world({ classifyDuringBody: ['m-plain'] });
    const out = await read.op('read', { message: 'm-plain' }, VP);
    expect(out).toContain('area_forbidden');
    expect(out).not.toContain('Body words');
  });

  it('a legacy registry row with no delivery version restricts the handle and grants no area a body', async () => {
    const w = world({ items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'm-plain' }, areaId: 'alpha' }] });
    for (const ctx of [VP, ANONYMOUS, as('sid-alpha'), as('sid-beta')]) {
      const out = await w.op('read', { message: 'm-plain' }, ctx);
      expect(out).toContain('area_forbidden');
      expect(out).not.toContain('Body words');
    }
    expect(await w.op('list', {}, VP)).not.toContain('Subject m-plain');
    const listed = await w.op('list', {}, as('sid-alpha'));
    expect(listed).toContain('Subject INBOX:7');
    expect(listed).not.toContain('Subject m-plain');
    expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
  });

  it('same handle and RFC id, later delivery: restricted by the old confirmation, granted to nobody until confirmed exactly', async () => {
    const w = world({ laterInCache: ['m-beta'] });
    for (const ctx of [as('sid-beta'), as('sid-alpha'), VP, ANONYMOUS]) {
      const out = await w.op('read', { message: 'm-beta' }, ctx);
      expect(out).toContain('area_forbidden');
      expect(out).not.toContain('Body words');
    }
    for (const ctx of [as('sid-beta'), VP]) {
      for (const listed of [await w.op('list', {}, ctx), await w.op('search', { q: 'Subject' }, ctx)]) {
        expect(listed).not.toContain('Subject m-beta');
      }
    }
    expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
    // An exact confirmation of the new delivery is what grants beta.
    const confirmed = world({ laterInCache: ['m-beta'], items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'm-beta',
      version: redelivered(dto(ROWS.find(([one]) => one === 'm-beta')!)).deliveryVersion! }, areaId: 'beta', canonicalKey: mailRouterKey(ACCOUNT, 'm-beta', '<beta@example.invalid>') }] });
    expect(await confirmed.op('read', { message: 'm-beta' }, as('sid-beta'))).toContain('Body words of m-beta');
    expect(await confirmed.op('read', { message: 'm-beta' }, VP)).toContain('area_forbidden');
  });

  it('same handle, a truly new message under a new RFC id: no restriction matches, so it is unassigned', async () => {
    const w = world({ newMessageInCache: ['m-beta'] });
    expect(await w.op('read', { message: 'm-beta' }, VP)).toContain('Body words of m-beta');
    expect(await w.op('list', {}, VP)).toContain('Subject m-beta');
    // Unassigned mail is still no area's.
    for (const sid of ['sid-beta', 'sid-alpha']) expect(await w.op('read', { message: 'm-beta' }, as(sid))).toContain('area_forbidden');
  });

  it('same handle, the cache takes a later delivery while the body is read: refused, the body never returned', async () => {
    const w = world({ redeliverDuringBody: ['m-plain'] });
    const out = await w.op('read', { message: 'm-plain' }, VP);
    expect(out).toContain('area_forbidden');
    expect(out).not.toContain('Body words');
    // Both envelopes passed on their own; the change between them is what refuses.
    expect(w.calls).toEqual(['envelope:m-plain', ...JUDGE, 'body:m-plain', 'envelope:m-plain', ...JUDGE]);
    const area = world({ redeliverDuringBody: ['m-beta'] });
    const refused = await area.op('read', { message: 'm-beta' }, as('sid-beta'));
    expect(refused).toContain('area_forbidden');
    expect(refused).not.toContain('Body words');
    expect(area.calls).toEqual(['envelope:m-beta', ...JUDGE, 'body:m-beta', 'envelope:m-beta', ...JUDGE]);
  });

  it('same handle, the provider answers a later delivery than the cache: the answer is judged and refused', async () => {
    const w = world({ bodyFromLaterDelivery: ['m-beta'] });
    const out = await w.op('read', { message: 'm-beta' }, as('sid-beta'));
    expect(out).toContain('area_forbidden');
    expect(out).not.toContain('Body words');
    expect(w.calls).toEqual(['envelope:m-beta', ...JUDGE, 'body:m-beta', 'envelope:m-beta', ...JUDGE]);
  });

  it('a cached row with no body is answered from the envelope and never asks the provider', async () => {
    const w = world({ noBody: ['m-plain', 'm-beta'] });
    const plain = await w.op('read', { message: 'm-plain' }, VP);
    expect(plain).toContain('Subject m-plain');
    expect(plain).not.toContain('area_forbidden');
    expect(plain).not.toContain('Body words');
    expect(w.calls).toEqual(['envelope:m-plain', ...JUDGE]);
    const own = await w.op('read', { message: 'm-beta' }, as('sid-beta'));
    expect(own).toContain('Subject m-beta');
    expect(own).not.toContain('Body words');
    // No body to read does not lift the area check.
    expect(await w.op('read', { message: 'm-beta' }, VP)).toContain('area_forbidden');
    expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
  });
});

describe('guardMailOps: writes that name an exact message', () => {
  it('mark_read of an assigned message is refused before any flag is written', async () => {
    const w = world();
    expect(await w.op('mark_read', { messages: ['m-plain', 'm-beta'] }, VP)).toContain('area_forbidden');
    expect(writesIn(w.calls)).toEqual([]);
    expect(await w.op('mark_read', { messages: ['m-plain'] }, VP)).toContain('"changed":1');
    expect(w.calls).toContain('markReadMany:m-plain');
  });

  it('unsubscribe_request of an assigned message sends no letter', async () => {
    const w = world();
    expect(await w.op('unsubscribe_request', { message: 'm-beta' }, VP)).toContain('area_forbidden');
    expect(w.calls.filter((c) => c.startsWith('unsubscribe:'))).toEqual([]);
  });

  it('a reply draft to an assigned message is refused before the cached original is copied', async () => {
    const w = world();
    expect(await w.op('draft', { inReplyTo: 'm-beta', to: ['a@example.invalid'] }, VP)).toContain('area_forbidden');
    expect(w.calls.filter((c) => c.startsWith('replyTarget:') || c === 'draft.create')).toEqual([]);
  });

  it('an existing draft bound to an assigned message cannot be edited, read back or sent for approval', async () => {
    const w = world();
    expect(await w.op('draft', { draftId: 'd-beta', subject: 'x' }, VP)).toContain('area_forbidden');
    expect(await w.op('draft', { draftId: 'd-beta' }, VP)).toContain('area_forbidden');
    expect(await w.op('request_send', { draftId: 'd-beta', revision: 1 }, VP)).toContain('area_forbidden');
    expect(writesIn(w.calls)).toEqual([]);
    expect(await w.op('request_send', { draftId: 'd-beta', revision: 1 }, as('sid-beta'))).toContain('letter-1');
  });

  it('a reply draft to unassigned mail reads its target between two envelopes of the same delivery', async () => {
    const w = world();
    expect(await w.op('draft', { inReplyTo: 'm-plain', to: ['a@example.invalid'] }, VP)).toContain('d-made');
    expect(w.calls.filter((c) => c.startsWith('envelope:') || c.startsWith('replyTarget:') || c === 'draft.create'))
      .toEqual(['envelope:m-plain', 'replyTarget:m-plain', 'envelope:m-plain', 'draft.create']);
  });

  it('a reply target of another delivery, or a delivery that changes while it is read, makes no draft', async () => {
    for (const options of [{ replyTargetFromLaterDelivery: ['m-plain'] }, { redeliverDuringReplyTarget: ['m-plain'] }]) {
      const w = world(options);
      expect(await w.op('draft', { inReplyTo: 'm-plain', to: ['a@example.invalid'] }, VP)).toContain('area_forbidden');
      expect(w.calls).toContain('replyTarget:m-plain');
      expect(writesIn(w.calls)).toEqual([]);
    }
    // The area's own confirmed mail: the same race refuses its reply too.
    const area = world({ redeliverDuringReplyTarget: ['m-beta'] });
    expect(await area.op('draft', { inReplyTo: 'm-beta', to: ['a@example.invalid'] }, as('sid-beta'))).toContain('area_forbidden');
    expect(writesIn(area.calls)).toEqual([]);
    const ok = world();
    expect(await ok.op('draft', { inReplyTo: 'm-beta', to: ['a@example.invalid'] }, as('sid-beta'))).toContain('d-made');
  });

  it('a reply target without a delivery version creates no draft', async () => {
    const w = world({ missingVersion: ['m-plain'] });
    expect(await w.op('draft', { inReplyTo: 'm-plain', to: ['a@example.invalid'] }, VP)).toContain('area_forbidden');
    expect(writesIn(w.calls)).toEqual([]);
  });

  it('a draft whose original is not cached is refused, never guessed', async () => {
    const w = world();
    expect(await w.op('request_send', { draftId: 'd-gone', revision: 1 }, VP)).toContain('area_unknown_source');
    expect(writesIn(w.calls)).toEqual([]);
  });

  it('a draft with no original and a person are unchanged', async () => {
    const w = world();
    expect(await w.op('request_send', { draftId: 'd-new', revision: 1 }, VP)).toContain('letter-1');
    expect(await w.op('mark_read', { messages: ['m-beta'] }, PERSON)).toContain('"changed":1');
  });
});

describe('guardMailTools', () => {
  it('a tool with an explicit person reads as before', async () => {
    const w = world();
    expect(await w.tool('mail_read', { message: 'm-beta' }, { callerKind: 'person' })).toContain('Body words of m-beta');
  });

  it('a tool with no caller on its context is an outside agent: unassigned only', async () => {
    const w = world();
    const listed = await w.tool('mail_list', {});
    expect(listed).toContain('Subject m-plain');
    expect(listed).not.toContain('Subject m-beta');
    expect(await w.tool('mail_read', { message: 'm-beta' })).toContain('area_forbidden');
    expect(w.calls.filter((c) => c.startsWith('body:'))).toEqual([]);
    expect(await w.tool('mail_read', { message: 'm-plain' })).toContain('Body words of m-plain');
  });

  it('a tool with a session caller follows the same scope', async () => {
    const w = world();
    expect(await w.tool('mail_read', { message: 'm-plain' }, { callerSid: 'sid-vp' })).toContain('Body words of m-plain');
    expect(await w.tool('mail_read', { message: 'm-beta' }, { callerSid: 'sid-vp' })).toContain('area_forbidden');
  });
});

describe('keepUnassignedMail', () => {
  function guard(options: { registryError?: boolean; ledgerError?: boolean; ledger?: Record<string, string[]> } = {}) {
    const asked: SourceCaller[] = [];
    const readerDeps: SourceReaderDeps = {
      async readAreas() { if (options.registryError) throw new Error('Unexpected token'); return structuredClone(REGISTRY); },
      async session() { return null; },
      async task(id) { return { id, router_area_id: id.slice(2) }; },
      async sessionsForTask() { return []; },
    };
    const ledger: LedgerLookup = async (areaId, keys) => {
      if (options.ledgerError) throw new Error('database is locked');
      return new Set(keys.filter((key) => options.ledger?.[areaId]?.includes(key)));
    };
    const readerFor = (caller: SourceCaller) => { asked.push(caller); return sourceReaderFor(caller, readerDeps); };
    return { asked, keep: (rows: MailMessageDto[]) => keepUnassignedMail(rows, { readerFor, ledger }) };
  }
  const ids = (rows: MailMessageDto[]) => rows.map((m) => m.messageId);

  it('judges as an agent with no area and keeps only unassigned rows, in their order', async () => {
    const g = guard();
    const kept = await g.keep(ROWS.map(dto));
    // INBOX:7 and m-beta are registry items; All:9 is m-beta's RFC copy in the same account.
    expect(ids(kept)).toEqual(['m-plain', 'Archive:7', 'Home:9', 'Spam:7']);
    expect(g.asked).toEqual([{ kind: 'agent' }]);
  });

  it('an RFC copy of an item with no saved key is dropped once the area ledger holds its scope key', async () => {
    const g = guard({ ledger: { alpha: [mailRouterKey(ACCOUNT, 'INBOX:7', '<seven@example.invalid>')] } });
    expect(ids(await g.keep(ROWS.map(dto)))).toEqual(['m-plain', 'Archive:7', 'Home:9']);
  });

  it('an unreadable registry or ledger throws area_unverifiable instead of passing rows through', async () => {
    for (const options of [{ registryError: true }, { ledgerError: true }]) {
      const err = await guard(options).keep(ROWS.map(dto)).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(MailServiceError);
      expect((err as MailServiceError).code).toBe('area_unverifiable');
    }
  });

  it('no rows keeps nothing', async () => {
    expect(await guard().keep([])).toEqual([]);
  });
});
