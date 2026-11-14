import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouterAreasFile } from '../../src/core/router/areas.js';
import type { MailMessageDto } from '../../src/integrations/mail/contract.js';
import type { RouterRoute } from '../../src/core/router/types.js';

const h = vi.hoisted(() => ({ areas: null as unknown, error: null as Error | null,
  ledgers: new Map<string, Map<string, RouterRoute>>(), failed: new Set<string>(), calls: [] as string[] }));
vi.mock('../../src/core/router/areas.js', () => ({ canonicalItemKey: (kind: string, account: string, key: string) => JSON.stringify([kind, account, key]), readRouterAreas: async () => {
  if (h.error) throw h.error;
  return h.areas;
} }));
vi.mock('../../src/core/router/runtime.js', () => ({ routerStore: (areaId: string) => ({ getSources: async (sources: Array<{ kind: string; account: string; message: string }>) => {
  h.calls.push(areaId);
  if (h.failed.has(areaId)) throw new Error('Ledger unavailable');
  return new Map(sources.flatMap((source) => {
    const key = routerKey(source as Parameters<typeof routerKey>[0]);
    const route = h.ledgers.get(areaId)?.get(key);
    return route ? [[key, route]] : [];
  }));
} }) }));
vi.mock('../../src/core/router/service.js', () => ({ routeViews: async (routes: RouterRoute[]) => routes }));
import { decorateMailRoutes } from '../../src/integrations/mail/router-decoration.js';
import { mailRouterKey } from '../../src/integrations/mail/router-source.js';
import { routerKey } from '../../src/core/router/store.js';

const ACCOUNT = 'desk@example.invalid';
const message = (id: string): MailMessageDto => ({ accountId: ACCOUNT, messageId: id, rfcMessageId: `<${id}@example.invalid>`,
  flags: [], subject: `Subject ${id}` } as MailMessageDto);

beforeEach(() => {
  h.error = null; h.ledgers.clear(); h.failed.clear(); h.calls.length = 0;
  h.areas = { version: 1,
    areas: ['personal', 'work'].map((id) => ({ id, name: id, host: '__local__', taskIds: [], sources: [{ kind: 'mail', account: ACCOUNT }] })),
    routers: [], items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'a' }, areaId: 'personal' },
      { source: { kind: 'mail', account: ACCOUNT, message: 'b' }, areaId: 'work' }] } satisfies RouterAreasFile;
  for (const [id, areaId] of [['a', 'personal'], ['b', 'work']]) {
    const item = message(id!);
    const key = mailRouterKey(ACCOUNT, item.messageId, item.rfcMessageId);
    h.ledgers.set(areaId!, new Map([[routerKey({ kind: 'mail', account: ACCOUNT, message: id! }), { areaId: areaId!, key, source: { kind: 'mail', account: ACCOUNT, message: id! },
      status: 'not_routed', reason: 'No action', subject: item.subject, sender: '', at: 1 }]]));
  }
});

