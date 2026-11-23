/**
 * The session port: the one way the session classes (ClaudeCodeSession, SessionRunner and
 * AcpSession, which also runs the Codex app-server engine) read and write the leader's data:
 * session records, tasks, config, the message queue, and the launch and recovery helpers that
 * exist to read or write that data for them.
 *
 * Today only the leader runs those classes, and `leaderSessionPort` (session-port-leader.ts)
 * answers every member with today's module. A host that runs them on its own server later
 * installs a port of its own (`installSessionPort`): the leader when it answers, else the
 * host's local copy and a journal.
 *
 * Shape. Each group names one purpose; each member is one leader module, typed as exactly the
 * functions the classes call (`Pick<typeof import(...)>`, so every signature is the module's own):
 *   - `loadX()` resolves the module the way the class's dynamic `import()` did. The leader returns
 *     that `import()` promise itself, so module load order, import cycles and the number of awaits
 *     are what they were.
 *   - a bare member (`records.tracker`, `messages.queue`) is bound now, for the calls a class made
 *     through a static import, synchronous ones included.
 *
 * The ratchet `tests/core/sessions/session-port-ratchet.test.ts` keeps the classes off these
 * modules and checks the leader port covers `SESSION_PORT_MEMBERS`.
 */
import { leaderSessionPort } from './session-port-leader.js';

type Tracker = typeof import('../session-tracker.js');
type TaskManager = typeof import('../task-manager.js');
type Phase = typeof import('../phase.js');
type ConfigManager = typeof import('../config-manager.js');
type MessageQueue = typeof import('../session-message-queue.js');

/** Session records (core/session-tracker.ts). */
export type SessionTrackerPort = Pick<Tracker,
  | 'acceptAcpPrompt'
  | 'createSessionRecord'
  | 'deleteSessionRecords'
  | 'emitSessionStatusChanged'
  | 'getAcpIdentityReplacementTarget'
  | 'getSessionByClaudeId'
  | 'listOrphanCandidates'
  | 'renameSessionId'
  | 'rollbackAcpSessionIdMigration'
  | 'stageAcpSessionIdMigration'
  | 'updateSessionRecord'
  | 'updateSessionRecordConditionally'
>;

/** Tasks and their session slots (core/task-manager.ts). */
export type TaskManagerPort = Pick<TaskManager,
  | 'addSessionToHistory'
  | 'clearSession'
  | 'clearSessionSlot'
  | 'getProjectMetadata'
  | 'getTask'
  | 'linkSession'
  | 'linkSessionSlot'
  | 'replaceSessionIdLinks'
  | 'touchLastSessionUpdate'
  | 'updateTask'
>;

/** A started session's link to its task (core/sessions/start-link.ts). */
export type StartLinkPort = Pick<typeof import('./start-link.js'), 'linkStartedSession' | 'linkAcpStartedSession'>;

/** A task's phase as its session moves it (core/phase.ts). */
export type PhasePort = Pick<Phase,
  | 'applySessionPhase'
  | 'isChatSendSource'
  | 'isPersonSendSource'
  | 'sendSourceReopensTerminal'
>;

/** The config file (core/config-manager.ts). */
export type ConfigManagerPort = Pick<ConfigManager, 'getConfig'>;

/** The per-session message queue (core/session-message-queue.ts). */
export type SessionQueuePort = Pick<MessageQueue,
  | 'START_RECOVERY_HELD_REASON'
  | 'enqueueMessage'
  | 'enqueueUntilStored'
  | 'getAllSessionsWithPending'
  | 'getQueue'
  | 'holdForStartRecovery'
  | 'loadQueue'
  | 'markNextProcessing'
  | 'markProcessing'
  | 'migrateSessionQueue'
  | 'parkIfQueued'
  | 'parkMessages'
  | 'parkStalePending'
  | 'removeProcessed'
  | 'removeStartRecoveryRows'
  | 'removeTaken'
  | 'requeueUnanswered'
  | 'revertIfQueued'
  | 'revertToPending'
  | 'rollbackSessionQueueMigration'
  | 'settleStartRecoveryHeld'
  | 'unmarkUnwritten'
  | 'unparkAgentWaitRows'
>;

/** The hints a start or a send carries (core/hints/hint-send.ts). */
export type HintSendPort = Pick<typeof import('../hints/hint-send.js'), 'prepareStartHints'>;

export type SessionContextPort = Pick<typeof import('./session-context.js'), 'buildSessionContext'>;
export type LaunchPlacePort = Pick<typeof import('./launch-place.js'),
  'defaultCwdOnHost' | 'recordedCwdOnHost' | 'unnamedStartPlace'>;
export type TaskDirPlacePort = Pick<typeof import('./task-dir-place.js'), 'localFallbackFolder' | 'restoreOwnTaskDir'>;
export type OrgOwnFolderPort = Pick<typeof import('./org-own-folder.js'), 'moveToOwnFolderBeforeSpawn'>;
export type ProfilesPort = Pick<typeof import('./profiles.js'), 'walnutMcpProfile'>;
export type WalnutMcpMountPort = Pick<typeof import('./walnut-mcp-mount.js'),
  'WALNUT_MCP_CAPABILITY' | 'liveWalnutMcpServers' | 'withWalnutMcpMount'>;
export type HostModelCatalogPort = Pick<typeof import('../host-model-catalog.js'),
  'getHostModelCatalog' | 'saveHostModelCatalog'>;
export type RouterAreasPort = Pick<typeof import('../router/areas.js'), 'readRouterAreas' | 'taskArea'>;
export type FrequentDirsPort = Pick<typeof import('../frequent-dirs.js'), 'recordDirectory'>;

