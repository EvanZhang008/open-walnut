/**
 * Local plugin — universal fallback for tasks with no external sync.
 * All IntegrationSync methods are no-ops.
 */

import type { PluginApi, IntegrationSync, PushResult } from '../../core/integration-types.js';
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js';

const noopSync: IntegrationSync = {
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
  pushTask: async (): Promise<PushResult> => ({ serverTimestamp: new Date().toISOString() }),
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  syncPoll: async () => {},
};

export async function activate(walnut: WalnutServerPluginApi): Promise<void> {
  walnut.registry.sync(noopSync);
  walnut.registry.sourceClaim(() => true, { priority: -1 });
  walnut.registry.display({
    badge: 'L',
    badgeColor: '#8E8E93',
    externalLinkLabel: 'Local',
    getExternalUrl: () => null,
    isSynced: () => false,
    syncTooltip: () => 'Local only — not synced to any external service',
  });
}

export default function register(api: PluginApi): void {
  api.registerSync(noopSync);

  api.registerSourceClaim(() => true, { priority: -1 });

  api.registerDisplay({
    badge: 'L',
    badgeColor: '#8E8E93',
    externalLinkLabel: 'Local',
    getExternalUrl: () => null,
    isSynced: () => false,
    syncTooltip: () => 'Local only — not synced to any external service',
  });
}
