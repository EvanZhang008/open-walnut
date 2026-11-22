/**
 * The leader's session port: every member answers with today's module (session-port.ts).
 *
 * Each `loadX()` returns the module's own `import()` promise, unchanged: the classes imported
 * these modules lazily (to stay out of import cycles and off the startup path), and the
 * leader keeps that, so load order and the awaits a call takes are what they were. The two
 * bound members are the namespaces of the modules the classes imported statically
 * (session-tracker in AcpSession, the message queue in both), read at call time, so a test's
 * mock or spy on either module still sees every call.
 */
import * as sessionTracker from '../session-tracker.js';
import * as sessionMessageQueue from '../session-message-queue.js';
import type { SessionPort } from './session-port.js';

export const leaderSessionPort: SessionPort = {
  records: {
    tracker: sessionTracker,
    loadTracker: () => import('../session-tracker.js'),
  },
  tasks: {
    loadTaskManager: () => import('../task-manager.js'),
    loadPhase: () => import('../phase.js'),
  },
  config: {
    loadConfigManager: () => import('../config-manager.js'),
  },
  launch: {
    loadSessionContext: () => import('./session-context.js'),
    loadLaunchPlace: () => import('./launch-place.js'),
    loadTaskDirPlace: () => import('./task-dir-place.js'),
    loadOrgOwnFolder: () => import('./org-own-folder.js'),
    loadProfiles: () => import('./profiles.js'),
    loadWalnutMcpMount: () => import('./walnut-mcp-mount.js'),
    loadHostModelCatalog: () => import('../host-model-catalog.js'),
    loadRouterAreas: () => import('../router/areas.js'),
    loadFrequentDirs: () => import('../frequent-dirs.js'),
  },
  messages: {
    queue: sessionMessageQueue,
    loadMessageQueue: () => import('../session-message-queue.js'),
    loadHintSend: () => import('../hints/hint-send.js'),
  },
  recovery: {
    loadRecordRecovery: () => import('./session-record-recovery.js'),
    loadSessionStop: () => import('./session-stop.js'),
    loadFolderGone: () => import('./folder-gone.js'),
    loadPromptRefresh: () => import('./prompt-refresh.js'),
    loadTitleReconciler: () => import('../session-title-reconciler.js'),
    loadHookBuiltins: () => import('../session-hooks/builtins.js'),
  },
};
