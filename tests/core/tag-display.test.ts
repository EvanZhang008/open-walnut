/**
 * The server's tag display rules (src/core/tag-display.ts): plugin defaults held in memory
 * while the plugin runs, the user's rules in config, and one event for a change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { stored: {} as Record<string, unknown> };
  const updateConfig = vi.fn(async (patch: Record<string, unknown>) => { state.stored = { ...state.stored, ...patch }; });
  return { state, updateConfig };
});
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ ...mocks.state.stored }),
  updateConfig: mocks.updateConfig,
}));
const { updateConfig } = mocks;

import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  _resetTagDisplayForTesting,
  listTagDisplayRules,
  setPluginTagDisplay,
  setUserTagDisplay,
} from '../../src/core/tag-display.js';

const announced: string[] = [];

beforeEach(() => {
  mocks.state.stored = {};
  updateConfig.mockClear();
  announced.length = 0;
  _resetTagDisplayForTesting();
  // The event goes to the web console; this subscriber stands in for it.
  bus.subscribe('web-ui', (event) => { if (event.name === EventNames.TASK_TAG_DISPLAY_CHANGED) announced.push(event.source); });
});
afterEach(() => { bus.unsubscribe('web-ui'); });

describe('plugin defaults', () => {
  it('lists a plugin default with its plugin while it is set, and takes it back on release', async () => {
    const release = setPluginTagDisplay('ticket-runs', 'ticket-id:*', 'hidden', 'Ticket Runs');
    expect(await listTagDisplayRules()).toContainEqual({ pattern: 'ticket-id:*', display: 'hidden', source: 'plugin', pluginId: 'ticket-runs', pluginName: 'Ticket Runs' });
    expect(announced).toEqual(['plugin/ticket-runs']);
    release();
    release();
    expect((await listTagDisplayRules()).some((rule) => rule.source === 'plugin')).toBe(false);
    expect(announced).toEqual(['plugin/ticket-runs', 'plugin/ticket-runs']);
  });

  it('lets a later call for the same pattern own it: releasing the earlier one changes nothing', async () => {
    const first = setPluginTagDisplay('ticket-runs', 'severity:*', 'hidden');
    const second = setPluginTagDisplay('ticket-runs', 'severity:*', 'shown');
    first();
    expect(await listTagDisplayRules()).toContainEqual(expect.objectContaining({ pattern: 'severity:*', display: 'shown', pluginId: 'ticket-runs' }));
    second();
    expect((await listTagDisplayRules()).some((rule) => rule.pluginId === 'ticket-runs')).toBe(false);
  });

  it('announces only a real change', () => {
    setPluginTagDisplay('ticket-runs', 'ticket-id:*', 'hidden');
    setPluginTagDisplay('ticket-runs', 'ticket-id:*', 'hidden');
    expect(announced).toEqual(['plugin/ticket-runs']);
  });

  it('refuses a pattern that is not one, and a machine tag', () => {
    expect(() => setPluginTagDisplay('ticket-runs', 'a:b:*', 'hidden')).toThrow(/names one tag/);
    expect(() => setPluginTagDisplay('ticket-runs', 'walnut:*', 'shown')).toThrow(/never show as tags/);
    expect(() => setPluginTagDisplay('ticket-runs', 'urgent', 'maybe')).toThrow(/display must be/);
    expect(announced).toEqual([]);
  });
});

describe('user rules', () => {
  it('stores the user\'s rule in config, lists it before plugin defaults, and removes it with null', async () => {
    setPluginTagDisplay('ticket-runs', 'severity:*', 'hidden');
    const rules = await setUserTagDisplay(' severity:* ', 'shown');
    expect(mocks.state.stored.tag_display).toEqual({ 'severity:*': 'shown' });
    const kinds = rules.map((rule) => `${rule.source}:${rule.pattern}:${rule.display}`);
    expect(kinds).toEqual([
      'builtin:walnut:*:hidden', 'user:severity:*:shown', 'plugin:severity:*:hidden',
      'default:label:*:value', 'default:created:*:hidden', 'default:updated:*:hidden',
    ]);
    expect(announced).toEqual(['plugin/ticket-runs', 'user']);

    await setUserTagDisplay('severity:*', 'shown');
    expect(updateConfig).toHaveBeenCalledTimes(1);

    const after = await setUserTagDisplay('severity:*', null);
    expect(mocks.state.stored.tag_display).toEqual({});
    expect(after.some((rule) => rule.source === 'user')).toBe(false);
    expect(announced).toEqual(['plugin/ticket-runs', 'user', 'user']);
  });

  it('keeps only well-formed stored rules and writes them back one at a time', async () => {
    mocks.state.stored = { tag_display: { 'walnut:*': 'shown', 'a:b:*': 'hidden', 'label:urgent': 'hidden', later: 'nope' } };
    expect((await listTagDisplayRules()).filter((rule) => rule.source === 'user')).toEqual([{ pattern: 'label:urgent', display: 'hidden', source: 'user' }]);
    await Promise.all([setUserTagDisplay('label:one', 'hidden'), setUserTagDisplay('two', 'value')]);
    // A plain word names the label it is stored as.
    expect(mocks.state.stored.tag_display).toEqual({ 'label:urgent': 'hidden', 'label:one': 'hidden', 'label:two': 'value' });
    expect(() => setUserTagDisplay('walnut:*', 'shown')).toThrow(/never show as tags/);
  });

  it('takes value as a display, for the user and for a plugin', async () => {
    setPluginTagDisplay('ticket-runs', 'ticket:*', 'value');
    expect(await listTagDisplayRules()).toContainEqual(expect.objectContaining({ pattern: 'ticket:*', display: 'value', source: 'plugin' }));
    await setUserTagDisplay('ticket:*', 'shown');
    expect(mocks.state.stored.tag_display).toEqual({ 'ticket:*': 'shown' });
    expect(() => setUserTagDisplay('ticket:*', 'maybe')).toThrow(/"shown", "value" or "hidden"/);
  });
});