describe('mail route decoration', () => {
  it('says why a message without an area has no router: no router takes its account, or one does and the message has no area', async () => {
    const file = h.areas as RouterAreasFile;
    const other = { ...message('z'), accountId: 'other@example.invalid' };
    // Areas list the account, but no router belongs to them yet: nobody reads it.
    let rows = await decorateMailRoutes([message('c'), other], '/fixture');
    expect(rows.map((r) => r.routingCoverage)).toEqual(['no_router', 'no_router']);
    // A router assigned to an area but not a member of it counts for nothing.
    file.routers = [{ taskId: 'router-p', areaId: 'personal', paused: true }];
    rows = await decorateMailRoutes([message('c')], '/fixture');
    expect(rows[0]!.routingCoverage).toBe('no_router');
    file.areas[0]!.taskIds = ['router-p'];
    rows = await decorateMailRoutes([message('a'), message('c'), other], '/fixture');
    expect(rows[0]).not.toHaveProperty('routingCoverage');
    expect(rows[0]!.routingArea).toEqual({ id: 'personal', name: 'personal', paused: true });
    expect(rows[1]!.routingCoverage).toBe('unassigned');
    expect(rows[2]!.routingCoverage).toBe('no_router');
    file.routers[0]!.paused = false;
    rows = await decorateMailRoutes([message('a')], '/fixture');
    expect(rows[0]!.routingArea).toEqual({ id: 'personal', name: 'personal', paused: false });
  });

  it('keeps exact item areas apart within the same account and leaves unassigned items alone', async () => {
    const rows = await decorateMailRoutes(['a', 'b', 'c'].map(message), '/fixture');
    expect(rows[0]).toMatchObject({ routingArea: { id: 'personal' }, route: { areaId: 'personal' } });
    expect(rows[1]).toMatchObject({ routingArea: { id: 'work' }, route: { areaId: 'work' } });
    expect(rows[2]).not.toHaveProperty('routingArea');
    expect(rows[2]).not.toHaveProperty('route');
    expect(h.calls).toEqual(['personal', 'work']);
  });

  it('does not decorate a later delivery of the same handle with an old confirmation or receipt', async () => {
    const file = h.areas as RouterAreasFile;
    file.items[0]!.source.version = 'first';
    const older = message('a');
    older.deliveryVersion = 'first';
    const source = { kind: 'mail' as const, account: ACCOUNT, message: 'a', version: 'first' };
    const route = { ...h.ledgers.get('personal')!.values().next().value!, source };
    h.ledgers.set('personal', new Map([[routerKey(source), route]]));
    const newer = { ...older, deliveryVersion: 'second' };
    const rows = await decorateMailRoutes([older, newer], '/fixture');
    expect(rows[0]).toMatchObject({ routingArea: { id: 'personal' }, route: { areaId: 'personal' } });
    expect(rows[1]).not.toHaveProperty('routingArea');
    expect(rows[1]).not.toHaveProperty('route');
  });

  it('finds the receipt by its confirmed source when the cached canonical identity changes', async () => {
    const source = { kind: 'mail' as const, account: ACCOUNT, message: 'a' };
    const route = h.ledgers.get('personal')!.get(routerKey(source))!;
    route.key = routerKey({ ...source, message: 'before-move' });
    route.source.message = 'before-move';
    const rows = await decorateMailRoutes([message('a')], '/fixture');
    expect(rows[0]).toMatchObject({ route: { areaId: 'personal', status: 'not_routed', reason: 'No action' } });
    expect(h.calls).toEqual(['personal']);
  });

  it('never presents an unconfirmed source as authorized merely because its Message-ID matches', async () => {
    const file = h.areas as RouterAreasFile;
    file.items[0]!.canonicalKey = mailRouterKey(ACCOUNT, 'a', message('a').rfcMessageId);
    const copy = { ...message('moved'), rfcMessageId: message('a').rfcMessageId };
    const unrelatedAccount = { ...copy, accountId: 'another@example.invalid' };
    const rows = await decorateMailRoutes([copy, unrelatedAccount], '/fixture');
    expect(rows[0]).not.toHaveProperty('routingArea');
    expect(rows[0]).not.toHaveProperty('route');
    expect(rows[1]).not.toHaveProperty('routingArea');
    expect(h.calls).toEqual([]);
  });

  it('keeps mail readable when one ledger fails without calling that an absent receipt', async () => {
    h.failed.add('personal');
    const rows = await decorateMailRoutes(['a', 'b', 'c'].map(message), '/fixture');
    expect(rows[0]).toMatchObject({ routingUnavailable: true, routingArea: { id: 'personal' } });
    expect(rows[0]).not.toHaveProperty('route');
    expect(rows[1]).toHaveProperty('route');
    expect(rows[1]).not.toHaveProperty('routingUnavailable');
    expect(rows[2]).not.toHaveProperty('routingUnavailable');
  });

  it('reports a broken area registry without blocking cached mail', async () => {
    h.error = new Error('Registry unreadable');
    const rows = await decorateMailRoutes(['a', 'b'].map(message), '/fixture');
    expect(rows.every((row) => row.routingUnavailable)).toBe(true);
    expect(h.calls).toEqual([]);
    expect(rows.map((row) => row.subject)).toEqual(['Subject a', 'Subject b']);
  });

  it('looks up a dense page once per area and preserves mail flags', async () => {
    const messages = Array.from({ length: 500 }, (_, i) => message(`m${i}`));
    const file = h.areas as RouterAreasFile;
    file.items = messages.map((item, i) => ({ source: { kind: 'mail', account: ACCOUNT, message: item.messageId }, areaId: i % 2 ? 'work' : 'personal' }));
    const rows = await decorateMailRoutes(messages, '/fixture');
    expect(rows).toHaveLength(500);
    expect(h.calls).toHaveLength(2);
    expect(rows.map((row) => row.flags)).toEqual(messages.map((row) => row.flags));
  });

  it('carries a legacy receipt\'s origin and evidence, and adds neither to a normal route', async () => {
    const legacySource = { kind: 'mail' as const, account: ACCOUNT, message: 'a' };
    const legacy = h.ledgers.get('personal')!.get(routerKey(legacySource))!;
    Object.assign(legacy, { status: 'routed', taskId: 'task-1', origin: 'legacy', evidence: 'Handled in the desk thread' });
    const [a, b] = await decorateMailRoutes([message('a'), message('b')], '/fixture');
    expect(a!.route).toMatchObject({ status: 'routed', origin: 'legacy', evidence: 'Handled in the desk thread' });
    expect(b!.route).not.toHaveProperty('origin');
    expect(b!.route).not.toHaveProperty('evidence');
  });
});
