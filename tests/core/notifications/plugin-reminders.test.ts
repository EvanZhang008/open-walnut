/**
 * Plugin reminders, buttons, dismiss and quiet (walnut.notifications).
 *
 * Graded against the REAL notification store and quiet state on disk, because the
 * contract is about how the plugin seam and the store meet:
 *   - `kind: 'reminder'` re-fired under a stable key REPLACES the previous record
 *     (fresh id, unread again) and announces `notification:removed` BEFORE the
 *     `notification:new`, so a client showing the old toast can show the new one.
 *     A 'skill' notice keeps first-write-wins.
 *   - `dismiss` removes the plugin's own record and announces it; a re-fire after
 *     a dismiss inserts a fresh record.
 *   - buttons are bound host-side to THIS plugin's ops: a plugin can name only a
 *     local op, and the host prefixes it, so a notice can never run another
 *     plugin's op on the human's click.
 *   - the quiet hold is `plugin:<id>`, and disposing the plugin clears it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('plugin-reminders-test'));
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ plugins: {} })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { bus } from '../../../src/core/event-bus.js';
import { IntegrationRegistry } from '../../../src/core/integration-registry.js';
import { PluginContext, type PluginLogger } from '../../../src/core/plugins/plugin-context.js';
import { createServerPluginApi } from '../../../src/core/plugins/server-api.js';
import {
  listNotifications, markRead, removeNotification, replaceNotification, addNotification,
} from '../../../src/core/notifications/store.js';
import { getQuiet, stopQuiet } from '../../../src/core/quiet/quiet-state.js';
import { createTestPluginApi } from '../plugin-test-utils.js';

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const contexts: PluginContext[] = [];
const seen: Array<{ name: string; data: Record<string, unknown>; destinations: string[] }> = [];

function pluginApi(pluginId: string) {
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger });
  contexts.push(context);
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId });
  const api = createServerPluginApi({
    context, pluginName: pluginId, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry(),
  });
  return { api, context };
}

const NOTIFICATIONS_FILE = () => path.join(WALNUT_HOME, 'notifications.json');

beforeEach(() => {
  fs.rmSync(NOTIFICATIONS_FILE(), { force: true });
  fs.rmSync(path.join(WALNUT_HOME, 'quiet.json'), { force: true });
  stopQuiet();
  seen.length = 0;
  bus.subscribe('plugin-reminders-observer', (event) => {
    seen.push({ name: event.name, data: event.data as Record<string, unknown>, destinations: event.destinations });
  }, { global: true, interest: ['notification:'] });
});

afterEach(async () => {
  bus.unsubscribe('plugin-reminders-observer');
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined);
  stopQuiet();
});

describe('store: replace, remove, mark read by key', () => {
  it('replaceNotification swaps the record under one key and returns what it replaced', async () => {
    const first = await replaceNotification({ kind: 'reminder', severity: 'info', title: 'Stand up', dedupKey: 'k' });
    await markRead([first.record.id]);
    const second = await replaceNotification({ kind: 'reminder', severity: 'info', title: 'Stand up again', dedupKey: 'k' });
    expect(second.replaced?.id).toBe(first.record.id);
    expect(second.record.id).not.toBe(first.record.id);
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ title: 'Stand up again', read: false });
  });

  it('removeNotification returns the removed record, and null when it is gone', async () => {
    const rec = await addNotification({ kind: 'skill', severity: 'info', title: 'x', dedupKey: 'gone' });
    expect((await removeNotification('gone'))?.id).toBe(rec.id);
    expect(await removeNotification('gone')).toBeNull();
    expect((await listNotifications()).feed).toHaveLength(0);
  });

  it('markRead accepts dedupKeys (a live entry only knows its key)', async () => {
    await addNotification({ kind: 'reminder', severity: 'info', title: 'a', dedupKey: 'a' });
    await addNotification({ kind: 'reminder', severity: 'info', title: 'b', dedupKey: 'b' });
    const { unreadCount } = await markRead(undefined, ['a']);
    expect(unreadCount).toBe(1);
    const { feed } = await listNotifications();
    expect(feed.find(n => n.dedupKey === 'a')?.read).toBe(true);
    expect(feed.find(n => n.dedupKey === 'b')?.read).toBe(false);
  });
});

describe('walnut.notifications.notify (reminder + actions)', () => {
  it('stores a reminder with host-bound op buttons and announces it to the browser', async () => {
    const { api } = pluginApi('walnut-rhythm');
    await api.notifications.notify({
      kind: 'reminder', title: 'Time to stand up', dedupKey: 'stand-up',
      actions: [
        { label: 'Done', op: 'break_done', args: { minutes: 2 } },
        { label: 'Snooze 10m', op: 'walnut_rhythm_snooze' },
      ],
    });
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'reminder',
      dedupKey: 'plugin:walnut-rhythm:stand-up',
      actions: [
        { kind: 'op', label: 'Done', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_done', args: { minutes: 2 } },
        // Already prefixed: left as is.
        { kind: 'op', label: 'Snooze 10m', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_snooze' },
      ],
    });
    expect(seen.map(e => e.name)).toEqual(['notification:new']);
    expect(seen[0].destinations).toEqual(['web-ui']);
  });

  it('cannot name another plugin\'s op: the host always prefixes with its own id', async () => {
    const { api } = pluginApi('walnut-rhythm');
    await api.notifications.notify({
      kind: 'reminder', title: 't', dedupKey: 'k', actions: [{ label: 'Go', op: 'mail_send' }],
    });
    const [rec] = (await listNotifications()).feed;
    expect(rec.actions?.[0]).toMatchObject({ pluginId: 'walnut-rhythm', op: 'walnut_rhythm_mail_send' });
  });

  it('refuses more than three buttons, an empty label, and an op name outside [a-z0-9_]', async () => {
    const { api } = pluginApi('walnut-rhythm');
    const four = Array.from({ length: 4 }, (_, i) => ({ label: `b${i}`, op: 'x' }));
    await expect(api.notifications.notify({ title: 't', dedupKey: 'k', actions: four })).rejects.toThrow(/at most 3/);
    await expect(api.notifications.notify({ title: 't', dedupKey: 'k', actions: [{ label: ' ', op: 'x' }] }))
      .rejects.toThrow(/label/);
    await expect(api.notifications.notify({ title: 't', dedupKey: 'k', actions: [{ label: 'Go', op: 'Bad-Op' }] }))
      .rejects.toThrow(/op name/);
    expect((await listNotifications()).feed).toHaveLength(0);
  });

  it('a reminder re-fire REPLACES: removed first, then new, with a fresh unread record', async () => {
    const { api } = pluginApi('walnut-rhythm');
    await api.notifications.notify({ kind: 'reminder', title: 'Stand up', dedupKey: 'stand-up' });
    const firstId = (await listNotifications()).feed[0].id;
    await markRead([firstId]);
    seen.length = 0;

    await api.notifications.notify({ kind: 'reminder', title: 'Stand up (45 min)', dedupKey: 'stand-up' });
    expect(seen.map(e => e.name)).toEqual(['notification:removed', 'notification:new']);
    expect(seen[0].data).toEqual({ id: firstId, dedupKey: 'plugin:walnut-rhythm:stand-up' });
    const { feed, unreadCount } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).not.toBe(firstId);
    expect(feed[0].title).toBe('Stand up (45 min)');
    expect(unreadCount).toBe(1);
  });

  it('a skill notice keeps first-write-wins under the same key', async () => {
    const { api } = pluginApi('walnut-rhythm');
    await api.notifications.notify({ title: 'first', dedupKey: 'same' });
    await api.notifications.notify({ title: 'second', dedupKey: 'same' });
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'skill', title: 'first' });
    expect(seen.some(e => e.name === 'notification:removed')).toBe(false);
  });
});

describe('walnut.notifications.dismiss', () => {
  it('removes the plugin\'s own record and announces it; a re-fire after it inserts fresh', async () => {
    const { api } = pluginApi('walnut-rhythm');
    await api.notifications.notify({ kind: 'reminder', title: 'Stand up', dedupKey: 'stand-up' });
    const firstId = (await listNotifications()).feed[0].id;
    seen.length = 0;

    await api.notifications.dismiss('stand-up');
    expect((await listNotifications()).feed).toHaveLength(0);
    expect(seen).toEqual([{
      name: 'notification:removed',
      data: { id: firstId, dedupKey: 'plugin:walnut-rhythm:stand-up' },
      destinations: ['web-ui'],
    }]);

    await api.notifications.notify({ kind: 'reminder', title: 'Stand up', dedupKey: 'stand-up' });
    const { feed } = await listNotifications();
    expect(feed).toHaveLength(1);
    expect(feed[0].id).not.toBe(firstId);
    expect(feed[0].read).toBe(false);
  });

  it('only reaches its own namespace, and resolves when the record is already gone', async () => {
    const other = pluginApi('other').api;
    await other.notifications.notify({ title: 'theirs', dedupKey: 'stand-up' });
    const { api } = pluginApi('walnut-rhythm');
    await api.notifications.dismiss('stand-up');
    const { feed } = await listNotifications();
    expect(feed.map(n => n.dedupKey)).toEqual(['plugin:other:stand-up']);
  });
});

describe('walnut.notifications.quiet', () => {
  it('holds quiet as plugin:<id>, and disposing the plugin clears the hold', async () => {
    const { api, context } = pluginApi('walnut-rhythm');
    const until = Date.now() + 25 * 60_000;
    await api.notifications.quiet.set({ until, reason: 'Focus block' });
    let q = await api.notifications.quiet.get();
    expect(q).toMatchObject({ active: true, allowPermissions: true });
    expect(q.holds).toEqual([expect.objectContaining({ source: 'plugin:walnut-rhythm', until, reason: 'Focus block' })]);

    await context.dispose();
    q = await getQuiet();
    expect(q.active).toBe(false);
  });

  it('clear() removes only this plugin\'s hold', async () => {
    const a = pluginApi('walnut-rhythm').api;
    const b = pluginApi('other').api;
    await a.notifications.quiet.set({ allowPermissions: false });
    await b.notifications.quiet.set();
    await a.notifications.quiet.clear();
    const q = await getQuiet();
    expect(q.holds.map(h => h.source)).toEqual(['plugin:other']);
    expect(q.allowPermissions).toBe(true);
  });

  it('a replaced generation disposing late does not clear its successor\'s hold', async () => {
    const old = pluginApi('walnut-rhythm');
    await old.api.notifications.quiet.set({ reason: 'old' });
    const next = pluginApi('walnut-rhythm');
    await next.api.notifications.quiet.set({ reason: 'new' });
    await old.context.dispose();
    const q = await getQuiet();
    expect(q.holds).toEqual([expect.objectContaining({ source: 'plugin:walnut-rhythm', reason: 'new' })]);
  });
});
