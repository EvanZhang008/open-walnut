/**
 * Integration Plugin Registry — singleton that stores all registered plugins.
 * Core code accesses integrations exclusively through this registry.
 */

import type { RegisteredPlugin, ProjectClaimFn, IntegrationSync } from './integration-types.js';

export type PluginTombstoneReason = 'disabled' | 'unloaded' | 'failed' | 'stale-code';

export interface PluginTombstone {
  id: string;
  name: string;
  version?: string;
  capabilities?: string[];
  reason: PluginTombstoneReason;
  at: string;
}

/** No-op sync used by the local fallback plugin. */
const noopLocalSync: IntegrationSync = {
  createTask: async () => null,
  deleteTask: async () => {},
  updateTitle: async () => {},
  updateDescription: async () => {},
  updateSummary: async () => {},
  updateNote: async () => {},
  updateConversationLog: async () => {},
  updatePriority: async () => {},
  updatePhase: async () => {},
  updateDueDate: async () => {},
  updateProject: async () => {},
  updateDependencies: async () => {},
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
  syncPoll: async () => {},
};

class IntegrationRegistry {
  private plugins = new Map<string, RegisteredPlugin>();
  private tombstones = new Map<string, PluginTombstone>();

  /** Register a plugin. Throws if duplicate ID. */
  register(id: string, plugin: RegisteredPlugin): void {
    if (this.plugins.has(id)) {
      throw new Error(`Plugin "${id}" is already registered.`);
    }
    this.plugins.set(id, plugin);
    this.tombstones.delete(id);
  }

  /** Replace an active plugin or revive a tombstoned one without changing order. */
  replace(id: string, plugin: RegisteredPlugin): void {
    this.plugins.set(id, plugin);
    this.tombstones.delete(id);
  }

  /** Remove live behavior while retaining source metadata for historical tasks. */
  unregister(id: string, reason: PluginTombstoneReason = 'unloaded'): PluginTombstone | undefined {
    if (id === 'local') throw new Error('The local fallback plugin cannot be unregistered.');
    const plugin = this.plugins.get(id);
    if (!plugin) return this.tombstones.get(id);
    this.plugins.delete(id);
    const tombstone: PluginTombstone = {
      id,
      name: plugin.name,
      ...(plugin.version ? { version: plugin.version } : {}),
      ...(plugin.capabilities ? { capabilities: [...plugin.capabilities] } : {}),
      reason,
      at: new Date().toISOString(),
    };
    this.tombstones.set(id, tombstone);
    return tombstone;
  }

  getTombstone(id: string): PluginTombstone | undefined {
    const tombstone = this.tombstones.get(id);
    return tombstone ? { ...tombstone, capabilities: tombstone.capabilities ? [...tombstone.capabilities] : undefined } : undefined;
  }

  getTombstones(): PluginTombstone[] {
    return [...this.tombstones.values()].map((tombstone) => ({
      ...tombstone,
      capabilities: tombstone.capabilities ? [...tombstone.capabilities] : undefined,
    }));
  }

  isKnown(id: string): boolean {
    return this.plugins.has(id) || this.tombstones.has(id);
  }

  /** Get a plugin by ID. Returns undefined if not found. */
  get(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Get all registered plugins. */
  getAll(): RegisteredPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * Plugins that can back a task's `source` — i.e. the ones that actually sync.
   *
   * A deep-capability plugin (ui / tools / skills only) is registered like any
   * other but has no sync implementation, so filing a task against it would
   * accept the write and then push nowhere, forever. `hasSync === undefined` is
   * treated as syncing, so hand-built registrations (tests, the local fallback)
   * behave exactly as before.
   */
  getSyncPlugins(): RegisteredPlugin[] {
    return [...this.plugins.values()].filter(p => p.hasSync !== false);
  }

  /** True when `id` names a plugin a task may be sourced from (see getSyncPlugins). */
  isTaskSource(id: string): boolean {
    const plugin = this.plugins.get(id);
    return !!plugin && plugin.hasSync !== false;
  }

  /** Check if a plugin is registered. */
  has(id: string): boolean {
    return this.plugins.has(id);
  }

  /**
   * Find the plugin that claims ownership of a project.
   * Iterates claims by priority (highest first). First match wins.
   * Always returns something — 'local' plugin is the universal fallback (priority -1).
   *
   * Inbox (the empty project) is structurally unclaimable, so callers never ask
   * about it — it is always 'local'.
   */
  async getForProject(project: string): Promise<RegisteredPlugin> {
    // Collect plugins with claims, sort by priority descending
    const claimable = [...this.plugins.values()]
      .filter(p => p.claim)
      .sort((a, b) => (b.claim!.priority) - (a.claim!.priority));

    for (const plugin of claimable) {
      const claimed = await plugin.claim!.fn(project);
      if (claimed) return plugin;
    }

    // Should never reach here if 'local' is registered with priority -1,
    // but guard anyway
    const local = this.plugins.get('local');
    if (local) return local;

    throw new Error('No plugin registered for project and no local fallback found.');
  }

  /** Remove all plugins (useful for testing). Re-registers the local fallback. */
  clear(): void {
    this.plugins.clear();
    this.tombstones.clear();
    this.ensureLocalFallback();
  }

  /** Ensure the local fallback plugin is registered. Called at init and after clear(). */
  ensureLocalFallback(): void {
    if (this.plugins.has('local')) return;
    this.plugins.set('local', {
      id: 'local',
      name: 'Local (fallback)',
      config: {},
      sync: noopLocalSync,
      hasSync: true,
      capabilities: ['sync'],
      claim: { fn: (() => true) as ProjectClaimFn, priority: -1 },
      migrations: [],
      httpRoutes: [],
    });
  }
}

/** Singleton registry instance. */
export const registry = new IntegrationRegistry();
export { IntegrationRegistry };

// Auto-register local fallback so getForProject() always works,
// even in tests that don't call loadPlugins().
registry.ensureLocalFallback();
