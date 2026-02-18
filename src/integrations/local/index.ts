/**
 * Local plugin — universal fallback for tasks with no external sync.
 * All IntegrationSync methods are no-ops.
 */

import type { PluginApi, IntegrationSync } from '../../core/integration-types.js';

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
  updateStar: async () => {},
  updateCategory: async () => {},
  updateDependencies: async () => {},
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  syncPoll: async () => {},
};

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
