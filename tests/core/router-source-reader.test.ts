import { describe, expect, it } from 'vitest';
import type { RouterAreasFile } from '../../src/core/router/areas.js';
import { sourceReaderFor, type SourceReaderDeps } from '../../src/core/router/source-reader.js';

const ACCOUNT = 'desk@example.invalid';
const OTHER_ACCOUNT = 'home@example.invalid';
const mail = (message: string, account = ACCOUNT) => ({ kind: 'mail' as const, account, message });
const session = (sid: string) => ({ kind: 'session' as const, sid });

function registry(): RouterAreasFile {
  return {
    version: 1,
    areas: [
      { id: 'alpha', name: 'Alpha', host: '__local__', taskIds: ['t-alpha'], sources: [{ kind: 'mail', account: ACCOUNT }] },
      { id: 'beta', name: 'Beta', host: '__local__', taskIds: ['t-beta'], sources: [{ kind: 'mail', account: ACCOUNT }] },
    ],
    routers: [{ taskId: 't-assigned', areaId: 'beta', paused: false }],
    items: [
      { source: { kind: 'mail', account: ACCOUNT, message: 'INBOX:7' }, areaId: 'alpha' },
      { source: { kind: 'mail', account: ACCOUNT, message: 'm-beta' }, areaId: 'beta' },
      // An area that is gone, and an area that does not list this account: still assigned.
      { source: { kind: 'mail', account: ACCOUNT, message: 'm-ghost' }, areaId: 'gone' },
      { source: { kind: 'mail', account: OTHER_ACCOUNT, message: 'INBOX:7' }, areaId: 'beta' },
      // Confirmed with the adapter's canonical key: two exact items of one area may share it.
      { source: { kind: 'mail', account: ACCOUNT, message: 'm-canon' }, areaId: 'alpha', canonicalKey: 'key-canon' },
      { source: { kind: 'mail', account: ACCOUNT, message: 'All:canon' }, areaId: 'alpha', canonicalKey: 'key-canon' },
      { source: { kind: 'mail', account: ACCOUNT, message: 'm-split' }, areaId: 'beta', canonicalKey: 'key-split' },
    ],
  };
}

interface Fake {
  sessions?: Record<string, { taskId?: string; legacyTaskId?: string; profile?: { areaId?: string } }>;
  tasks?: Record<string, { id: string; router_area_id?: string; org_role?: string }>;
  taskSessions?: Record<string, Array<{ profile?: { areaId?: string } }>>;
  areasError?: Error;
  taskError?: Error;
}

function deps(fake: Fake, calls: string[] = []): SourceReaderDeps {
  return {
    async readAreas() { calls.push('areas'); if (fake.areasError) throw fake.areasError; return registry(); },
    async session(sid) { calls.push(`session:${sid}`); return (fake.sessions?.[sid] ?? null) as never; },
    async task(id) { calls.push(`task:${id}`); if (fake.taskError) throw fake.taskError; return fake.tasks?.[id] as never; },
    async sessionsForTask(id) { calls.push(`sessions:${id}`); return (fake.taskSessions?.[id] ?? []) as never; },
  };
}

async function scoped(sid: string, fake: Fake) {
  const reader = await sourceReaderFor(session(sid), deps(fake));
  if (reader.kind !== 'scoped') throw new Error(reader.kind);
  return reader;
}

