/**
 * Plugin status items (walnut.ui.statusItem), graded through the REAL server plugin api
 * and plugin context, because the contract is about where the plugin seam meets the host:
 *   - `set` validates, stamps the plugin's identity, prefixes each button's op with the
 *     plugin's own namespace, and broadcasts the WHOLE list on `plugin:status-items`;
 *   - an unchanged `set` broadcasts nothing (Rhythm calls it on every step);
 *   - `clear`, the handle's `dispose` and disposing the plugin all remove the item and
 *     broadcast the shorter list;
 *   - a replaced generation disposing late does NOT remove its successor's item;
 *   - limits: id shape, two items per plugin, three actions, one primary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('plugin-status-items-test'));
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
  _resetStatusItemsForTesting, listStatusItems, normalizeStatusItemState, STATUS_ITEMS_EVENT,
} from '../../../src/core/plugins/plugin-status-items.js';
import { createTestPluginApi } from '../plugin-test-utils.js';

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => logger),
};

const contexts: PluginContext[] = [];
const broadcasts: Array<{ items: Array<Record<string, unknown>> }> = [];
const destinations: string[][] = [];

function pluginApi(pluginId: string, pluginName = pluginId) {
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger });
  contexts.push(context);
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginName });
  const api = createServerPluginApi({
    context, pluginName, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry(),
  });
  return { api, context };
}

const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);

beforeEach(() => {
  _resetStatusItemsForTesting();
  broadcasts.length = 0;
  destinations.length = 0;
  bus.subscribe('status-items-observer', (event) => {
    if (event.name !== STATUS_ITEMS_EVENT) return;
    destinations.push(event.destinations);
    broadcasts.push(event.data as { items: Array<Record<string, unknown>> });
  }, { global: true, interest: ['plugin:'] });
});

afterEach(async () => {
  bus.unsubscribe('status-items-observer');
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined);
  _resetStatusItemsForTesting();
});

describe('set', () => {
  it('stamps identity, binds buttons to the plugin\'s own ops and broadcasts the whole list', () => {
    const { api } = pluginApi('walnut-rhythm', 'Rhythm');
    const item = api.ui.statusItem({ id: 'rhythm' });
    item.set({
      title: 'Stand up in {remaining}',
      detail: '48 min at the keyboard.',
      timer: { startedAt: T0, endsAt: T0 + 60 * 60_000, mode: 'fill' },
      actions: [
        { label: 'Stand up now', op: 'break_done', primary: true },
        { label: 'Snooze 10 min', op: 'break_snooze', args: { minutes: 10 } },
      ],
      app: 'main',
    });
    const [only] = listStatusItems();
    expect(only).toMatchObject({
      key: 'walnut-rhythm:rhythm', pluginId: 'walnut-rhythm', pluginName: 'Rhythm', id: 'rhythm', order: 500,
      title: 'Stand up in {remaining}', tone: 'neutral',
      timer: { startedAt: T0, endsAt: T0 + 60 * 60_000, mode: 'fill' },
      app: 'main',
      actions: [
        { kind: 'op', label: 'Stand up now', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_done', primary: true },
        { kind: 'op', label: 'Snooze 10 min', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_snooze', args: { minutes: 10 } },
      ],
    });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.items).toEqual(listStatusItems());
    expect(destinations).toEqual([['web-ui']]);
  });

  it('an unchanged set broadcasts nothing; a changed one broadcasts once', () => {
    const { api } = pluginApi('probe');
    const item = api.ui.statusItem({ id: 'one' });
    item.set({ title: 'Focus', tone: 'accent' });
    item.set({ title: 'Focus', tone: 'accent' });
    expect(broadcasts).toHaveLength(1);
    item.set({ title: 'Focus', tone: 'success' });
    expect(broadcasts).toHaveLength(2);
    expect(listStatusItems()[0]).toMatchObject({ tone: 'success' });
  });

  it('a button cannot name another plugin\'s op: the host prefix always wins', () => {
    const { api } = pluginApi('probe');
    api.ui.statusItem({ id: 'one' }).set({ title: 'x', actions: [{ label: 'Go', op: 'other_plugin_delete_everything' }] });
    expect(listStatusItems()[0]!.actions[0]).toMatchObject({ pluginId: 'probe', op: 'probe_other_plugin_delete_everything' });
  });

  it('orders items across plugins by order, then plugin name', () => {
    pluginApi('zeta', 'Zeta').api.ui.statusItem({ id: 'a' }).set({ title: 'z' });
    pluginApi('alpha', 'Alpha').api.ui.statusItem({ id: 'a' }).set({ title: 'a' });
    pluginApi('mid', 'Mid').api.ui.statusItem({ id: 'a', order: 100 }).set({ title: 'm' });
    expect(listStatusItems().map((one) => one.pluginId)).toEqual(['mid', 'alpha', 'zeta']);
  });
});

describe('removal', () => {
  it('clear hides the item until the next set', () => {
    const { api } = pluginApi('probe');
    const item = api.ui.statusItem({ id: 'one' });
    item.set({ title: 'x' });
    item.clear();
    expect(listStatusItems()).toEqual([]);
    expect(broadcasts.at(-1)!.items).toEqual([]);
    item.set({ title: 'back' });
    expect(listStatusItems()).toHaveLength(1);
  });

  it('disposing the plugin removes its items and broadcasts, and the handle then refuses', async () => {
    const { api, context } = pluginApi('probe');
    const item = api.ui.statusItem({ id: 'one' });
    item.set({ title: 'x' });
    pluginApi('other').api.ui.statusItem({ id: 'keep' }).set({ title: 'stays' });
    await context.dispose();
    expect(listStatusItems().map((one) => one.key)).toEqual(['other:keep']);
    expect(broadcasts.at(-1)!.items.map((one) => one.key)).toEqual(['other:keep']);
    expect(() => item.set({ title: 'late' })).toThrow();
    expect(() => api.ui.statusItem({ id: 'two' })).toThrow();
  });

  it('a replaced generation disposing late leaves its successor\'s item alone', async () => {
    const old = pluginApi('probe');
    old.api.ui.statusItem({ id: 'one' }).set({ title: 'old' });
    const fresh = pluginApi('probe');
    fresh.api.ui.statusItem({ id: 'one' }).set({ title: 'new' });
    await old.context.dispose();
    expect(listStatusItems()).toEqual([expect.objectContaining({ key: 'probe:one', title: 'new' })]);
  });

  it('the handle\'s own dispose frees its id for a new registration', () => {
    const { api } = pluginApi('probe');
    const item = api.ui.statusItem({ id: 'one' });
    item.set({ title: 'x' });
    item.dispose();
    expect(listStatusItems()).toEqual([]);
    api.ui.statusItem({ id: 'one' }).set({ title: 'again' });
    expect(listStatusItems()).toHaveLength(1);
  });
});

describe('limits', () => {
  it('refuses a bad id, a duplicate id and a third item', () => {
    const { api } = pluginApi('probe');
    expect(() => api.ui.statusItem({ id: 'Has Space' })).toThrow(/id/);
    api.ui.statusItem({ id: 'one' });
    expect(() => api.ui.statusItem({ id: 'one' })).toThrow(/already registered/);
    api.ui.statusItem({ id: 'two' });
    expect(() => api.ui.statusItem({ id: 'three' })).toThrow(/at most 2/);
  });

  it.each([
    ['an empty title', { title: '  ' }, /title/],
    ['a long title', { title: 'x'.repeat(81) }, /title/],
    ['an unknown tone', { title: 'x', tone: 'loud' }, /tone/],
    ['a timer in seconds', { title: 'x', timer: { startedAt: 1_790_000_000, endsAt: 1_790_000_600 } }, /epoch milliseconds/],
    ['a timer that ends before it starts', { title: 'x', timer: { startedAt: T0, endsAt: T0 } }, /after/],
    ['an unknown glyph', { title: 'x', glyph: 'rocket' }, /glyph/],
    ['four actions', { title: 'x', actions: [1, 2, 3, 4].map((n) => ({ label: `a${n}`, op: 'go' })) }, /at most 3/],
    ['two primaries', { title: 'x', actions: [{ label: 'a', op: 'a', primary: true }, { label: 'b', op: 'b', primary: true }] }, /primary/],
    ['an op name with a space', { title: 'x', actions: [{ label: 'a', op: 'no good' }] }, /op name/],
    ['args that are not an object', { title: 'x', actions: [{ label: 'a', op: 'a', args: [1] }] }, /args/],
  ])('refuses %s', (_name, state, message) => {
    expect(() => normalizeStatusItemState('probe', state)).toThrow(message);
  });

  it('a refused set leaves the previous state showing', () => {
    const { api } = pluginApi('probe');
    const item = api.ui.statusItem({ id: 'one' });
    item.set({ title: 'good' });
    expect(() => item.set({ title: '' })).toThrow();
    expect(listStatusItems()[0]).toMatchObject({ title: 'good' });
  });
});
