/**
 * Unit tests for IntegrationRegistry (src/core/integration-registry.ts).
 * Section A1 from PLUGIN_TEST_PLAN.md.
 *
 * Tests:
 * - A1.1: register and retrieve plugin
 * - A1.2: duplicate registration throws
 * - A1.3: getAll returns all registered plugins
 * - A1.4: has returns false for unregistered plugin
 * - A1.5: getForCategory returns highest priority claim match
 * - A1.6: getForCategory falls back to lower priority
 * - A1.7: getForCategory falls back to local
 * - A1.8: getForCategory handles async claim functions
 * - A1.9: getForCategory throws when no fallback
 * - A1.10: clear removes all plugins
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import type { RegisteredPlugin } from '../../src/core/integration-types.js';
import { createMockPlugin } from './plugin-test-utils.js';

// ── Helpers ──

function makePlugin(overrides: Partial<RegisteredPlugin> & { id: string }): RegisteredPlugin {
  return createMockPlugin(overrides);
}

// ── Tests ──

describe('IntegrationRegistry', () => {
  let registry: IntegrationRegistry;

  beforeEach(() => {
    registry = new IntegrationRegistry();
  });

  describe('register / get / has', () => {
    it('registers a plugin and retrieves it by ID', () => {
      const plugin = makePlugin({ id: 'test-plugin' });
      registry.register('test-plugin', plugin);

      expect(registry.has('test-plugin')).toBe(true);
      expect(registry.get('test-plugin')).toBe(plugin);
    });

    it('returns undefined for unknown plugin ID', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
      expect(registry.has('nonexistent')).toBe(false);
    });

    it('throws on duplicate plugin ID', () => {
      const plugin = makePlugin({ id: 'dup' });
      registry.register('dup', plugin);

      expect(() => registry.register('dup', makePlugin({ id: 'dup' }))).toThrowError(
        'Plugin "dup" is already registered.',
      );
    });
  });

  describe('getAll', () => {
    it('returns empty array when no plugins registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('returns all registered plugins', () => {
      registry.register('a', makePlugin({ id: 'a' }));
      registry.register('b', makePlugin({ id: 'b' }));
      registry.register('c', makePlugin({ id: 'c' }));

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all.map(p => p.id).sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('clear', () => {
    it('removes all plugins except local fallback', () => {
      registry.register('a', makePlugin({ id: 'a' }));
      registry.register('b', makePlugin({ id: 'b' }));
      expect(registry.getAll()).toHaveLength(2);

      registry.clear();
      // clear() re-registers the local fallback automatically
      expect(registry.getAll()).toHaveLength(1);
      expect(registry.has('local')).toBe(true);
      expect(registry.has('a')).toBe(false);
    });

    it('allows re-registration after clear', () => {
      registry.register('a', makePlugin({ id: 'a' }));
      registry.clear();
      registry.register('a', makePlugin({ id: 'a' }));
      expect(registry.has('a')).toBe(true);
    });
  });

  describe('getForCategory', () => {
    it('returns highest-priority claiming plugin', async () => {
      const local = makePlugin({
        id: 'local',
        claim: { fn: () => true, priority: -1 },
      });
      const msTodo = makePlugin({
        id: 'ms-todo',
        claim: { fn: () => true, priority: 0 },
      });
      const pluginA = makePlugin({
        id: 'plugin-a',
        claim: { fn: (cat) => cat === 'Work', priority: 10 },
      });

      registry.register('local', local);
      registry.register('ms-todo', msTodo);
      registry.register('plugin-a', pluginA);

      // 'Work' category: plugin-a claims with priority 10
      const result = await registry.getForCategory('Work');
      expect(result.id).toBe('plugin-a');
    });

    it('falls to lower priority when higher does not claim', async () => {
      const local = makePlugin({
        id: 'local',
        claim: { fn: () => true, priority: -1 },
      });
      const msTodo = makePlugin({
        id: 'ms-todo',
        claim: { fn: () => true, priority: 0 },
      });
      const pluginA = makePlugin({
        id: 'plugin-a',
        claim: { fn: (cat) => cat === 'Work', priority: 10 },
      });

      registry.register('local', local);
      registry.register('ms-todo', msTodo);
      registry.register('plugin-a', pluginA);

      // 'Life' category: plugin-a declines, ms-todo claims at priority 0
      const result = await registry.getForCategory('Life');
      expect(result.id).toBe('ms-todo');
    });

    it('falls back to local plugin when no one else claims', async () => {
      const local = makePlugin({
        id: 'local',
        claim: { fn: () => true, priority: -1 },
      });
      const selective = makePlugin({
        id: 'selective',
        claim: { fn: () => false, priority: 10 },
      });

      registry.register('local', local);
      registry.register('selective', selective);

      const result = await registry.getForCategory('Anything');
      expect(result.id).toBe('local');
    });

    it('supports async claim functions', async () => {
      const asyncPlugin = makePlugin({
        id: 'async-plugin',
        claim: {
          fn: async (cat) => {
            await new Promise(r => setTimeout(r, 1));
            return cat === 'Async';
          },
          priority: 5,
        },
      });
      const local = makePlugin({
        id: 'local',
        claim: { fn: () => true, priority: -1 },
      });

      registry.register('async-plugin', asyncPlugin);
      registry.register('local', local);

      const result = await registry.getForCategory('Async');
      expect(result.id).toBe('async-plugin');
    });

    it('skips plugins without a claim', async () => {
      // Plugin with no claim should not be returned
      const noClaim = makePlugin({ id: 'no-claim' });
      const local = makePlugin({
        id: 'local',
        claim: { fn: () => true, priority: -1 },
      });

      registry.register('no-claim', noClaim);
      registry.register('local', local);

      const result = await registry.getForCategory('Test');
      expect(result.id).toBe('local');
    });

    it('throws when no plugin claims and no local fallback', async () => {
      const plugin = makePlugin({
        id: 'selective',
        claim: { fn: () => false, priority: 0 },
      });
      registry.register('selective', plugin);

      await expect(registry.getForCategory('Orphan')).rejects.toThrowError(
        'No plugin registered for category and no local fallback found.',
      );
    });
  });
});
