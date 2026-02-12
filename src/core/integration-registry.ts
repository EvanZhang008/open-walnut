/**
 * Integration Plugin Registry — singleton that stores all registered plugins.
 * Core code accesses integrations exclusively through this registry.
 */

import type { RegisteredPlugin, CategoryClaimFn, IntegrationSync } from './integration-types.js';

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
  updateStar: async () => {},
  updateCategory: async () => {},
  updateDependencies: async () => {},
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  syncPoll: async () => {},
};

class IntegrationRegistry {
  private plugins = new Map<string, RegisteredPlugin>();

  /** Register a plugin. Throws if duplicate ID. */
  register(id: string, plugin: RegisteredPlugin): void {
    if (this.plugins.has(id)) {
      throw new Error(`Plugin "${id}" is already registered.`);
    }
    this.plugins.set(id, plugin);
  }

  /** Get a plugin by ID. Returns undefined if not found. */
  get(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  /** Get all registered plugins. */
  getAll(): RegisteredPlugin[] {
    return [...this.plugins.values()];
  }

  /** Check if a plugin is registered. */
  has(id: string): boolean {
    return this.plugins.has(id);
  }

  /**
   * Find the plugin that claims ownership of a category.
   * Iterates claims by priority (highest first). First match wins.
   * Always returns something — 'local' plugin is the universal fallback (priority -1).
   */
  async getForCategory(category: string): Promise<RegisteredPlugin> {
    // Collect plugins with claims, sort by priority descending
    const claimable = [...this.plugins.values()]
      .filter(p => p.claim)
      .sort((a, b) => (b.claim!.priority) - (a.claim!.priority));

    for (const plugin of claimable) {
      const claimed = await plugin.claim!.fn(category);
      if (claimed) return plugin;
    }

    // Should never reach here if 'local' is registered with priority -1,
    // but guard anyway
    const local = this.plugins.get('local');
    if (local) return local;

    throw new Error('No plugin registered for category and no local fallback found.');
  }

  /** Remove all plugins (useful for testing). Re-registers the local fallback. */
  clear(): void {
    this.plugins.clear();
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
      claim: { fn: (() => true) as CategoryClaimFn, priority: -1 },
      migrations: [],
      httpRoutes: [],
    });
  }
}

/** Singleton registry instance. */
export const registry = new IntegrationRegistry();
export { IntegrationRegistry };

// Auto-register local fallback so getForCategory() always works,
// even in tests that don't call loadPlugins().
registry.ensureLocalFallback();