// Its one rebuild function, named by leaving out the rest: the module's caller guard counts every
// mention of that name in code (tests/core/sessions/session-record-recovery-guard.test.ts).
export type RecordRecoveryPort = Omit<typeof import('./session-record-recovery.js'),
  'extractRecoveryEvidence' | '_resetSessionRecordRecoveryForTesting'>;
export type SessionStopPort = Pick<typeof import('./session-stop.js'), 'isSessionStopSuperseded' | 'sessionStops'>;
export type FolderGonePort = Pick<typeof import('./folder-gone.js'), 'clearFolderGone' | 'folderState' | 'noteFolderGone'>;
export type PromptRefreshPort = Pick<typeof import('./prompt-refresh.js'), 'freshResumePrompt' | 'missingResumePrompt'>;
export type TitleReconcilerPort = Pick<typeof import('../session-title-reconciler.js'), 'startSessionTitleReconciler'>;
export type HookBuiltinsPort = Pick<typeof import('../session-hooks/builtins.js'), 'autoTitleFromObservedMessage'>;

export interface SessionPort {
  /** Session records. */
  records: {
    /** Bound now (AcpSession's synchronous record calls). */
    tracker: SessionTrackerPort;
    loadTracker(): Promise<SessionTrackerPort>;
  };
  /** Tasks, their session slots and their phase. */
  tasks: {
    loadTaskManager(): Promise<TaskManagerPort>;
    loadPhase(): Promise<PhasePort>;
    /**
     * A started session's link to its task (start-link.ts). A host that runs its own sessions links
     * nothing: the leader links the session from its born row.
     */
    loadStartLink(): Promise<StartLinkPort>;
  };
  /** The user's config. */
  config: {
    loadConfigManager(): Promise<ConfigManagerPort>;
  };
  /** What a spawn or a resume reads to launch: prompt, place, folder, profile, MCP mount, models. */
  launch: {
    loadSessionContext(): Promise<SessionContextPort>;
    loadLaunchPlace(): Promise<LaunchPlacePort>;
    loadTaskDirPlace(): Promise<TaskDirPlacePort>;
    loadOrgOwnFolder(): Promise<OrgOwnFolderPort>;
    loadProfiles(): Promise<ProfilesPort>;
    loadWalnutMcpMount(): Promise<WalnutMcpMountPort>;
    loadHostModelCatalog(): Promise<HostModelCatalogPort>;
    loadRouterAreas(): Promise<RouterAreasPort>;
    loadFrequentDirs(): Promise<FrequentDirsPort>;
  };
  /** The lines waiting for a session, and the hints a send carries. */
  messages: {
    /** Bound now (the queue calls the classes make synchronously). */
    queue: SessionQueuePort;
    loadMessageQueue(): Promise<SessionQueuePort>;
    loadHintSend(): Promise<HintSendPort>;
  };
  /** Rebuilding, stopping and repairing a session's record and its place. */
  recovery: {
    loadRecordRecovery(): Promise<RecordRecoveryPort>;
    loadSessionStop(): Promise<SessionStopPort>;
    loadFolderGone(): Promise<FolderGonePort>;
    loadPromptRefresh(): Promise<PromptRefreshPort>;
    loadTitleReconciler(): Promise<TitleReconcilerPort>;
    loadHookBuiltins(): Promise<HookBuiltinsPort>;
  };
}

/** Every member of SessionPort as `group.member`; the ratchet checks each port against it. */
export const SESSION_PORT_MEMBERS = [
  'records.tracker', 'records.loadTracker',
  'tasks.loadTaskManager', 'tasks.loadPhase', 'tasks.loadStartLink',
  'config.loadConfigManager',
  'launch.loadSessionContext', 'launch.loadLaunchPlace', 'launch.loadTaskDirPlace', 'launch.loadOrgOwnFolder',
  'launch.loadProfiles', 'launch.loadWalnutMcpMount', 'launch.loadHostModelCatalog', 'launch.loadRouterAreas',
  'launch.loadFrequentDirs',
  'messages.queue', 'messages.loadMessageQueue', 'messages.loadHintSend',
  'recovery.loadRecordRecovery', 'recovery.loadSessionStop', 'recovery.loadFolderGone', 'recovery.loadPromptRefresh',
  'recovery.loadTitleReconciler', 'recovery.loadHookBuiltins',
] as const;

// The list above and the interface name the same members, or this does not compile.
type MemberPath = { [G in keyof SessionPort]: `${G}.${Extract<keyof SessionPort[G], string>}` }[keyof SessionPort];
type Listed = (typeof SESSION_PORT_MEMBERS)[number];
const membersMatch: [MemberPath] extends [Listed] ? ([Listed] extends [MemberPath] ? true : never) : never = true;
void membersMatch;

let installed: SessionPort | null = null;

/** The installed port; the leader's own modules unless one was installed. */
export function sessionPort(): SessionPort {
  return installed ?? leaderSessionPort;
}

/**
 * One function of a bound member, read from the installed port at every call. A class that
 * imported a module's functions statically binds the same names with this, so each call still
 * goes through `sessionPort()` while the call sites read as before.
 */
export function callThrough<T extends object, K extends keyof T>(member: () => T, name: K): T[K] {
  return ((...args: unknown[]) => (member()[name] as (...a: unknown[]) => unknown)(...args)) as T[K];
}

/** Install a port (tests, a host's own server); null restores the leader's. */
export function installSessionPort(port: SessionPort | null): void {
  installed = port;
}