describe('delivery version grants', () => {
  it('an exact old confirmation grants neither a later delivery nor a handle without its version', async () => {
    const file = registry();
    file.items = [{ areaId: 'alpha', source: { ...mail('conversation-1'), version: 'first' }, canonicalKey: 'first-copy' }];
    const reader = await sourceReaderFor(session('sid-alpha'), {
      ...deps({ sessions: { 'sid-alpha': { taskId: 't-alpha', profile: { areaId: 'alpha' } } }, tasks: { 't-alpha': { id: 't-alpha' } } }),
      readAreas: async () => file,
    });
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    expect(reader.allows({ ...mail('conversation-1'), version: 'first', canonicalKey: 'first-copy' })).toBe(true);
    expect(reader.allows({ ...mail('conversation-1'), version: 'second', canonicalKey: 'second-copy' })).toBe(false);
    expect(reader.allows(mail('conversation-1'))).toBe(false);
    const outside = await sourceReaderFor({ kind: 'agent' }, { ...deps({}), readAreas: async () => file });
    if (outside.kind !== 'scoped') throw new Error(outside.kind);
    expect(outside.allows({ ...mail('conversation-1'), version: 'second', canonicalKey: 'second-copy' })).toBe(true);
    expect(outside.allows({ ...mail('conversation-1'), version: 'second', canonicalKey: 'first-copy' })).toBe(false);
    expect(outside.allows(mail('conversation-1'))).toBe(false);
    expect(outside.allows(mail('never-confirmed'))).toBe(true);
  });

  it('an old unversioned confirmation restricts a new delivery but never grants its body', async () => {
    const file = registry();
    file.items = [{ areaId: 'alpha', source: mail('legacy-1') }];
    for (const caller of [session('sid-alpha'), { kind: 'agent' as const }]) {
      const reader = await sourceReaderFor(caller, {
        ...deps({ sessions: { 'sid-alpha': { taskId: 't-alpha', profile: { areaId: 'alpha' } } }, tasks: { 't-alpha': { id: 't-alpha' } } }),
        readAreas: async () => file,
      });
      if (reader.kind !== 'scoped') throw new Error(reader.kind);
      expect(reader.allows({ ...mail('legacy-1'), version: 'new-delivery' })).toBe(false);
    }
  });
});

describe('sourceReaderFor', () => {
  it('a person is open and nothing is read', async () => {
    const calls: string[] = [];
    expect(await sourceReaderFor({ kind: 'person' }, deps({}, calls))).toEqual({ kind: 'open' });
    expect(calls).toEqual([]);
  });

  it('an agent with no session id is an outside caller, never a person: unassigned only', async () => {
    const calls: string[] = [];
    const reader = await sourceReaderFor({ kind: 'agent' }, deps({}, calls));
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    expect(reader.allows(mail('m-plain'))).toBe(true);
    expect(reader.allows(mail('INBOX:7'))).toBe(false);
    expect(reader.allows(mail('m-ghost'))).toBe(false);
    // The registry is read, no caller lookup is made.
    expect(calls).toEqual(['areas']);
  });

  it('an agent still fails closed on an unreadable registry; a session with an empty id is unverifiable', async () => {
    expect(await sourceReaderFor({ kind: 'agent' }, deps({ areasError: new Error('Unexpected token') }))).toEqual({ kind: 'unverifiable' });
    const calls: string[] = [];
    expect(await sourceReaderFor(session('  '), deps({}, calls))).toEqual({ kind: 'unverifiable' });
    expect(calls).toEqual([]);
  });

  it('an ordinary full-tool session reads unassigned mail, never an assigned item of any area', async () => {
    const reader = await scoped('sid-main', { sessions: { 'sid-main': { taskId: 't-main' } }, tasks: { 't-main': { id: 't-main', org_role: 'main' } } });
    expect(reader.allows(mail('m-plain'))).toBe(true);
    expect(reader.allows(mail('INBOX:7'))).toBe(false);
    expect(reader.allows(mail('m-beta'))).toBe(false);
    expect(reader.allows(mail('m-ghost'))).toBe(false);
  });

  it('an unknown sid and a plugin id are outside callers: unassigned only', async () => {
    for (const sid of ['sid-nobody', 'plugin:mail']) {
      const reader = await scoped(sid, {});
      expect(reader.allows(mail('m-plain'))).toBe(true);
      expect(reader.allows(mail('INBOX:7'))).toBe(false);
    }
  });

  it('an area caller reads its own exact item; another item of the same account grants nothing', async () => {
    const reader = await scoped('sid-a', {
      sessions: { 'sid-a': { taskId: 't-alpha', profile: { areaId: 'alpha' } } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha', org_role: 'router' } },
    });
    expect(reader.allows(mail('INBOX:7'))).toBe(true);
    expect(reader.allows(mail('m-beta'))).toBe(false);
    // Confirmed per item both ways: an area caller reads no unassigned mail.
    expect(reader.allows(mail('m-plain'))).toBe(false);
    // The same id in another account is another item, assigned to beta.
    expect(reader.allows(mail('INBOX:7', OTHER_ACCOUNT))).toBe(false);
  });

  it('canary, one account, same UID in another folder: a different exact item, unassigned', async () => {
    const reader = await scoped('sid-a', {
      sessions: { 'sid-a': { taskId: 't-alpha', profile: { areaId: 'alpha' } } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha' } },
    });
    expect([...reader.itemAreas(mail('INBOX:7'))]).toEqual(['alpha']);
    expect([...reader.itemAreas(mail('Archive:7'))]).toEqual([]);
    expect([...reader.itemAreas(mail('inbox:7'))]).toEqual([]);
  });

  it('a canonical key only restricts: an unconfirmed copy is refused to the key\'s own area, an exact row is allowed', async () => {
    const reader = await scoped('sid-a', {
      sessions: { 'sid-a': { taskId: 't-alpha', profile: { areaId: 'alpha' } } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha' } },
    });
    expect(reader.allows({ ...mail('m-canon'), canonicalKey: 'key-canon' })).toBe(true);
    expect(reader.allows({ ...mail('All:canon'), canonicalKey: 'key-canon' })).toBe(true);
    const copy = { ...mail('Spam:canon'), canonicalKey: 'key-canon' };
    expect([...reader.itemAreas(copy)]).toEqual(['alpha']);
    expect([...reader.exactAreas(copy)]).toEqual([]);
    expect(reader.allows(copy)).toBe(false);
    expect(reader.allowsItem(new Set(['alpha']), new Set())).toBe(false);
    expect(reader.allowsItem(new Set(['alpha']), new Set(['alpha']))).toBe(true);
    expect(reader.allowsItem(new Set(), new Set())).toBe(false);
    // A copy of another area's key is refused as before.
    expect(reader.allows({ ...mail('Spam:split'), canonicalKey: 'key-split' })).toBe(false);
  });

  it('a router assignment in the registry is a scope, as in the middleware', async () => {
    const reader = await scoped('sid-r', { sessions: { 'sid-r': { taskId: 't-assigned' } }, tasks: { 't-assigned': { id: 't-assigned', org_role: 'router' } } });
    expect(reader.allows(mail('m-beta'))).toBe(true);
    expect(reader.allows(mail('INBOX:7'))).toBe(false);
  });

  it('scopes come from profile, task mark and registry together; disagreeing places match nobody', async () => {
    const reader = await scoped('sid-x', {
      sessions: { 'sid-x': { taskId: 't-alpha', profile: { areaId: 'beta' } } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha' } },
    });
    expect(reader.allows(mail('INBOX:7'))).toBe(false);
    expect(reader.allows(mail('m-beta'))).toBe(false);
    // A caller with conflicting areas is an area caller too: no unassigned body either.
    expect(reader.allows(mail('m-plain'))).toBe(false);
  });

  it('a sibling session profile on the caller task counts as a scope', async () => {
    const reader = await scoped('sid-x', {
      sessions: { 'sid-x': { taskId: 't-alpha' } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha' } },
      taskSessions: { 't-alpha': [{ profile: { areaId: 'beta' } }] },
    });
    expect(reader.allows(mail('INBOX:7'))).toBe(false);
  });

  it('a router task placed nowhere matches no area', async () => {
    const reader = await scoped('sid-r', {
      sessions: { 'sid-r': { taskId: 't-loose' } },
      tasks: { 't-loose': { id: 't-loose', org_role: 'router' } },
      taskSessions: { 't-loose': [{ profile: { areaId: 'alpha' } }] },
    });
    expect(reader.allows(mail('INBOX:7'))).toBe(false);
  });

  it('an unreadable registry or task store fails closed', async () => {
    expect(await sourceReaderFor(session('sid-main'), deps({ areasError: new Error('Unexpected token') }))).toEqual({ kind: 'unverifiable' });
    expect(await sourceReaderFor(session('sid-main'), deps({ sessions: { 'sid-main': { taskId: 't-main' } }, taskError: new Error('database is locked') })))
      .toEqual({ kind: 'unverifiable' });
  });

  it('one reader costs one registry read and the caller lookups, never a full listing', async () => {
    const calls: string[] = [];
    const reader = await sourceReaderFor(session('sid-main'), deps({ sessions: { 'sid-main': { taskId: 't-main' } }, tasks: { 't-main': { id: 't-main' } } }, calls));
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    for (const id of ['m-plain', 'INBOX:7', 'm-beta']) reader.allows(mail(id));
    expect(calls).toEqual(['areas', 'session:sid-main', 'task:t-main', 'sessions:t-main']);
    expect(reader.areaIds).toEqual(['alpha', 'beta']);
  });

  it('a confirmed canonical key covers copies of the same kind and account, never another account or key', async () => {
    const reader = await scoped('sid-main', { sessions: { 'sid-main': { taskId: 't-main' } }, tasks: { 't-main': { id: 't-main' } } });
    const copy = { ...mail('Spam:canon'), canonicalKey: 'key-canon' };
    expect([...reader.itemAreas(copy)]).toEqual(['alpha']);
    expect(reader.allows(copy)).toBe(false);
    // Without a key the copy is another exact item, as before.
    expect(reader.allows(mail('Spam:canon'))).toBe(true);
    expect(reader.allows({ ...mail('Spam:canon', OTHER_ACCOUNT), canonicalKey: 'key-canon' })).toBe(true);
    expect(reader.allows({ ...mail('Spam:canon'), canonicalKey: 'key-other' })).toBe(true);
    expect(reader.allows({ ...mail('Spam:canon'), canonicalKey: '' })).toBe(true);
  });

  it('a confirmed key restricts its copy but grants neither area its unconfirmed body', async () => {
    const alpha = await scoped('sid-a', {
      sessions: { 'sid-a': { taskId: 't-alpha', profile: { areaId: 'alpha' } } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha' } },
    });
    const beta = await scoped('sid-b', {
      sessions: { 'sid-b': { taskId: 't-beta', profile: { areaId: 'beta' } } },
      tasks: { 't-beta': { id: 't-beta', router_area_id: 'beta' } },
    });
    const copy = { ...mail('Spam:canon'), canonicalKey: 'key-canon' };
    expect(alpha.allows(copy)).toBe(false);
    expect(beta.allows(copy)).toBe(false);
  });

  it('an exact item and a key of different areas is a conflict: no scoped caller reads it', async () => {
    const beta = await scoped('sid-b', {
      sessions: { 'sid-b': { taskId: 't-beta', profile: { areaId: 'beta' } } },
      tasks: { 't-beta': { id: 't-beta', router_area_id: 'beta' } },
    });
    const alpha = await scoped('sid-a', {
      sessions: { 'sid-a': { taskId: 't-alpha', profile: { areaId: 'alpha' } } },
      tasks: { 't-alpha': { id: 't-alpha', router_area_id: 'alpha' } },
    });
    // INBOX:7 is alpha's exact item; key-split belongs to beta.
    const mixed = { ...mail('INBOX:7'), canonicalKey: 'key-split' };
    expect(new Set(alpha.itemAreas(mixed))).toEqual(new Set(['alpha', 'beta']));
    expect(alpha.allows(mixed)).toBe(false);
    expect(beta.allows(mixed)).toBe(false);
  });
});

describe('pending inbound rules', () => {
  // A rule confirmed for alpha whose capture of this item failed: nothing persisted for it yet.
  const bakery = { areaId: 'alpha', match: { from: 'bakery.example.invalid' } };
  const fresh = (message: string, sender: string, subject = 'Pickup reminder') =>
    ({ ...mail(message), version: `v-${message}`, canonicalKey: `rfc-${message}`, sender, subject });
  const withRules = (pending: SourceReaderDeps['readPendingRules'], file = registry()): SourceReaderDeps => ({
    ...deps({ sessions: { 'sid-alpha': { taskId: 't-alpha', profile: { areaId: 'alpha' } } }, tasks: { 't-alpha': { id: 't-alpha' } } }),
    readAreas: async () => ({ ...file, ruleBindings: [{ ruleId: 'rr-1', revision: 'a'.repeat(64), areaId: 'alpha', confirmedAt: 1 }] }),
    ...(pending ? { readPendingRules: pending } : {}),
  });

  it('a matching item whose confirm failed is denied to an ordinary agent and to its own area alike', async () => {
    const item = fresh('INBOX:new', 'front-desk@bakery.example.invalid');
    for (const caller of [{ kind: 'agent' as const }, session('sid-alpha')]) {
      const reader = await sourceReaderFor(caller, withRules(async () => [bakery]));
      if (reader.kind !== 'scoped') throw new Error(reader.kind);
      expect([...reader.itemAreas(item)]).toEqual(['alpha']);
      expect(reader.exactAreas(item).size).toBe(0);
      expect(reader.allows(item)).toBe(false);
    }
  });

  it('mail no live rule matches stays readable for an ordinary agent', async () => {
    const reader = await sourceReaderFor({ kind: 'agent' }, withRules(async () => [bakery]));
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    expect(reader.allows(fresh('INBOX:news', 'news@paper.example.invalid', 'Morning edition'))).toBe(true);
  });

  it('a copy or a new delivery with another RFC id is still restricted by its metadata', async () => {
    const reader = await sourceReaderFor({ kind: 'agent' }, withRules(async () => [bakery]));
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    expect(reader.allows({ ...fresh('All:copy', 'bakery.example.invalid'), canonicalKey: 'key-canon' })).toBe(false);
    expect(reader.allows({ ...fresh('INBOX:new', 'bakery.example.invalid'), version: 'v-later', canonicalKey: 'rfc-other' })).toBe(false);
  });

  it('the own area keeps an exact item its rule matches, and a second matching area denies it', async () => {
    const file = registry();
    file.items.push({ source: { ...mail('INBOX:kept'), version: 'v-INBOX:kept' }, areaId: 'alpha' });
    const own = await sourceReaderFor(session('sid-alpha'), withRules(async () => [bakery], file));
    if (own.kind !== 'scoped') throw new Error(own.kind);
    expect(own.allows(fresh('INBOX:kept', 'bakery.example.invalid'))).toBe(true);
    const both = await sourceReaderFor(session('sid-alpha'), withRules(async () => [bakery, { areaId: 'beta', match: { subject: 'pickup' } }], file));
    if (both.kind !== 'scoped') throw new Error(both.kind);
    expect(both.allows(fresh('INBOX:kept', 'bakery.example.invalid'))).toBe(false);
  });

  it('missing metadata lets every candidate area restrict', async () => {
    const reader = await sourceReaderFor({ kind: 'agent' }, withRules(async () => [bakery]));
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    expect(reader.allows({ ...mail('INBOX:bare'), version: 'v-bare' })).toBe(false);
    const noDep = await sourceReaderFor({ kind: 'agent' }, withRules(undefined));
    if (noDep.kind !== 'scoped') throw new Error(noDep.kind);
    expect(noDep.allows(fresh('INBOX:news', 'news@paper.example.invalid', 'Morning edition'))).toBe(false);
  });

  it('a rule lookup that fails makes the reader unverifiable', async () => {
    const reader = await sourceReaderFor({ kind: 'agent' }, withRules(async () => { throw new Error('rules unreadable'); }));
    expect(reader.kind).toBe('unverifiable');
  });

  it('a registry with no bindings never reads rules', async () => {
    const calls: string[] = [];
    const reader = await sourceReaderFor({ kind: 'agent' }, { ...deps({}), readPendingRules: async () => { calls.push('rules'); return [bakery]; } });
    if (reader.kind !== 'scoped') throw new Error(reader.kind);
    expect(reader.allows(fresh('INBOX:new', 'bakery.example.invalid'))).toBe(true);
    expect(calls).toEqual([]);
  });
});
